import SwiftUI
import AppKit
import CoreAudio

// MARK: - LiveRecordingPanel

/// Manages a floating NSWindow that displays the live recording interface:
/// waveform, timer, scrolling transcript with speaker labels.
final class LiveRecordingPanel {
    
    private var window: NSWindow?
    private var coordinator: RecordingCoordinator?
    
    /// Show the floating recording panel. Closes any existing panel first.
    @MainActor
    func show(coordinator: RecordingCoordinator) {
        // Close previous panel if still open
        if window?.isVisible == true {
            window?.close()
        }
        window = nil
        
        self.coordinator = coordinator
        
        let contentView = LiveRecordingPanelView(coordinator: coordinator)
        
        let hostingView = NSHostingView(rootView: contentView)
        hostingView.frame = NSRect(x: 0, y: 0, width: 420, height: 560)
        
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 560),
            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.title = "Meeting Recording"
        panel.contentView = hostingView
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.minSize = NSSize(width: 340, height: 400)
        panel.center()
        
        // Position in upper-right area of screen
        if let screen = NSScreen.main {
            let screenFrame = screen.visibleFrame
            let x = screenFrame.maxX - panel.frame.width - 20
            let y = screenFrame.maxY - panel.frame.height - 20
            panel.setFrameOrigin(NSPoint(x: x, y: y))
        }
        
        panel.makeKeyAndOrderFront(nil)
        self.window = panel
    }
    
    /// Close the floating panel.
    @MainActor
    func close() {
        window?.close()
        window = nil
        coordinator = nil
    }
    
    /// Whether the panel is currently visible.
    var isVisible: Bool {
        window?.isVisible ?? false
    }
}

// MARK: - LiveRecordingPanelView (SwiftUI)

struct LiveRecordingPanelView: View {
    @ObservedObject var coordinator: RecordingCoordinator
    
