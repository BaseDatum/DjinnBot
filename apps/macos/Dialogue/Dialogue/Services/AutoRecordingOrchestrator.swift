import Foundation
import UserNotifications
import Combine

// MARK: - AutoRecordingOrchestrator

/// Ties together CallDetectionService, AutoRecordSettings, RecordingCoordinator,
/// and MeetingStore to orchestrate automatic meeting recording.
///
/// Lifecycle:
/// 1. Starts monitoring on app launch (if auto-record enabled).
/// 2. When CallDetectionService confirms a call:
///    - Auto-record ON + notification ON: shows notification with countdown, then records.
///    - Auto-record ON + notification OFF: records immediately.
///    - Auto-record OFF + meeting app detected: shows "start recording?" notification.
/// 3. When call ends: stops recording, saves meeting.
@MainActor
final class AutoRecordingOrchestrator: ObservableObject {
    static let shared = AutoRecordingOrchestrator()
    
    // MARK: - Published State
    
    /// Whether the orchestrator is active.
    @Published private(set) var isActive: Bool = false
    
    /// Pending auto-record countdown (seconds remaining, nil if not counting down).
    @Published private(set) var countdownRemaining: Int?
    
    /// The call currently being auto-recorded.
    @Published private(set) var activeAutoCall: DetectedCall?
    
    // MARK: - Callbacks
    
    /// Called when an auto-recording starts (UI should show the recording panel).
    var onAutoRecordingStarted: (() -> Void)?
    
    /// Called when an auto-recording stops.
    var onAutoRecordingStopped: (() -> Void)?
    
    // MARK: - Dependencies
    
    private let settings = AutoRecordSettings.shared
    private let callDetection = CallDetectionService.shared
    private let coordinator = RecordingCoordinator.shared
    
    private var cancellables = Set<AnyCancellable>()
    private var countdownTimer: Timer?
    
    /// Notification category identifiers.
    private enum NotificationCategory {
        static let callDetected = "DIALOGUE_CALL_DETECTED"
        static let meetingAppOpen = "DIALOGUE_MEETING_APP_OPEN"
    }
    
    /// Notification action identifiers.
    private enum NotificationAction {
        static let cancel = "CANCEL_RECORDING"
        static let startNow = "START_NOW"
        static let startRecording = "START_RECORDING"
        static let dismiss = "DISMISS"
    }
    
    // MARK: - Init
    
    private init() {
        setupNotificationCategories()
        observeSettings()
    }
    
    // MARK: - Lifecycle
    
    /// Start the orchestrator. Call once at app launch after models are loaded.
    func start() {
        guard !isActive else { return }
        isActive = true
        
        // Wire up call detection callbacks
        callDetection.onCallConfirmed = { [weak self] call in
            self?.handleCallConfirmed(call)
        }
        
        callDetection.onCallEnded = { [weak self] call in
            self?.handleCallEnded(call)
        }
        
        callDetection.onMeetingAppLaunched = { [weak self] app in
            self?.handleMeetingAppLaunched(app)
        }
        
        // Start monitoring if auto-record is enabled
        if settings.autoRecordEnabled {
            callDetection.startMonitoring()
        }
        
        print("[Dialogue] Auto-recording orchestrator started (autoRecord=\(settings.autoRecordEnabled))")
    }
    
    /// Stop the orchestrator.
    func stop() {
        isActive = false
        callDetection.stopMonitoring()
        cancelCountdown()
        cancellables.removeAll()
        
        callDetection.onCallConfirmed = nil
        callDetection.onCallEnded = nil
        callDetection.onMeetingAppLaunched = nil
        
        print("[Dialogue] Auto-recording orchestrator stopped")
    }
    
    // MARK: - Settings Observation
    
    private func observeSettings() {
        settings.$autoRecordEnabled
            .dropFirst()
            .sink { [weak self] enabled in
                guard let self, self.isActive else { return }
                if enabled {
                    self.callDetection.startMonitoring()
                    print("[Dialogue] Auto-record enabled — started monitoring")
                } else {
                    self.callDetection.stopMonitoring()
                    self.cancelCountdown()
                    print("[Dialogue] Auto-record disabled — stopped monitoring")
                }
            }
            .store(in: &cancellables)
    }
    
