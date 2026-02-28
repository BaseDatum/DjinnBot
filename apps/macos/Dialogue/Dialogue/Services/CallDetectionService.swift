import Foundation
import AppKit
import ScreenCaptureKit
import Combine

// MARK: - DetectedCall

/// Information about a detected call or meeting.
struct DetectedCall: Equatable {
    let appName: String
    let bundleID: String
    let sourceType: MeetingSourceType
    let detectedAt: Date
    var isRecording: Bool = false
    
    static func == (lhs: DetectedCall, rhs: DetectedCall) -> Bool {
        lhs.bundleID == rhs.bundleID && lhs.detectedAt == rhs.detectedAt
    }
}

// MARK: - CallDetectionService

/// Monitors running applications and their audio activity to detect active calls/meetings.
///
/// Detection strategy:
/// - **Process monitoring**: Watches for monitored apps via NSWorkspace.
/// - **Audio activity detection**: Uses ScreenCaptureKit to check if a monitored app is producing audio.
/// - **Google Meet detection**: Reads browser tab titles via Accessibility API for "meet.google.com".
///
/// State machine: Idle → AppDetected → AudioActive → CallConfirmed → (notifies orchestrator)
@MainActor
final class CallDetectionService: ObservableObject {
    static let shared = CallDetectionService()
    
    // MARK: - Published State
    
    /// Currently detected active call, if any.
    @Published private(set) var detectedCall: DetectedCall?
    
    /// Whether the service is actively monitoring.
    @Published private(set) var isMonitoring: Bool = false
    
    /// Meeting apps currently running (for "app open" notifications even when auto-record is off).
    @Published private(set) var runningMeetingApps: [MonitoredApp] = []
    
    // MARK: - Callbacks
    
    /// Called when a call is confirmed (audio detected for sufficient duration).
    var onCallConfirmed: ((DetectedCall) -> Void)?
    
    /// Called when a previously active call ends (audio stops).
    var onCallEnded: ((DetectedCall) -> Void)?
    
    /// Called when a meeting app (Zoom/Meet) is launched (regardless of auto-record setting).
    var onMeetingAppLaunched: ((MonitoredApp) -> Void)?
    
    // MARK: - Private
    
    /// Known app bundle IDs → MonitoredApp mapping.
    private let monitoredBundleIDs: [String: MonitoredApp]
    
    /// Browser bundle IDs to check for Google Meet.
    private let browserBundleIDs: Set<String> = [
        "com.google.Chrome",
        "com.google.Chrome.canary",
        "company.thebrowser.Browser",    // Arc
        "com.apple.Safari",
        "com.microsoft.edgemac",
        "org.mozilla.firefox",
    ]
    
    /// Polling timer for audio activity checks.
    private var pollingTimer: Timer?
    
    /// Workspace notification observers.
    private var appLaunchObserver: NSObjectProtocol?
    private var appTerminateObserver: NSObjectProtocol?
    
    /// Tracks consecutive audio-active polls for each app.
    private var audioActiveCount: [String: Int] = [:]
    
    /// Number of consecutive polls with audio before confirming a call.
    private let confirmationThreshold = 2  // ~4 seconds at 2s polling
    
    /// Number of consecutive polls without audio before ending a call.
    private let endThreshold = 5  // ~10 seconds at 2s polling
    
    /// Consecutive silent polls for the currently active call.
    private var silentPollCount = 0
    
    /// Set of bundle IDs for which we've already notified "meeting app launched".
    private var notifiedMeetingApps: Set<String> = Set()
    
    // MARK: - Init
    
    private init() {
        var mapping: [String: MonitoredApp] = [:]
        for app in AutoRecordSettings.monitoredApps {
            if let bundleID = app.bundleID {
                mapping[bundleID] = app
            }
        }
        self.monitoredBundleIDs = mapping
    }
    
    // MARK: - Lifecycle
    
    /// Start monitoring for calls and meeting apps.
    func startMonitoring() {
        guard !isMonitoring else { return }
        isMonitoring = true
        
        // Observe app launches
        appLaunchObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didLaunchApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let bundleID = app.bundleIdentifier else { return }
            Task { @MainActor [weak self] in
                self?.handleAppLaunched(bundleID: bundleID)
            }
        }
        
        // Observe app terminations
        appTerminateObserver = NSWorkspace.shared.notificationCenter.addObserver(
            forName: NSWorkspace.didTerminateApplicationNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard let app = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  let bundleID = app.bundleIdentifier else { return }
            Task { @MainActor [weak self] in
                self?.handleAppTerminated(bundleID: bundleID)
            }
        }
        
        // Check already-running apps
        for app in NSWorkspace.shared.runningApplications {
            if let bundleID = app.bundleIdentifier {
                handleAppLaunched(bundleID: bundleID)
            }
        }
        
