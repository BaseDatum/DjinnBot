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
            
            // Phase 2: Meeting recording commands
            CommandMenu("Meeting") {
                Button("Start Recording") {
                    NotificationCenter.default.post(name: .startMeetingRecording, object: nil)
                }
                .keyboardShortcut("r", modifiers: [.command, .shift])
                
                Divider()
                
                Button("Re-enroll Voice...") {
                    NotificationCenter.default.post(name: .reenrollVoice, object: nil)
                }
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

    /// Whether the Home screen is currently shown instead of the editor.
    @Published var showHome: Bool = true

    /// The document currently loaded in the editor.
    @Published var currentDocument: BlockNoteDocument = .init()

    /// The file URL of the currently open document (nil if unsaved).
    @Published var currentFileURL: URL?

    private init() {}

    /// Navigate to the Home screen.
    func navigateHome() {
        showHome = true
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
        showHome = false
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
    static let startMeetingRecording = Notification.Name("dialogue.startMeetingRecording")
    static let reenrollVoice = Notification.Name("dialogue.reenrollVoice")
    
    // Phase 3: Chat panel notifications
    static let toggleChatPanel = Notification.Name("dialogue.toggleChatPanel")
    static let newChatSession = Notification.Name("dialogue.newChatSession")
    static let closeChatPanel = Notification.Name("dialogue.closeChatPanel")
}
