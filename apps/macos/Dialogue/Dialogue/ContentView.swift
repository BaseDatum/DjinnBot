import SwiftUI

/// The main content view for the app window.
/// Shows a sidebar with the document library and the BlockNote editor.
struct ContentView: View {
    @EnvironmentObject var documentManager: DocumentManager
    @EnvironmentObject var appState: AppState
    
    // MARK: - Phase 3: Floating Chat
    
    /// Mouse proximity detector for the floating chat toolbar.
    @StateObject private var bottomEdgeDetector = BottomEdgeDetector()
    
    /// Mouse proximity detector for auto-revealing the sidebar.
    @StateObject private var sidebarEdgeDetector = SidebarEdgeDetector()
    
    /// Controls sidebar visibility for NavigationSplitView.
    @State private var columnVisibility: NavigationSplitViewVisibility = .all
    
    /// Whether the floating chat toolbar is visible.
    @State private var chatToolbarVisible = false

    var body: some View {
        ZStack {
            VStack(spacing: 0) {
                NavigationSplitView(columnVisibility: $columnVisibility) {
                    SidebarView(
                        documentManager: documentManager,
                        onSelectDocument: { url in
                            appState.openDocument(at: url)
                        },
                        onSelectHome: {
                            appState.navigateHome()
                        }
                    )
                } detail: {
                    if appState.showHome {
                        HomeView()
                            .frame(minWidth: 500, minHeight: 400)
                    } else {
                        BlockNoteEditorView(document: appState.currentDocument)
                            .frame(minWidth: 500, minHeight: 400)
                    }
                }
                .navigationSplitViewStyle(.balanced)
            }
            
            // Phase 3: Mouse tracking layer (invisible, covers the whole window)
            MouseTrackingView(detector: bottomEdgeDetector, sidebarDetector: sidebarEdgeDetector)
                .allowsHitTesting(false)
            
            // Phase 3: Floating chat toolbar (overlays at bottom)
            FloatingChatToolbar(
                detector: bottomEdgeDetector,
                isVisible: $chatToolbarVisible
            )
        }
        .frame(minWidth: 800, minHeight: 500)
        .onChange(of: bottomEdgeDetector.isNearBottom) { _, isNear in
            chatToolbarVisible = isNear
        }
        .onChange(of: sidebarEdgeDetector.isNearLeftEdge) { _, isNear in
            withAnimation(.easeInOut(duration: 0.2)) {
                if isNear {
                    columnVisibility = .all
                } else {
                    columnVisibility = .detailOnly
                }
            }
        }
        .onChange(of: columnVisibility) { oldValue, newValue in
            if !sidebarEdgeDetector.isNearLeftEdge {
                if newValue == .detailOnly {
                    sidebarEdgeDetector.userCollapsedSidebar()
                } else if newValue == .all {
                    sidebarEdgeDetector.userExpandedSidebar()
                }
            }
        }
        .onAppear {
            // Start on the Home screen; pre-load the most recent document
            // so it's ready when the user navigates to it.
            if appState.currentFileURL == nil && !appState.showHome {
                if let recent = documentManager.mostRecentDocument() {
                    appState.openDocument(at: recent)
                } else {
                    appState.createAndOpenNewDocument()
                }
            }
        }
        // Phase 3: Chat panel keyboard shortcuts
        .onReceive(NotificationCenter.default.publisher(for: .toggleChatPanel)) { _ in
            toggleChatToolbar()
        }
        .onReceive(NotificationCenter.default.publisher(for: .newChatSession)) { _ in
            ChatSessionManager.shared.createNewSession()
            bottomEdgeDetector.forceShow()
            chatToolbarVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: .closeChatPanel)) { _ in
            bottomEdgeDetector.forceHide()
            chatToolbarVisible = false
        }
    }
    
    // MARK: - Phase 3: Chat Toggle
    
    private func toggleChatToolbar() {
        if chatToolbarVisible {
            bottomEdgeDetector.forceHide()
            chatToolbarVisible = false
        } else {
            bottomEdgeDetector.forceShow()
            chatToolbarVisible = true
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(DocumentManager.shared)
        .environmentObject(AppState.shared)
}
