import SwiftUI

@main
struct DialogueApp: App {
    @StateObject private var documentManager = DocumentManager.shared
    @StateObject private var appState = AppState.shared

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(documentManager)
                .environmentObject(appState)
                .onAppear {
                    // Pre-download ASR and diarization models at app launch
                    // so recording can start instantly.
                    if #available(macOS 26.0, *) {
                        ModelPreloader.shared.preload()
                    }
                }
        }
        .commands {
            CommandGroup(replacing: .newItem) {
                Button("New Document") {
                    appState.createAndOpenNewDocument()
                }
                .keyboardShortcut("n", modifiers: .command)
            }
            
            CommandGroup(replacing: .saveItem) {
                Button("Save") {
                    appState.saveCurrentDocument()
                }
                .keyboardShortcut("s", modifiers: .command)
            }
            
            // Meeting Recorder
            CommandMenu("Meeting") {
                Button("Toggle Recording") {
                    NotificationCenter.default.post(name: .toggleRecording, object: nil)
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
            }

            // Phase 3: AI Chat commands
            CommandMenu("AI Chat") {
                Button("Toggle Chat Panel") {
                    NotificationCenter.default.post(name: .toggleChatPanel, object: nil)
                }
                .keyboardShortcut("k", modifiers: .command)
                
                Button("New Chat Session") {
                    NotificationCenter.default.post(name: .newChatSession, object: nil)
                }
                .keyboardShortcut("k", modifiers: [.command, .shift])
                
                Divider()
                
                Button("Close Chat") {
                    NotificationCenter.default.post(name: .closeChatPanel, object: nil)
                }
                .keyboardShortcut(.escape, modifiers: [])
            }
        }

        Settings {
            SettingsView()
        }
    }
}

// MARK: - App State

/// Central app state managing the currently open document.
final class AppState: ObservableObject {
    static let shared = AppState()

    /// Which screen is currently shown in the detail area.
    enum DetailScreen {
        case home
        case editor
        case meetingRecorder
        case meetingDetail(SavedMeeting)

        var isHome: Bool {
            if case .home = self { return true }
            return false
        }
        var isEditor: Bool {
            if case .editor = self { return true }
            return false
        }
    }

    @Published var activeScreen: DetailScreen = .home

    /// Whether the Home screen is currently shown instead of the editor.
    var showHome: Bool {
        get { activeScreen.isHome }
        set { if newValue { activeScreen = .home } }
    }

    /// The document currently loaded in the editor.
    @Published var currentDocument: BlockNoteDocument = .init()

    /// The file URL of the currently open document (nil if unsaved).
    @Published var currentFileURL: URL?

    private init() {}

    /// Navigate to the Home screen.
    func navigateHome() {
        saveCurrentDocument()
        activeScreen = .home
    }

    /// Navigate to the Meeting Recorder screen.
    func openMeetingRecorder() {
        saveCurrentDocument()
        activeScreen = .meetingRecorder
    }

    /// Navigate to view a saved meeting's transcript.
    func openMeeting(_ meeting: SavedMeeting) {
        saveCurrentDocument()
        activeScreen = .meetingDetail(meeting)
    }

    func openDocument(at url: URL) {
        // Save current document before switching to prevent data loss
        saveCurrentDocument()

        guard let data = try? Data(contentsOf: url),
              let file = try? BlockNoteFile.fromJSON(data) else {
            print("[Dialogue] Failed to open document at \(url.path)")
            return
        }
        currentDocument = BlockNoteDocument(file: file)
        currentFileURL = url
        activeScreen = .editor
    }

    func createAndOpenNewDocument(in folder: URL? = nil) {
        if let url = DocumentManager.shared.createNewDocument(in: folder) {
            openDocument(at: url)
        }
    }

    func saveCurrentDocument() {
        guard let url = currentFileURL,
              let data = try? currentDocument.file.toJSON() else { return }
        try? data.write(to: url, options: .atomic)
        currentDocument.hasUnsavedChanges = false
    }
}

// MARK: - Notification Names

extension Notification.Name {
    // Phase 3: Chat panel notifications
    static let toggleChatPanel = Notification.Name("dialogue.toggleChatPanel")
    static let newChatSession = Notification.Name("dialogue.newChatSession")
    static let closeChatPanel = Notification.Name("dialogue.closeChatPanel")

    // Meeting recording
    static let toggleRecording = Notification.Name("dialogue.toggleRecording")
}
