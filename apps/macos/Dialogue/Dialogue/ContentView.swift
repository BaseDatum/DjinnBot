import Combine
import SwiftUI

/// The main content view for the app window.
/// Shows a sidebar with the document library and the BlockNote editor.
/// The meeting recorder is accessible via a toolbar button in the title bar
/// and a collapsible live transcript banner below the toolbar.
struct ContentView: View {
    @EnvironmentObject var documentManager: DocumentManager
    @EnvironmentObject var appState: AppState
    
    // MARK: - Meeting Recorder (app-wide)
    
    /// Shared recorder controller, available from any screen.
    /// Wrapped in an availability-checked helper so the @StateObject
    /// can live here without polluting the rest of the view.
    @StateObject private var recorderHolder = RecorderHolder()
    
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
                        },
                        onSelectMeetingRecorder: {
                            appState.navigateHome()
                        },
                        onSelectMeeting: { meeting in
                            appState.openMeeting(meeting)
                        }
                    )
                } detail: {
                    VStack(spacing: 0) {
                        if #available(macOS 26.0, *),
                           let recorder = recorderHolder.recorder,
                           recorder.isRecording {
                            LiveTranscriptBanner(recorder: recorder)
                        }

                        detailContent
                    }
                }
                .navigationSplitViewStyle(.balanced)
                .toolbar {
                    ToolbarItem(placement: .primaryAction) {
                        if #available(macOS 26.0, *),
                           let recorder = recorderHolder.recorder {
                            RecordingToolbarButton(recorder: recorder)
                        }
                    }
                }

                // App-wide status footer (model download progress, etc.)
                StatusFooterView()
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
            if appState.currentFileURL == nil && appState.activeScreen.isEditor {
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
        .onReceive(NotificationCenter.default.publisher(for: .toggleRecording)) { _ in
            if #available(macOS 26.0, *) {
                guard let recorder = recorderHolder.recorder else { return }
                Task {
                    if recorder.isRecording {
                        await recorder.stop()
                    } else {
                        await recorder.start()
                    }
                }
            }
        }
    }

    // MARK: - Detail Content

    @ViewBuilder
    private var detailContent: some View {
        switch appState.activeScreen {
        case .home:
            HomeView()
                .frame(minWidth: 500, minHeight: 400)
        case .editor:
            BlockNoteEditorView(document: appState.currentDocument)
                .frame(minWidth: 500, minHeight: 400)
        case .meetingRecorder:
            // Legacy: redirect to home (recording now lives in the toolbar)
            HomeView()
                .frame(minWidth: 500, minHeight: 400)
                .onAppear { appState.navigateHome() }
        case .meetingDetail(let meeting):
            MeetingDetailView(meeting: meeting)
                .frame(minWidth: 500, minHeight: 400)
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

// MARK: - RecorderHolder

/// Availability-safe wrapper so we can hold a @StateObject of
/// MeetingRecorderController (which requires macOS 26.0) inside
/// a view that doesn't itself require macOS 26.0.
@MainActor
final class RecorderHolder: ObservableObject {
    /// The underlying recorder, stored as `AnyObject` to avoid referencing
    /// the `@available(macOS 26.0, *)` type in the property signature.
    private let _recorder: AnyObject?

    /// Forwards objectWillChange from the inner controller so ContentView
    /// re-renders when recorder state (e.g. isRecording) changes.
    private var cancellable: AnyCancellable?

    /// Typed accessor. Returns nil on systems older than macOS 26.0.
    @available(macOS 26.0, *)
    var recorder: MeetingRecorderController? {
        _recorder as? MeetingRecorderController
    }

    init() {
        if #available(macOS 26.0, *) {
            let controller = MeetingRecorderController()
            _recorder = controller
            cancellable = controller.objectWillChange.sink { [weak self] _ in
                self?.objectWillChange.send()
            }
        } else {
            _recorder = nil
            cancellable = nil
        }
    }
}

#Preview {
    ContentView()
        .environmentObject(DocumentManager.shared)
        .environmentObject(AppState.shared)
}