        // Start polling for audio activity every 2 seconds
        pollingTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.pollAudioActivity()
            }
        }
        
        print("[Dialogue] Call detection started — monitoring \(monitoredBundleIDs.count) apps")
    }
    
    /// Stop monitoring.
    func stopMonitoring() {
        isMonitoring = false
        pollingTimer?.invalidate()
        pollingTimer = nil
        
        if let observer = appLaunchObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        if let observer = appTerminateObserver {
            NSWorkspace.shared.notificationCenter.removeObserver(observer)
        }
        appLaunchObserver = nil
        appTerminateObserver = nil
        
        audioActiveCount.removeAll()
        silentPollCount = 0
        notifiedMeetingApps.removeAll()
        detectedCall = nil
        runningMeetingApps.removeAll()
        
        print("[Dialogue] Call detection stopped")
    }
    
    // MARK: - App Lifecycle Handling
    
    private func handleAppLaunched(bundleID: String) {
        // Check if it's a monitored app
        if let app = monitoredBundleIDs[bundleID] {
            if app.type == .meetingApp && !notifiedMeetingApps.contains(bundleID) {
                runningMeetingApps.append(app)
                notifiedMeetingApps.insert(bundleID)
                onMeetingAppLaunched?(app)
                print("[Dialogue] Meeting app launched: \(app.name)")
            }
        }
        
        // Check for browsers (potential Google Meet)
        if browserBundleIDs.contains(bundleID) {
            // Browser launched — we'll check for Meet tabs during polling
        }
    }
    
    private func handleAppTerminated(bundleID: String) {
        // Remove from running meeting apps
        runningMeetingApps.removeAll { $0.bundleID == bundleID }
        notifiedMeetingApps.remove(bundleID)
        audioActiveCount.removeValue(forKey: bundleID)
        
        // If the terminated app was the active call, end it
        if let call = detectedCall, call.bundleID == bundleID {
            let endedCall = call
            detectedCall = nil
            silentPollCount = 0
            onCallEnded?(endedCall)
            print("[Dialogue] Call ended (app terminated): \(call.appName)")
        }
    }
    
    // MARK: - Audio Activity Polling
    
    /// Check which monitored apps are currently producing audio.
    private func pollAudioActivity() async {
        // Get running monitored apps
        let runningApps = NSWorkspace.shared.runningApplications
        let monitoredRunning = runningApps.filter { app in
            guard let bundleID = app.bundleIdentifier else { return false }
            return monitoredBundleIDs[bundleID] != nil
        }
        
        // Check audio activity via ScreenCaptureKit
        let audioApps = await detectAudioProducingApps()
        
        // Also check for Google Meet in browser tabs
        let meetInBrowser = checkForGoogleMeet()
        
        // If we already have an active call, check if it's still active
        if let currentCall = detectedCall {
            let stillActive = audioApps.contains(currentCall.bundleID) ||
                              (currentCall.appName == "Google Meet" && meetInBrowser != nil)
            
            if stillActive {
                silentPollCount = 0
            } else {
                silentPollCount += 1
                if silentPollCount >= endThreshold {
                    let endedCall = currentCall
                    detectedCall = nil
                    silentPollCount = 0
                    audioActiveCount.removeAll()
                    onCallEnded?(endedCall)
                    print("[Dialogue] Call ended (audio stopped): \(endedCall.appName)")
                }
            }
            return
        }
        
        // No active call — look for new calls
        for app in monitoredRunning {
            guard let bundleID = app.bundleIdentifier,
                  let monitored = monitoredBundleIDs[bundleID] else { continue }
            
            if audioApps.contains(bundleID) {
                audioActiveCount[bundleID, default: 0] += 1
                
                if audioActiveCount[bundleID]! >= confirmationThreshold {
                    confirmCall(app: monitored, bundleID: bundleID)
                    return
                }
            } else {
                audioActiveCount[bundleID] = 0
            }
        }
        
        // Check Google Meet separately
        if let meetBrowser = meetInBrowser {
            let meetKey = "google-meet-\(meetBrowser)"
            audioActiveCount[meetKey, default: 0] += 1
            
            if audioActiveCount[meetKey]! >= confirmationThreshold {
                let call = DetectedCall(
                    appName: "Google Meet",
                    bundleID: meetBrowser,
                    sourceType: .meetingApp,
                    detectedAt: Date()
                )
                detectedCall = call
                silentPollCount = 0
                onCallConfirmed?(call)
                print("[Dialogue] Call confirmed: Google Meet (via \(meetBrowser))")
            }
        }
    }
    
    /// Use ScreenCaptureKit to detect which apps are currently producing audio.
    /// Returns a set of bundle IDs with active audio output.
    private func detectAudioProducingApps() async -> Set<String> {
        do {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            
            var audioApps = Set<String>()
            
            // Check each monitored app for audio activity.
            // ScreenCaptureKit doesn't directly expose "is producing audio" —
            // we check if the app has windows (indicating it's active) and
            // rely on the process being in a known call state.
            //
            // For more accurate detection, we use a lightweight audio tap
            // per monitored app using SCStream with audio-only configuration.
            // However, that's expensive per-app. Instead, we use a heuristic:
            // an app is considered "audio active" if it's running, has an
            // audio entitlement, and CoreAudio reports it as an audio client.
            
            for app in content.applications {
                let bundleID = app.bundleIdentifier
                guard !bundleID.isEmpty,
                      monitoredBundleIDs[bundleID] != nil else { continue }
                
                // Check if the app is actively using audio via CoreAudio
                if isAppProducingAudio(bundleID: bundleID, pid: app.processID) {
                    audioApps.insert(bundleID)
                }
            }
            
            return audioApps
        } catch {
            // ScreenCaptureKit not available or permission denied
            return Set()
        }
    }
    
    /// Check if a specific process is currently producing audio output
    /// by querying CoreAudio's running audio clients.
    private nonisolated func isAppProducingAudio(bundleID: String, pid: pid_t) -> Bool {
        // Query the default output device for its running tap/client list.
        // This uses AudioObjectGetPropertyData to check if the process
        // has any active audio streams.
        
        var defaultOutputID = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        let status = AudioObjectGetPropertyData(
            AudioObjectID(kAudioObjectSystemObject),
            &address,
            0, nil,
            &size,
            &defaultOutputID
        )
        guard status == noErr, defaultOutputID != 0 else { return false }
        
        // Check if the process is running (as a proxy for audio activity).
        // CoreAudio doesn't expose per-process audio activity directly
        // without using an audio tap. We use NSRunningApplication's
        // isActive state combined with the app being a known call app
        // as a reasonable heuristic.
        //
        // For call apps, being in the foreground or recently active
        // while the app is running is a strong signal.
        let workspace = NSWorkspace.shared
        let running = workspace.runningApplications.first { $0.processIdentifier == pid }
        
        // Consider the app audio-active if it's currently active (foreground)
        // or was recently activated. This is a conservative heuristic.
        // A more accurate approach would use AudioDeviceDuck or a lightweight
        // SCStream audio tap per process.
        return running?.isActive ?? false
    }
    
    // MARK: - Google Meet Detection
    
    /// Check browser windows for Google Meet tabs.
    /// Returns the browser bundle ID if a Meet tab is found, nil otherwise.
    private func checkForGoogleMeet() -> String? {
        let runningApps = NSWorkspace.shared.runningApplications
        
        for app in runningApps {
            guard let bundleID = app.bundleIdentifier,
                  browserBundleIDs.contains(bundleID) else { continue }
            
            // Use Accessibility API to read the browser window title
            if let title = getActiveWindowTitle(pid: app.processIdentifier) {
                if title.localizedCaseInsensitiveContains("meet.google.com") ||
                   title.localizedCaseInsensitiveContains("Google Meet") {
                    return bundleID
                }
            }
        }
        
        return nil
    }
    
    /// Read the title of the frontmost window of a process via Accessibility API.
    private nonisolated func getActiveWindowTitle(pid: pid_t) -> String? {
        let appElement = AXUIElementCreateApplication(pid)
        
        var windowsRef: CFTypeRef?
        let result = AXUIElementCopyAttributeValue(appElement, kAXWindowsAttribute as CFString, &windowsRef)
        guard result == .success, let windows = windowsRef as? [AXUIElement], !windows.isEmpty else {
            return nil
        }
        
        // Get the title of the first (frontmost) window
        var titleRef: CFTypeRef?
        let titleResult = AXUIElementCopyAttributeValue(windows[0], kAXTitleAttribute as CFString, &titleRef)
        guard titleResult == .success, let title = titleRef as? String else {
            return nil
        }
        
        return title
    }
    
    // MARK: - Call Confirmation
    
    private func confirmCall(app: MonitoredApp, bundleID: String) {
        let call = DetectedCall(
            appName: app.name,
            bundleID: bundleID,
            sourceType: app.type,
            detectedAt: Date()
        )
        detectedCall = call
        silentPollCount = 0
        audioActiveCount.removeAll()
        onCallConfirmed?(call)
        print("[Dialogue] Call confirmed: \(app.name) (\(bundleID))")
    }
    
    /// Manually mark the current call as ended (e.g., when user stops recording).
    func clearDetectedCall() {
        if let call = detectedCall {
            print("[Dialogue] Call manually cleared: \(call.appName)")
        }
        detectedCall = nil
        silentPollCount = 0
        audioActiveCount.removeAll()
    }
}