    // MARK: - Call Handling
    
    private func handleCallConfirmed(_ call: DetectedCall) {
        // Don't auto-record if already recording
        guard !coordinator.isRecording else {
            print("[Dialogue] Call detected (\(call.appName)) but already recording — skipping")
            return
        }
        
        guard settings.autoRecordEnabled else {
            // Auto-record is off — only notify for meeting apps (handled separately)
            return
        }
        
        if settings.showNotificationBeforeRecording {
            // Show notification with 5-second countdown
            showCallDetectedNotification(call: call)
            startCountdown(for: call)
        } else {
            // Start immediately
            startAutoRecording(for: call)
        }
    }
    
    private func handleCallEnded(_ call: DetectedCall) {
        guard let activeCall = activeAutoCall,
              activeCall.bundleID == call.bundleID else { return }
        
        // Stop recording if it was auto-started
        if coordinator.isRecording {
            coordinator.stopRecording()
            onAutoRecordingStopped?()
            print("[Dialogue] Auto-recording stopped — call ended: \(call.appName)")
        }
        
        activeAutoCall = nil
    }
    
    private func handleMeetingAppLaunched(_ app: MonitoredApp) {
        // Always show a notification when a meeting app is launched,
        // even if auto-record is off.
        guard !coordinator.isRecording else { return }
        
        if settings.autoRecordEnabled {
            // Auto-record is on — monitoring will handle it when audio is detected.
            // But if monitoring isn't started yet (shouldn't happen), start it.
            if !callDetection.isMonitoring {
                callDetection.startMonitoring()
            }
        } else {
            // Auto-record is off — show a "would you like to record?" notification
            showMeetingAppNotification(app: app)
        }
    }
    
    // MARK: - Auto-Recording
    
    func startAutoRecording(for call: DetectedCall) {
        guard coordinator.modelsReady else {
            print("[Dialogue] Cannot auto-record — models not ready")
            return
        }
        
        guard !coordinator.isRecording else { return }
        
        activeAutoCall = call
        countdownRemaining = nil
        
        // Start recording with source metadata
        coordinator.startRecording(
            sourceApp: call.appName,
            sourceBundleID: call.bundleID,
            sourceType: call.sourceType
        )
        
        onAutoRecordingStarted?()
        print("[Dialogue] Auto-recording started: \(call.appName)")
    }
    
    /// Called when the user explicitly starts recording from a meeting app notification.
    func startRecordingForMeetingApp(_ app: MonitoredApp) {
        guard coordinator.modelsReady, !coordinator.isRecording else { return }
        
        let call = DetectedCall(
            appName: app.name,
            bundleID: app.bundleID ?? app.name,
            sourceType: app.type,
            detectedAt: Date()
        )
        
        activeAutoCall = call
        
        coordinator.startRecording(
            sourceApp: app.name,
            sourceBundleID: app.bundleID,
            sourceType: app.type
        )
        
        // Start monitoring so we can detect when the call ends
        if !callDetection.isMonitoring {
            callDetection.startMonitoring()
        }
        
        onAutoRecordingStarted?()
        print("[Dialogue] Recording started for meeting app: \(app.name)")
    }
    
    // MARK: - Countdown
    
