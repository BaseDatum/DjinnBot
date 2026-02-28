import Foundation
import Combine

// MARK: - AutoRecordSettings

/// User preferences for automatic meeting recording.
/// Persisted via UserDefaults.
@MainActor
final class AutoRecordSettings: ObservableObject {
    static let shared = AutoRecordSettings()
    
    private let defaults = UserDefaults.standard
    
    // MARK: - Keys
    
    private enum Key {
        static let autoRecordEnabled = "dialogue.autoRecordEnabled"
        static let showNotification = "dialogue.autoRecordNotify"
    }
    
    // MARK: - Published Properties
    
    /// Whether auto-recording is enabled.
    /// When on, calls and meetings are automatically recorded and transcribed.
    @Published var autoRecordEnabled: Bool {
        didSet { defaults.set(autoRecordEnabled, forKey: Key.autoRecordEnabled) }
    }
    
    /// Whether to show a notification before auto-recording starts.
    /// Gives the user a 5-second window to cancel.
    @Published var showNotificationBeforeRecording: Bool {
        didSet { defaults.set(showNotificationBeforeRecording, forKey: Key.showNotification) }
    }
    
    // MARK: - Init
    
    private init() {
        // Register defaults
        defaults.register(defaults: [
            Key.autoRecordEnabled: false,
            Key.showNotification: true,
        ])
        
        self.autoRecordEnabled = defaults.bool(forKey: Key.autoRecordEnabled)
        self.showNotificationBeforeRecording = defaults.bool(forKey: Key.showNotification)
    }
    
    // MARK: - Monitored Apps
    
    /// Apps that are monitored for call/meeting detection.
    static let monitoredApps: [MonitoredApp] = [
        MonitoredApp(name: "Zoom", bundleID: "us.zoom.xos", type: .meetingApp),
        MonitoredApp(name: "Google Meet", bundleID: nil, type: .meetingApp),  // browser-based
        MonitoredApp(name: "Slack", bundleID: "com.tinyspeck.slackmacgap", type: .call),
        MonitoredApp(name: "FaceTime", bundleID: "com.apple.FaceTime", type: .call),
        MonitoredApp(name: "Signal", bundleID: "org.whispersystems.signal-desktop", type: .call),
        MonitoredApp(name: "WhatsApp", bundleID: "net.whatsapp.WhatsApp", type: .call),
        MonitoredApp(name: "Microsoft Teams", bundleID: "com.microsoft.teams2", type: .call),
    ]
}

// MARK: - MonitoredApp

/// An app that Dialogue monitors for call/meeting activity.
struct MonitoredApp: Identifiable {
    let id: String
    let name: String
    let bundleID: String?
    let type: MeetingSourceType
    
    init(name: String, bundleID: String?, type: MeetingSourceType) {
        self.id = bundleID ?? name
        self.name = name
        self.bundleID = bundleID
        self.type = type
    }
}
