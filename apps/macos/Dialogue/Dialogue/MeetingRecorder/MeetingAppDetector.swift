import AppKit
import OSLog
import ScreenCaptureKit

/// Detects running meeting applications and provides their SCRunningApplication
/// handles for ScreenCaptureKit per-app audio capture.
final class MeetingAppDetector: Sendable {
    static let shared = MeetingAppDetector()

    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "MeetingAppDetector")

    /// Bundle identifiers of known meeting/conferencing apps.
    let knownMeetingBundleIDs: Set<String> = [
        "us.zoom.xos",                     // Zoom
        "com.microsoft.teams2",             // Teams (new Electron)
        "com.microsoft.teams",              // Teams (classic)
        "com.google.Chrome",                // Chrome (Google Meet, etc.)
        "org.mozilla.firefox",              // Firefox (Google Meet, etc.)
        "com.apple.Safari",                 // Safari (web-based meetings)
        "com.cisco.webex.meetings",         // Webex
        "com.cisco.webexteams",             // Webex (legacy)
        "com.slack.Slack",                  // Slack Huddles
        "com.tinyspeck.slackmacgap",        // Slack (MAS)
        "com.brave.Browser",               // Brave (web meetings)
        "com.microsoft.edgemac",            // Edge (web meetings)
        "com.loom.desktop",                 // Loom
        "com.discord.Discord",              // Discord
    ]

    private init() {}

    // MARK: - Detection

    /// Returns SCApplication handles for all currently running meeting apps.
    ///
    /// Uses ScreenCaptureKit's `SCShareableContent` to enumerate applications,
    /// filtering to only known meeting bundle IDs.
    func runningMeetingApplications() async -> [SCRunningApplication] {
        do {
            let shareable = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: false
            )
            let meetingApps = shareable.applications.filter { app in
                knownMeetingBundleIDs.contains(app.bundleIdentifier)
            }
            if !meetingApps.isEmpty {
                let names = meetingApps.map(\.applicationName).joined(separator: ", ")
                logger.info("Detected meeting apps: \(names)")
            }
            return meetingApps
        } catch {
            logger.error("Failed to enumerate shareable content: \(error.localizedDescription)")
            return []
        }
    }

    /// Quick check: is any known meeting app running?
    func hasActiveMeeting() async -> Bool {
        !(await runningMeetingApplications()).isEmpty
    }

    /// Returns display names of detected meeting apps (for UI).
    func detectedAppNames() async -> [String] {
        let apps = await runningMeetingApplications()
        return apps.map { $0.applicationName }
    }
}
