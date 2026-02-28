import SwiftUI

/// The main content view for the app window.
/// Shows a sidebar with the document library and the BlockNote editor.
/// Phase 2: Adds the status footer bar and meeting recording trigger.
/// Phase 3: Adds the floating AI chat toolbar.
struct ContentView: View {
    @EnvironmentObject var documentManager: DocumentManager
    @EnvironmentObject var appState: AppState
    @StateObject private var launchManager = FirstLaunchManager.shared
    
    /// Manages the floating recording panel.
    @State private var recordingPanel = LiveRecordingPanel()
    
    /// Manages the floating post-meeting labeler panel.
    @State private var voiceLabelerPanel = PostMeetingVoiceLabeler()
    
    /// Shared recording coordinator — models loaded once at startup, stays resident.
    @StateObject private var recordingCoordinator = RecordingCoordinator.shared
    
    /// Whether to show the voice enrollment modal.
    @State private var showEnrollmentSheet = false
    
    // MARK: - Phase 4: Auto-Recording
    
    /// The auto-recording orchestrator.
    @StateObject private var orchestrator = AutoRecordingOrchestrator.shared
    
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
                        onSelectMeeting: { meeting in
                            appState.openMeeting(meeting)
                        }
                    )
                } detail: {
                    if appState.showHome {
                        HomeView()
                            .frame(minWidth: 500, minHeight: 400)
                    } else if let meeting = appState.selectedMeeting {
                        MeetingDetailView(meeting: meeting)
                            .frame(minWidth: 500, minHeight: 400)
                    } else {
                        BlockNoteEditorView(document: appState.currentDocument)
                            .frame(minWidth: 500, minHeight: 400)
                    }
                }
                .navigationSplitViewStyle(.balanced)
                
                // Status footer bar (download progress / model loading / recording button)
                StatusFooterView(
                    launchManager: launchManager,
                    coordinator: recordingCoordinator,
                    onStartRecording: { startRecording() }
                )
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
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                if launchManager.isComplete && recordingCoordinator.modelsReady {
                    Button(action: startRecording) {
                        Circle()
                            .fill(.red)
                            .frame(width: 14, height: 14)
                            .overlay(
                                Circle()
                                    .strokeBorder(.white.opacity(0.3), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                    .help("Start Meeting Recording (⇧⌘R)")
                }
            }
        }
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
            // Track when the user manually collapses or expands the sidebar
            // (not triggered by our auto-reveal logic).
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
            
            // Trigger first-launch flow if needed
            launchManager.beginIfNeeded()
            
            // If models are already downloaded, pre-load them immediately
            if launchManager.isComplete {
                Task {
                    await recordingCoordinator.loadModelsIfNeeded()
                    startOrchestrator()
                }
            }
        }
        .onChange(of: launchManager.isComplete) { _, complete in
            // Pre-load models as soon as first-launch finishes (download + enrollment)
            if complete {
                Task {
                    await recordingCoordinator.loadModelsIfNeeded()
                    startOrchestrator()
                }
            }
        }
        .onChange(of: launchManager.showEnrollmentPrompt) { _, showPrompt in
            showEnrollmentSheet = showPrompt
        }
        .sheet(isPresented: $showEnrollmentSheet) {
            VoiceEnrollmentView(
                viewModel: VoiceEnrollmentViewModel(),
                onComplete: {
                    showEnrollmentSheet = false
                    launchManager.markEnrollmentComplete()
                },
                onSkip: {
                    showEnrollmentSheet = false
                    launchManager.markEnrollmentComplete()
                }
            )
        }
        .onReceive(NotificationCenter.default.publisher(for: .reenrollVoice)) { _ in
            showEnrollmentSheet = true
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
        // Phase 4: Show all meetings
        .onReceive(NotificationCenter.default.publisher(for: .showAllMeetings)) { _ in
            // Navigate to home or first meeting — for now, navigate home
            // The meetings list is visible in the sidebar
            appState.navigateHome()
        }
        // Phase 4: Auto-recording started
        .onReceive(NotificationCenter.default.publisher(for: .autoRecordingStarted)) { _ in
            recordingPanel.show(coordinator: recordingCoordinator)
        }
    }
    
    // MARK: - Phase 4: Auto-Recording Orchestrator
    
    private func startOrchestrator() {
        guard recordingCoordinator.modelsReady else { return }
        
        orchestrator.onAutoRecordingStarted = { [self] in
            // Configure the coordinator's stop callback for auto-recordings
            recordingCoordinator.onRecordingStopped = { [self] meeting in
                recordingPanel.close()
                voiceLabelerPanel.show(recording: meeting)
            }
            // Show the recording panel
            recordingPanel.show(coordinator: recordingCoordinator)
        }
        
        orchestrator.onAutoRecordingStopped = { [self] in
            recordingPanel.close()
        }
        
        orchestrator.requestNotificationPermission()
        orchestrator.start()
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
    
    // MARK: - Recording
    
    private func startRecording() {
        guard launchManager.isComplete else { return }
        guard recordingCoordinator.modelsReady else {
            print("[Dialogue] Models not loaded yet, cannot start recording")
            return
        }
        
        // Configure the coordinator
        recordingCoordinator.onRecordingStopped = { [self] meeting in
            recordingPanel.close()
            // Show post-meeting voice labeler
            voiceLabelerPanel.show(recording: meeting)
        }
        
        // Start recording and show the floating panel
        recordingCoordinator.startRecording()
        recordingPanel.show(coordinator: recordingCoordinator)
    }
}

#Preview {
    ContentView()
        .environmentObject(DocumentManager.shared)
        .environmentObject(AppState.shared)
}
