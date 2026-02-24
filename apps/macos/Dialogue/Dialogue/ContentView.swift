import SwiftUI

/// The main content view for the app window.
/// Shows a sidebar with the document library and the BlockNote editor.
struct ContentView: View {
    @EnvironmentObject var documentManager: DocumentManager
    @EnvironmentObject var appState: AppState

    var body: some View {
        NavigationSplitView {
            SidebarView(
                documentManager: documentManager,
                onSelectDocument: { url in
                    appState.openDocument(at: url)
                }
            )
        } detail: {
            BlockNoteEditorView(document: appState.currentDocument)
                .frame(minWidth: 500, minHeight: 400)
        }
        .navigationSplitViewStyle(.balanced)
        .frame(minWidth: 800, minHeight: 500)
        .onAppear {
            // Open the most recently edited document, or create one if none exist
            if appState.currentFileURL == nil {
                if let recent = documentManager.mostRecentDocument() {
                    appState.openDocument(at: recent)
                } else {
                    appState.createAndOpenNewDocument()
                }
            }
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(DocumentManager.shared)
        .environmentObject(AppState.shared)
}