    var body: some View {
        VStack(spacing: 0) {
            if !coordinator.modelsReady && !coordinator.isRecording {
                // Model loading state
                modelLoadingSection
            } else {
                // Header: timer + status
                headerSection
                
                Divider()
                
                // Waveform visualization
                waveformSection
                    .frame(height: 60)
                
                Divider()
                
                // Diarization error banner (if any)
                if let error = coordinator.diarizationError {
                    HStack(spacing: 6) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(.orange)
                            .font(.caption)
                        Text(error)
                            .font(.caption2)
                            .foregroundStyle(.orange)
                            .lineLimit(2)
                        Spacer()
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 4)
                    .background(Color.orange.opacity(0.1))
                }
                
                // Scrolling transcript
                transcriptSection
                
                Divider()
                
                // Controls
                controlsSection
            }
        }
        .frame(minWidth: 340, minHeight: 400)
    }
    
    // MARK: - Model Loading
    
    private var modelLoadingSection: some View {
        VStack(spacing: 16) {
            Spacer()
            ProgressView()
                .scaleEffect(1.5)
            Text(coordinator.modelLoadingStatus.isEmpty ? "Preparing..." : coordinator.modelLoadingStatus)
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("Loading AI models for transcription")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding()
    }
    
    // MARK: - Header
    
    private var headerSection: some View {
        HStack {
            // Recording indicator
            Circle()
                .fill(coordinator.isPaused ? Color.yellow : Color.red)
                .frame(width: 10, height: 10)
                .opacity(coordinator.isPaused ? 1.0 : pulsingOpacity)
            
            Text(coordinator.isPaused ? "Paused" : "Recording")
                .font(.headline)
                .foregroundStyle(coordinator.isPaused ? .secondary : .primary)
            
            Spacer()
            
            // Timer
            Text(formatDuration(coordinator.elapsedTime))
                .font(.system(.title2, design: .monospaced))
                .foregroundStyle(.primary)
            
            Spacer()
            
            // Speaker count
            Label("\(coordinator.speakerCount)", systemImage: "person.2")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
    
    @State private var pulsePhase = false
    
    private var pulsingOpacity: Double {
        // Simple pulsing effect using a timer
        return 1.0
    }
    
    // MARK: - Waveform
    
    private var waveformSection: some View {
        GeometryReader { geometry in
            WaveformView(
                level: coordinator.audioLevel,
                width: geometry.size.width,
                height: geometry.size.height
            )
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
    }
    
    // MARK: - Transcript
    
    private var transcriptSection: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 8) {
                    ForEach(coordinator.displaySegments) { segment in
                        TranscriptSegmentRow(segment: segment)
                            .id(segment.id)
                    }
                    
                    // Partial text (currently being decoded)
                    if !coordinator.partialText.isEmpty {
                        HStack(alignment: .top, spacing: 8) {
                            Text("...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .frame(width: 80, alignment: .trailing)
                            
                            Text(coordinator.partialText)
                                .font(.body)
                                .foregroundStyle(.secondary)
                                .italic()
                        }
                        .padding(.horizontal, 12)
                        .id("partial")
                    }
                }
                .padding(.vertical, 8)
            }
            .onChange(of: coordinator.displaySegments.count) { _, _ in
                // Auto-scroll to bottom
                if let last = coordinator.displaySegments.last {
                    withAnimation(.easeOut(duration: 0.2)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }
    
    // MARK: - Controls
    
    private var controlsSection: some View {
        HStack(spacing: 20) {
            // Pause / Resume
            Button {
                coordinator.togglePause()
            } label: {
                Label(
                    coordinator.isPaused ? "Resume" : "Pause",
                    systemImage: coordinator.isPaused ? "play.fill" : "pause.fill"
                )
            }
            .buttonStyle(.bordered)
            .controlSize(.large)
            
            Spacer()
            
            // Device selector
            if !coordinator.availableDevices.isEmpty {
                Picker("Input", selection: $coordinator.selectedDeviceID) {
                    Text("System Default").tag(AudioDeviceID?.none)
                    ForEach(coordinator.availableDevices) { device in
                        Text(device.name).tag(AudioDeviceID?.some(device.id))
                    }
                }
                .frame(maxWidth: 160)
            }
            
            Spacer()
            
            // Stop
            Button(role: .destructive) {
                coordinator.stopRecording()
            } label: {
                Label("Stop", systemImage: "stop.fill")
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .controlSize(.large)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }
    
    // MARK: - Helpers
    
    private func formatDuration(_ seconds: TimeInterval) -> String {
        let h = Int(seconds) / 3600
        let m = (Int(seconds) % 3600) / 60
        let s = Int(seconds) % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%02d:%02d", m, s)
    }
}

// MARK: - TranscriptSegmentRow

struct TranscriptSegmentRow: View {
    let segment: TranscriptSegment
    
    private static let speakerColors: [Color] = [
        .blue, .green, .orange, .purple, .pink, .teal, .indigo, .mint
    ]
    
    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Text(segment.speakerLabel)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(speakerColor)
                .frame(width: 80, alignment: .trailing)
            
            Text(segment.text)
                .font(.body)
                .foregroundStyle(segment.isPartial ? .secondary : .primary)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 12)
    }
    
    private var speakerColor: Color {
        let idx = abs(segment.speakerColorIndex) % Self.speakerColors.count
        return Self.speakerColors[idx]
    }
}

// MARK: - WaveformView

struct WaveformView: View {
    let level: Float
    let width: CGFloat
    let height: CGFloat
    
    /// Number of bars in the waveform display.
    private let barCount = 40
    
    var body: some View {
        HStack(spacing: 2) {
            ForEach(0..<barCount, id: \.self) { i in
                let barLevel = barHeight(for: i)
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(barColor(for: barLevel))
                    .frame(width: max(2, (width - CGFloat(barCount) * 2) / CGFloat(barCount)),
                           height: max(2, barLevel * height))
                    .animation(.easeOut(duration: 0.08), value: level)
            }
        }
        .frame(height: height)
    }
    
    private func barHeight(for index: Int) -> CGFloat {
        // Create a natural-looking waveform shape centered around the middle
        let center = CGFloat(barCount) / 2.0
        let distance = abs(CGFloat(index) - center) / center
        let envelope = 1.0 - (distance * distance) // Parabolic envelope
        let noise = CGFloat.random(in: 0.7...1.0) // Slight randomness
        return CGFloat(level) * envelope * noise
    }
    
    private func barColor(for level: CGFloat) -> Color {
        if level > 0.7 { return .red }
        if level > 0.4 { return .orange }
        return .accentColor
    }
}

// MARK: - RecordingCoordinator

/// Coordinates the live recording session: ties together AudioEngine, ASR, and diarization.
/// Singleton — models are loaded once at app startup and stay resident in memory.
@MainActor
final class RecordingCoordinator: ObservableObject {
    static let shared = RecordingCoordinator()
    
    // MARK: - Published State
    
    @Published var displaySegments: [TranscriptSegment] = []
    @Published var partialText: String = ""
    @Published var elapsedTime: TimeInterval = 0
    @Published var audioLevel: Float = 0
    @Published var isPaused: Bool = false
    @Published var speakerCount: Int = 0
    @Published var isRecording: Bool = false
    @Published var availableDevices: [AudioDeviceInfo] = []
    @Published var selectedDeviceID: AudioDeviceID?
    
    /// Diarization processing error, surfaced from RealTimeDiarizationService.
    @Published var diarizationError: String?
    
    // MARK: - Services
    
    /// Captures microphone audio (the primary user's voice).
    let audioEngine = AudioEngineManager()
    
    /// Captures system audio (remote participants via ScreenCaptureKit).
    let systemAudioCapture = SystemAudioCaptureManager()
    
    /// The active transcription service — swapped when the user changes ASR engine in Settings.
    private(set) var transcriptionService: any TranscriptionServiceProtocol
    let diarizationService = RealTimeDiarizationService()
    
    /// Which ASR engine is currently active.
    @Published var activeASREngine: ASREngine = ASREngine.current
    
    /// Whether the ML models are loaded and ready for instant recording.
    @Published var modelsReady: Bool = false
    @Published var modelLoadingStatus: String = ""
    
    /// The current meeting recording data.
    var recording: MeetingRecording?
    
    /// Source metadata for the current recording (set by auto-record orchestrator).
    var currentSourceApp: String?
    var currentSourceBundleID: String?
    var currentSourceType: MeetingSourceType = .manual
    
    /// Callback when recording stops (triggers post-meeting labeler).
    var onRecordingStopped: ((MeetingRecording) -> Void)?
    
    private var elapsedTimer: Timer?
    private var recordingStartDate: Date?
    private var isLoadingModels: Bool = false
    
    private init() {
        self.transcriptionService = Self.makeTranscriptionService(for: ASREngine.current)
    }
    
    // MARK: - Engine Factory
    
    /// Create the appropriate transcription service for the given engine.
    private static func makeTranscriptionService(for engine: ASREngine) -> any TranscriptionServiceProtocol {
        switch engine {
        case .fluidAudio:
            return StreamingTranscriptionService()
        case .appleSpeech:
            if #available(macOS 26, *) {
                return AppleSpeechTranscriptionService()
            } else {
                // Fallback if somehow selected on older OS
                print("[Dialogue] Apple Speech unavailable on this OS, falling back to FluidAudio")
                return StreamingTranscriptionService()
            }
        }
    }
    
    // MARK: - Engine Switching
    
    /// Switch to a different ASR engine. Tears down the old service,
    /// creates the new one, and loads its model.
    /// Called from SettingsView when the user changes the toggle.
    func switchASREngine(to engine: ASREngine) async {
        guard engine != activeASREngine, !isRecording else {
            if isRecording {
                print("[Dialogue] Cannot switch ASR engine while recording")
            }
            return
        }
        
        print("[Dialogue] Switching ASR engine: \(activeASREngine.displayName) → \(engine.displayName)")
        
        // Tear down old service
        transcriptionService.unloadModel()
        
        // Create new service
        let newService = Self.makeTranscriptionService(for: engine)
        self.transcriptionService = newService
        self.activeASREngine = engine
        self.modelsReady = false
        
        // Load the new engine's model
        modelLoadingStatus = "Loading \(engine.displayName)..."
        await newService.loadModel()
        
        modelsReady = newService.isReady
        modelLoadingStatus = ""
        
        if modelsReady {
            print("[Dialogue] ASR engine switched to \(engine.displayName) — ready")
        } else {
            print("[Dialogue] ASR engine switch to \(engine.displayName) failed: \(newService.errorMessage ?? "unknown error")")
        }
    }
    
    // MARK: - Model Loading
    
    /// Load ASR and diarization models into memory.
    /// Call once at app startup (after first-launch download completes).
    /// Models stay resident so recording starts instantly.
    func loadModelsIfNeeded() async {
        guard !modelsReady, !isLoadingModels else { return }
        isLoadingModels = true
        defer { isLoadingModels = false }
        
        print("[Dialogue] Pre-loading ML models (ASR engine: \(activeASREngine.displayName))...")
        
        // Load the selected ASR engine
        if !transcriptionService.isReady {
            modelLoadingStatus = "Loading \(activeASREngine.displayName)..."
            await transcriptionService.loadModel()
        }
        
        // Load FluidAudio diarization (always FluidAudio, regardless of ASR engine)
        if !diarizationService.isReady {
            modelLoadingStatus = "Loading speaker diarization..."
            await diarizationService.loadModels()
        }
        
        modelsReady = transcriptionService.isReady
        modelLoadingStatus = ""
        
        if modelsReady {
            print("[Dialogue] ML models pre-loaded — ready for instant recording (\(activeASREngine.displayName))")
        } else {
            print("[Dialogue] Model pre-load incomplete — ASR(\(activeASREngine.displayName))=\(transcriptionService.isReady), diarization=\(diarizationService.isReady)")
        }
    }
    
    // MARK: - Lifecycle
    
    /// Start a new recording session with source metadata (for auto-recording).
    func startRecording(
        sourceApp: String?,
        sourceBundleID: String?,
        sourceType: MeetingSourceType
    ) {
        self.currentSourceApp = sourceApp
        self.currentSourceBundleID = sourceBundleID
        self.currentSourceType = sourceType
        startRecording()
    }
    
    /// Start a new recording session.
    /// Captures both the default microphone (for "You") and system audio
    /// (for remote meeting participants) simultaneously. Both streams are
    /// mixed and forwarded to the ASR and diarization pipelines.
    func startRecording() {
        // Clean slate for each recording session
        resetSessionState()
        
        let meeting = MeetingRecording()
        self.recording = meeting
        
        // Configure audio engine
        availableDevices = AudioEngineManager.enumerateInputDevices()
        
        // Microphone audio → ASR (mic stream) + diarization (tagged as mic source).
        audioEngine.onAudioBuffer = { [weak self] samples, timestamp in
            Task { @MainActor [weak self] in
                self?.transcriptionService.appendMicAudio(samples: samples, timestamp: timestamp)
                self?.diarizationService.appendAudio(samples: samples, timestamp: timestamp, source: .mic)
            }
        }
        
        // System audio → ASR (system stream) + diarization (tagged as system source).
        // Each source gets its own StreamingAsrManager for a coherent audio stream.
        // The diarization service's SpeakerManager is shared, so speakers are
        // clustered across both sources.
        systemAudioCapture.onAudioBuffer = { [weak self] samples, timestamp in
            Task { @MainActor [weak self] in
                self?.transcriptionService.appendSystemAudio(samples: samples, timestamp: timestamp)
                self?.diarizationService.appendAudio(samples: samples, timestamp: timestamp, source: .system)
            }
        }
        
        transcriptionService.onFinalSegment = { [weak self] text, startTime, endTime in
            self?.handleFinalSegment(text: text, startTime: startTime, endTime: endTime)
        }
        
        transcriptionService.onPartialUpdate = { [weak self] text, _ in
            self?.partialText = text
        }
        
        diarizationService.onSpeakerSegment = { [weak self] label, clusterID, startTime, endTime, embedding in
            self?.handleSpeakerSegment(label: label, clusterID: clusterID, startTime: startTime, endTime: endTime, embedding: embedding)
        }
        
        // Surface diarization errors to the coordinator for UI display.
        diarizationService.onProcessingError = { [weak self] errorMsg in
            self?.diarizationError = errorMsg
            // Auto-clear after 10 seconds
            DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self] in
                if self?.diarizationError == errorMsg {
                    self?.diarizationError = nil
                }
            }
        }
        
        // Start services
        let audioURL = meeting.makeAudioFileURL()
        meeting.audioFileURL = audioURL
        
        // Start microphone capture
        do {
            try audioEngine.startCapture(writingTo: audioURL)
        } catch {
            print("[Dialogue] Failed to start microphone capture: \(error)")
            return
        }
        
        // Start system audio capture (best-effort; may fail if permission not granted)
        Task {
            do {
                try await systemAudioCapture.startCapture()
                print("[Dialogue] System audio capture started")
            } catch {
                // Non-fatal: meeting still works with mic-only.
                // The user just won't pick up remote participants unless
                // they have a virtual audio device like BlackHole set up.
                print("[Dialogue] System audio capture unavailable: \(error.localizedDescription). Mic-only mode.")
            }
        }
        
        transcriptionService.startStreaming()
        diarizationService.startSession()
        
        // Start elapsed timer
        recordingStartDate = Date()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self = self, let start = self.recordingStartDate else { return }
                self.elapsedTime = Date().timeIntervalSince(start)
                // Show the higher of mic or system audio level
                self.audioLevel = max(self.audioEngine.currentLevel, self.systemAudioCapture.currentLevel)
                self.speakerCount = self.diarizationService.speakerCount
            }
        }
        
        isRecording = true
        meeting.isRecording = true
    }
    
    /// Stop the recording and trigger post-meeting flow.
    func stopRecording() {
        guard isRecording else { return }
        
        elapsedTimer?.invalidate()
        elapsedTimer = nil
        
        audioEngine.stopCapture()
        
        Task {
            await systemAudioCapture.stopCapture()
            await transcriptionService.stopStreaming()
        }
        
        // Final reconciliation sweep for any remaining orphan segments.
        reconcileOrphanSegments()
        
        let detectedSpeakers = diarizationService.stopSession()
        
        // Persist any EMA embedding updates accumulated during this session.
        VoiceProfileManager.shared.persistPendingUpdates()
        
        if let meeting = recording {
            meeting.isRecording = false
            meeting.duration = elapsedTime
            meeting.segments = displaySegments
            meeting.detectedSpeakers = detectedSpeakers
            
            // Persist the meeting to disk
            MeetingStore.shared.saveMeeting(
                recording: meeting,
                sourceApp: currentSourceApp,
                sourceBundleID: currentSourceBundleID,
                sourceType: currentSourceType
            )
            
            onRecordingStopped?(meeting)
        }
        
        // Reset source metadata
        currentSourceApp = nil
        currentSourceBundleID = nil
        currentSourceType = .manual
        
        isRecording = false
    }
    
    /// Toggle pause state.
    func togglePause() {
        audioEngine.togglePause()
        isPaused = audioEngine.isPaused
    }
    
    // MARK: - Segment Handling
    
    /// Reset coordinator state between recording sessions.
    private func resetSessionState() {
        displaySegments.removeAll()
        partialText = ""
        elapsedTime = 0
        audioLevel = 0
        isPaused = false
        speakerCount = 0
        diarizationError = nil
        recentSpeakerLabels.removeAll()
        orphanSegments.removeAll()
        nextOrphanIndex = 1
        speakerColorMap.removeAll()
        nextColorIndex = 0
    }
    
    // MARK: - Segment Handling
    
    /// Handle a final transcript segment from ASR.
    /// Merges with the most recent diarization speaker label and links it
    /// to the diarization service's speaker-segment map.
    
    /// Temporary cluster prefix for segments that arrive before diarization has
    /// results. These are reconciled against the full speaker timeline at stop time.
    private static let orphanClusterPrefix = "orphan-"
    private var nextOrphanIndex: Int = 1
    
    /// Orphan segments: ASR segments that had no diarization match at creation time.
    /// Stored with their timestamps so we can retroactively match them when the
    /// diarizer catches up.
    private struct OrphanSegment {
        let segmentID: UUID
        let displaySegmentIndex: Int
        let orphanClusterID: String
        let startTime: TimeInterval
        let endTime: TimeInterval
    }
    private var orphanSegments: [OrphanSegment] = []
    
    private func handleFinalSegment(text: String, startTime: TimeInterval, endTime: TimeInterval) {
        // Find the most recent speaker entry active around this time
        let speakerEntry = currentSpeakerEntry(at: startTime)
        
        let speakerLabel: String
        let speakerClusterID: String
        var isOrphan = false
        
        if let entry = speakerEntry {
            speakerLabel = entry.label
            speakerClusterID = entry.clusterID
        } else {
            // No diarization result overlaps this segment yet. Assign a temporary
            // per-orphan cluster ID. These will be reconciled against the full
            // diarization timeline when the recording stops.
            let orphanID = Self.orphanClusterPrefix + "\(nextOrphanIndex)"
            nextOrphanIndex += 1
            speakerLabel = "Speaker ?"
            speakerClusterID = orphanID
            isOrphan = true
        }
        
        let colorIndex = speakerColorIndex(for: speakerLabel)
        
        var segment = TranscriptSegment(
            speakerLabel: speakerLabel,
            speakerProfileID: speakerClusterID,
            text: text,
            startTime: startTime,
            endTime: endTime,
            isPartial: false
        )
        segment.speakerColorIndex = colorIndex
        
        let segmentIndex = displaySegments.count
        displaySegments.append(segment)
        recording?.upsertSegment(segment)
        
        // Link segment ID to the speaker in the diarization service
        diarizationService.linkSegment(id: segment.id, toSpeaker: speakerClusterID)
        
        if isOrphan {
            orphanSegments.append(OrphanSegment(
                segmentID: segment.id,
                displaySegmentIndex: segmentIndex,
                orphanClusterID: speakerClusterID,
                startTime: startTime,
                endTime: endTime
            ))
        }
        
        partialText = ""
    }
    
    /// Handle a speaker segment from diarization (used to track who's speaking when).
    private struct SpeakerEntry {
        let label: String
        let clusterID: String
        let startTime: TimeInterval
        let endTime: TimeInterval
    }
    
    /// Capped recent entries for fast real-time lookup during recording.
    private var recentSpeakerLabels: [SpeakerEntry] = []
    
    private func handleSpeakerSegment(label: String, clusterID: String, startTime: TimeInterval, endTime: TimeInterval, embedding: [Float]) {
        let entry = SpeakerEntry(
            label: label,
            clusterID: clusterID,
            startTime: startTime,
            endTime: endTime
        )
        
        recentSpeakerLabels.append(entry)
        
        // Cap the real-time lookup list
        if recentSpeakerLabels.count > 200 {
            recentSpeakerLabels.removeFirst(recentSpeakerLabels.count - 200)
        }
        
        // Each time new diarization results arrive, try to resolve any pending
        // orphan segments. The diarization service's voice-identified speaker
        // timeline now has new entries, so orphans from the first ~10s (before
        // the diarizer's first chunk completed) can be matched to proper
        // voice clusters.
        if !orphanSegments.isEmpty {
            reconcileOrphanSegments()
        }
    }
    
    /// Look up the most likely speaker entry for a given timestamp.
    private func currentSpeakerEntry(at timestamp: TimeInterval) -> SpeakerEntry? {
        // Find the speaker segment that overlaps with this timestamp
        for entry in recentSpeakerLabels.reversed() {
            if timestamp >= entry.startTime && timestamp <= entry.endTime + 2.0 {
                return entry
            }
        }
        // Fall back to the most recent speaker
        return recentSpeakerLabels.last
    }
    
    // MARK: - Orphan Reconciliation
    
    /// Try to match orphan segments against the diarization service's
    /// voice-identified speaker timeline.
    ///
    /// The diarization service maintains the authoritative record of which
    /// voice cluster was active at each point in time (determined by voice
    /// embedding analysis, not just timestamps). This method queries that
    /// record to resolve orphans to their correct speaker.
    ///
    /// Called incrementally from `handleSpeakerSegment` as new diarization
    /// results arrive, and as a final sweep from `stopRecording`.
    private func reconcileOrphanSegments() {
        guard !orphanSegments.isEmpty else { return }
        
        var resolved: [Int] = []
        
        for (idx, orphan) in orphanSegments.enumerated() {
            // Ask the diarization service which voice-identified speaker cluster
            // was active during this orphan's time range.
            guard let match = diarizationService.findSpeaker(
                startTime: orphan.startTime,
                endTime: orphan.endTime
            ) else {
                continue  // No diarization coverage yet — try again later
            }
            
            // Relink the segment from its temporary orphan cluster to the
            // voice-identified cluster
            diarizationService.relinkSegment(
                id: orphan.segmentID,
                from: orphan.orphanClusterID,
                to: match.speakerID
            )
            
            // Update the display segment's speaker info
            let colorIndex = speakerColorIndex(for: match.label)
            if orphan.displaySegmentIndex < displaySegments.count,
               displaySegments[orphan.displaySegmentIndex].id == orphan.segmentID {
                displaySegments[orphan.displaySegmentIndex].speakerLabel = match.label
                displaySegments[orphan.displaySegmentIndex].speakerProfileID = match.speakerID
                displaySegments[orphan.displaySegmentIndex].speakerColorIndex = colorIndex
            }
            
            // Also update in the recording's segment list
            if let seg = displaySegments.first(where: { $0.id == orphan.segmentID }) {
                recording?.upsertSegment(seg)
            }
            
            resolved.append(idx)
        }
        
        if !resolved.isEmpty {
            for idx in resolved.reversed() {
                orphanSegments.remove(at: idx)
            }
            print("[Dialogue] Reconciled \(resolved.count) orphan segment(s), \(orphanSegments.count) remaining")
        }
    }
    
    /// Map speaker labels to consistent color indices.
    private var speakerColorMap: [String: Int] = [:]
    private var nextColorIndex: Int = 0
    
    private func speakerColorIndex(for label: String) -> Int {
        if let idx = speakerColorMap[label] { return idx }
        let idx = nextColorIndex
        speakerColorMap[label] = idx
        nextColorIndex += 1
        return idx
    }
}