    private func startCountdown(for call: DetectedCall) {
        countdownRemaining = 5
        
        countdownTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] timer in
            Task { @MainActor [weak self] in
                guard let self else {
                    timer.invalidate()
                    return
                }
                
                guard var remaining = self.countdownRemaining else {
                    timer.invalidate()
                    return
                }
                
                remaining -= 1
                self.countdownRemaining = remaining
                
                if remaining <= 0 {
                    timer.invalidate()
                    self.countdownTimer = nil
                    self.startAutoRecording(for: call)
                }
            }
        }
    }
    
    /// Cancel a pending auto-record countdown.
    func cancelCountdown() {
        countdownTimer?.invalidate()
        countdownTimer = nil
        countdownRemaining = nil
        
        // Remove any pending notifications
        UNUserNotificationCenter.current().removeDeliveredNotifications(
            withIdentifiers: ["dialogue-call-detected"]
        )
    }
    
    // MARK: - Notifications
    
    private func setupNotificationCategories() {
        let cancelAction = UNNotificationAction(
            identifier: NotificationAction.cancel,
            title: "Cancel",
            options: [.destructive]
        )
        let startNowAction = UNNotificationAction(
            identifier: NotificationAction.startNow,
            title: "Start Now",
            options: [.foreground]
        )
        let startRecordingAction = UNNotificationAction(
            identifier: NotificationAction.startRecording,
            title: "Start Recording",
            options: [.foreground]
        )
        let dismissAction = UNNotificationAction(
            identifier: NotificationAction.dismiss,
            title: "Dismiss",
            options: []
        )
        
        let callCategory = UNNotificationCategory(
            identifier: NotificationCategory.callDetected,
            actions: [startNowAction, cancelAction],
            intentIdentifiers: []
        )
        
        let meetingCategory = UNNotificationCategory(
            identifier: NotificationCategory.meetingAppOpen,
            actions: [startRecordingAction, dismissAction],
            intentIdentifiers: []
        )
        
        UNUserNotificationCenter.current().setNotificationCategories([callCategory, meetingCategory])
    }
    
    /// Request notification permission (call once when auto-record is first enabled).
    func requestNotificationPermission() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { granted, error in
            if let error = error {
                print("[Dialogue] Notification permission error: \(error)")
            } else {
                print("[Dialogue] Notification permission \(granted ? "granted" : "denied")")
            }
        }
    }
    
    private func showCallDetectedNotification(call: DetectedCall) {
        let content = UNMutableNotificationContent()
        content.title = "\(call.appName) call detected"
        content.body = "Recording will start in 5 seconds..."
        content.sound = .default
        content.categoryIdentifier = NotificationCategory.callDetected
        
        let request = UNNotificationRequest(
            identifier: "dialogue-call-detected",
            content: content,
            trigger: nil  // Show immediately
        )
        
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                print("[Dialogue] Failed to show call notification: \(error)")
            }
        }
    }
    
    private func showMeetingAppNotification(app: MonitoredApp) {
        let content = UNMutableNotificationContent()
        content.title = "\(app.name) is open"
        content.body = "Would you like to start recording this meeting?"
        content.sound = .default
        content.categoryIdentifier = NotificationCategory.meetingAppOpen
        content.userInfo = ["appName": app.name, "bundleID": app.bundleID ?? ""]
        
        let request = UNNotificationRequest(
            identifier: "dialogue-meeting-app-\(app.id)",
            content: content,
            trigger: nil
        )
        
        UNUserNotificationCenter.current().add(request) { error in
            if let error = error {
                print("[Dialogue] Failed to show meeting app notification: \(error)")
            }
        }
    }
}

// MARK: - UNUserNotificationCenterDelegate

/// Handles notification actions (Cancel, Start Now, Start Recording).
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()
    
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let actionID = response.actionIdentifier
        
        Task { @MainActor in
            switch actionID {
            case "CANCEL_RECORDING":
                AutoRecordingOrchestrator.shared.cancelCountdown()
                
            case "START_NOW":
                // Cancel countdown and start immediately
                AutoRecordingOrchestrator.shared.cancelCountdown()
                if let call = CallDetectionService.shared.detectedCall {
                    AutoRecordingOrchestrator.shared.startAutoRecording(for: call)
                }
                
            case "START_RECORDING":
                // Start recording for the meeting app from notification
                let userInfo = response.notification.request.content.userInfo
                if let appName = userInfo["appName"] as? String {
                    let app = AutoRecordSettings.monitoredApps.first { $0.name == appName }
                    if let app = app {
                        AutoRecordingOrchestrator.shared.startRecordingForMeetingApp(app)
                    }
                }
                
            case "DISMISS":
                break
                
            default:
                break
            }
        }
        
        completionHandler()
    }
    
    /// Show notifications even when app is in foreground.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        completionHandler([.banner, .sound])
    }
}


