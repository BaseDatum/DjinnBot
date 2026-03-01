import Foundation
import FluidAudio
import CoreML
import Accelerate

// MARK: - RealTimeDiarizationService

/// Wraps FluidAudio's DiarizerManager for real-time speaker diarization.
///
/// Architecture (matches FluidAudio reference implementation):
/// 1. Audio arrives from mic and system sources
/// 2. VAD (Silero) filters out silence/noise per 256ms chunk
/// 3. Speech-only samples are written to per-source AudioStreams
///    (5s chunks, 3s skip = 2s overlap — FluidAudio recommended config)
/// 4. AudioStream fires a callback when a chunk is ready
/// 5. Chunks are dispatched to a serial processing queue for fair scheduling
/// 6. DiarizerManager processes the chunk (segmentation → embedding → clustering)
/// 7. Results are emitted via onSpeakerSegment callback
///
/// Key design decisions:
/// - One DiarizerManager/SpeakerManager shared across mic and system audio
///   so speakers are correlated across sources (user's voice on mic matches
///   their voice on system audio if it leaks).
/// - Separate AudioStream per source to avoid mixing audio characteristics.
/// - VAD preprocessing reduces false speakers by 20-40% (FluidAudio docs).
/// - Enrolled voice profiles are seeded into SpeakerManager at session start
///   via `initializeKnownSpeakers()` and marked permanent, so the diarizer
///   recognizes known speakers during clustering (not just post-hoc).
/// - Unknown speakers are periodically re-evaluated against enrolled profiles
///   as their embeddings improve with more audio data.
@MainActor
final class RealTimeDiarizationService: ObservableObject {
    
    // MARK: - Published State
    
    @Published var isReady: Bool = false
    @Published var speakerCount: Int = 0
    @Published var errorMessage: String?
    @Published var lastProcessingError: String?
    @Published var lastTimings: DiarizationTimingSnapshot?
    
    // MARK: - Callbacks
    
    var onSpeakerSegment: ((_ label: String, _ clusterID: String, _ startTime: TimeInterval, _ endTime: TimeInterval, _ embedding: [Float]) -> Void)?
    var onProcessingError: ((_ error: String) -> Void)?
    
    // MARK: - Private: Core Components
    
    private var diarizerManager: DiarizerManager?
    private let profileManager: VoiceProfileManager
    private let diarizationSettings: DiarizationSettings
    private var cachedModels: DiarizerModels?
    
    /// VAD manager for filtering silence/noise before diarization.
    /// Reduces false speakers by 20-40% per FluidAudio docs.
    private var vadManager: VadManager?
    
    /// Per-source AudioStreams (5s chunks, 3s skip = 2s overlap).
    /// Using FluidAudio's AudioStream instead of custom buffer management
    /// provides proper chunk overlap for speaker continuity across boundaries.
    private var micStream: AudioStream?
    private var sysStream: AudioStream?
    
    /// Per-source VAD state for streaming voice activity detection.
    private var micVadState: VadStreamState = .initial()
    private var sysVadState: VadStreamState = .initial()
    
    /// Per-source VAD buffers: accumulate samples until we have 4096 (256ms at 16kHz).
    private var micVadBuffer: [Float] = []
    private var sysVadBuffer: [Float] = []
    
    /// Whether each source is currently in a speech region (VAD hysteresis).
    private var micInSpeech: Bool = false
    private var sysInSpeech: Bool = false
    
    /// Serial queue for fair chunk processing. Both sources submit chunks here
    /// so neither starves the other, and DiarizerManager isn't accessed concurrently.
    private let processingQueue = DispatchQueue(label: "bot.djinn.dialogue.diarization", qos: .userInitiated)
    
    /// Serial queues for VAD processing — one per source to prevent race
    /// conditions on VAD state while preserving audio chunk ordering.
    private let micVadQueue = DispatchQueue(label: "bot.djinn.dialogue.vad.mic", qos: .userInitiated)
    private let sysVadQueue = DispatchQueue(label: "bot.djinn.dialogue.vad.sys", qos: .userInitiated)
    
    /// Speaker label mapping from FluidAudio speaker IDs to display labels.
    private var speakerLabelMap: [String: String] = [:]
    private var nextUnknownIndex: Int = 1
    
    /// Track which FluidAudio speaker IDs produced which transcript segment IDs.
    private var speakerSegmentMap: [String: [UUID]] = [:]
    
    /// Voice-identified speaker timeline.
    struct VoiceIdentifiedEntry {
        let speakerID: String
        let label: String
        let startTime: TimeInterval
        let endTime: TimeInterval
    }
    private(set) var speakerTimeline: [VoiceIdentifiedEntry] = []
    
    /// Maps diarizer speaker IDs to matched voice profile IDs.
    private var speakerToProfileMap: [String: String] = [:]
    
    /// Consecutive error counter for backoff.
    private var consecutiveErrors: Int = 0
    private static let maxConsecutiveErrors = 5
    
    /// Inactivity pruning.
    private var lastPruneDate: Date = Date()
    private static let pruneInterval: TimeInterval = 600
    private static let pruneCheckInterval: TimeInterval = 120
    
    // MARK: - Init
    
    nonisolated init(profileManager: VoiceProfileManager? = nil, diarizationSettings: DiarizationSettings? = nil) {
        self.profileManager = profileManager ?? VoiceProfileManager.shared
        self.diarizationSettings = diarizationSettings ?? DiarizationSettings.shared
    }
    
    // MARK: - Model Loading
    
    func loadModels() async {
        do {
            let models = try await DiarizerModels.download(
                configuration: Self.optimizedModelConfiguration()
            )
            cachedModels = models
            
            let threshold = Float(diarizationSettings.clusteringThreshold)
            let config = Self.makeConfig(threshold: threshold, settings: diarizationSettings)
            let manager = DiarizerManager(config: config)
            manager.initialize(models: models)
            
            // Override DiarizerManager's inflated thresholds (clusteringThreshold * 1.2)
            // back to documented SpeakerManager defaults.
            Self.applySpeakerThresholds(manager: manager, settings: diarizationSettings)
            
            self.diarizerManager = manager
            
            // Load VAD model for speech filtering
            do {
                let vad = try await VadManager(config: VadConfig(defaultThreshold: 0.5))
                self.vadManager = vad
                print("[Dialogue] VAD loaded for speech filtering")
            } catch {
                print("[Dialogue] VAD load failed (diarization will proceed without VAD): \(error)")
            }
            
            isReady = true
            errorMessage = nil
            print("[Dialogue] FluidAudio diarizer loaded (speakerThreshold: \(manager.speakerManager.speakerThreshold), embeddingThreshold: \(manager.speakerManager.embeddingThreshold), chunk: \(config.chunkDuration)s)")
        } catch {
            errorMessage = "Failed to load diarization models: \(error.localizedDescription)"
            print("[Dialogue] FluidAudio load error: \(error)")
        }
    }
    
    private static func optimizedModelConfiguration() -> MLModelConfiguration {
        let config = MLModelConfiguration()
        config.allowLowPrecisionAccumulationOnGPU = true
        let isCI = ProcessInfo.processInfo.environment["CI"] != nil
        config.computeUnits = isCI ? .cpuAndNeuralEngine : .all
        return config
    }
    
    /// Override DiarizerManager's inflated SpeakerManager thresholds.
    ///
    /// DiarizerManager sets speakerThreshold = clusteringThreshold * 1.2.
    /// At default 0.7, that gives 0.84 — in the "create new speaker" range
    /// per FluidAudio's cosine distance docs. We use the threshold directly.
    ///
    /// Cosine distance interpretation (FluidAudio SpeakerManager docs):
    ///   < 0.3  = Very high confidence match
    ///   0.3-0.5 = Strong match
    ///   0.5-0.7 = Threshold zone
    ///   0.7-0.9 = Should create new speaker
    ///   > 0.9  = Clearly different
    private static func applySpeakerThresholds(manager: DiarizerManager, settings: DiarizationSettings) {
        let threshold = Float(settings.clusteringThreshold)
        manager.speakerManager.speakerThreshold = threshold
        // embeddingThreshold: SpeakerManager default 0.45; scale proportionally
        // to the clustering threshold. At 0.65 → 0.45 (FluidAudio default).
        manager.speakerManager.embeddingThreshold = min(threshold * 0.70, 0.50)
    }
    
    private static func makeConfig(threshold: Float, settings: DiarizationSettings) -> DiarizerConfig {
        DiarizerConfig(
            clusteringThreshold: threshold,
            minSpeechDuration: Float(settings.minSpeechDuration),
            minEmbeddingUpdateDuration: 2.0,
            minSilenceGap: 0.5,
            numClusters: -1,
            minActiveFramesCount: 10.0,
            debugMode: false,
            chunkDuration: Float(settings.chunkDuration),
            chunkOverlap: 0.0
        )
    }
    
    func applySettings() {
        guard let models = cachedModels else { return }
        
        let threshold = Float(diarizationSettings.clusteringThreshold)
        let config = Self.makeConfig(threshold: threshold, settings: diarizationSettings)
        let manager = DiarizerManager(config: config)
        manager.initialize(models: models)
        Self.applySpeakerThresholds(manager: manager, settings: diarizationSettings)
        
        self.diarizerManager = manager
        print("[Dialogue] Diarizer settings applied (speakerThreshold: \(manager.speakerManager.speakerThreshold), embeddingThreshold: \(manager.speakerManager.embeddingThreshold), chunk: \(config.chunkDuration)s)")
    }
    
    // MARK: - Session Management
    
    func startSession() {
        // Tear down old streams
        micStream?.unbind()
        sysStream?.unbind()
        micStream = nil
        sysStream = nil
        
        // Reset state
        micVadBuffer.removeAll(keepingCapacity: true)
        sysVadBuffer.removeAll(keepingCapacity: true)
        micVadState = .initial()
        sysVadState = .initial()
        micInSpeech = false
        sysInSpeech = false
        speakerLabelMap.removeAll()
        speakerSegmentMap.removeAll()
        speakerTimeline.removeAll()
        speakerToProfileMap.removeAll()
        nextUnknownIndex = 1
        speakerCount = 0
        consecutiveErrors = 0
        lastProcessingError = nil
        lastTimings = nil
        lastPruneDate = Date()
        
        guard let manager = diarizerManager else { return }
        
        // Seed enrolled voice profiles into the SpeakerManager so the diarizer
        // recognizes known speakers during clustering (not just post-hoc).
        // This dramatically improves recognition accuracy because the clustering
        // engine compares incoming audio against known embeddings at assignment time.
        seedEnrolledProfiles(into: manager)
        
        // Create per-source AudioStreams with FluidAudio's recommended streaming config:
        // 5s chunks, 3s skip (= 2s overlap for speaker continuity across boundaries).
        let chunkDuration = diarizationSettings.chunkDuration
        let chunkSkip = max(chunkDuration * 0.6, 2.0) // 60% of chunk duration, min 2s
        
        do {
            let mic = try AudioStream(
                chunkDuration: chunkDuration,
                chunkSkip: chunkSkip,
                streamStartTime: 0.0,
                chunkingStrategy: .useFixedSkip,
                startupStrategy: .waitForFullChunk,
                sampleRate: 16000
            )
            mic.bind { [weak self] (chunk: [Float], time: TimeInterval) in
                self?.enqueueChunk(chunk, atTime: time, source: .mic)
            }
            micStream = mic
            
            let sys = try AudioStream(
                chunkDuration: chunkDuration,
                chunkSkip: chunkSkip,
                streamStartTime: 0.0,
                chunkingStrategy: .useFixedSkip,
                startupStrategy: .waitForFullChunk,
                sampleRate: 16000
            )
            sys.bind { [weak self] (chunk: [Float], time: TimeInterval) in
                self?.enqueueChunk(chunk, atTime: time, source: .system)
            }
            sysStream = sys
            
            print("[Dialogue] Diarization session started (chunk: \(chunkDuration)s, skip: \(String(format: "%.1f", chunkSkip))s, overlap: \(String(format: "%.1f", chunkDuration - chunkSkip))s, \(profileManager.profiles.count) enrolled profile(s))")
        } catch {
            print("[Dialogue] Failed to create AudioStreams: \(error)")
        }
    }
    
    func stopSession() -> [DetectedSpeaker] {
        micStream?.unbind()
        sysStream?.unbind()
        micStream = nil
        sysStream = nil
        
        guard let manager = diarizerManager else { return [] }
        
        let allSpeakers = manager.speakerManager.getAllSpeakers()
        let knownClusterIDs = Set(allSpeakers.map { $0.0 })
        
        var colorIdx = 0
        var speakers = allSpeakers.map { (id, speaker) -> DetectedSpeaker in
            let label = speakerLabelMap[id] ?? speaker.name
            let segIDs = speakerSegmentMap[id] ?? []
            let matchedProfile = profileManager.matchSpeaker(embedding: speaker.currentEmbedding)
            let isKnown = matchedProfile != nil
            let displayLabel = matchedProfile?.displayName ?? label
            
            let thisColor: Int
            if isKnown && displayLabel == "You" {
                thisColor = 0
            } else {
                colorIdx += 1
                thisColor = colorIdx
            }
            
            return DetectedSpeaker(
                id: id,
                label: displayLabel,
                profileID: matchedProfile?.id,
                representativeEmbedding: speaker.currentEmbedding,
                segmentIDs: segIDs,
                isIdentified: isKnown,
                colorIndex: thisColor
            )
        }
        
        // Include orphaned speakers
        for (clusterID, segIDs) in speakerSegmentMap where !knownClusterIDs.contains(clusterID) {
            guard !segIDs.isEmpty else { continue }
            let label = speakerLabelMap[clusterID] ?? "Speaker ?"
            colorIdx += 1
            speakers.append(DetectedSpeaker(
                id: clusterID,
                label: label,
                profileID: nil,
                representativeEmbedding: [],
                segmentIDs: segIDs,
                isIdentified: false,
                colorIndex: colorIdx
            ))
        }
        
        print("[Dialogue] Diarization session ended — \(speakers.count) speaker(s) detected: \(speakers.map { "\($0.label) (\($0.segmentIDs.count) segs)" })")
        return speakers
    }
    
    // MARK: - Segment Tracking
    
    func linkSegment(id: UUID, toSpeaker speakerID: String) {
        speakerSegmentMap[speakerID, default: []].append(id)
    }
    
    func relinkSegment(id: UUID, from oldSpeakerID: String, to newSpeakerID: String) {
        speakerSegmentMap[oldSpeakerID]?.removeAll { $0 == id }
        if speakerSegmentMap[oldSpeakerID]?.isEmpty == true {
            speakerSegmentMap.removeValue(forKey: oldSpeakerID)
        }
        speakerSegmentMap[newSpeakerID, default: []].append(id)
    }
    
    // MARK: - Speaker Timeline Lookup
    
    func findSpeaker(startTime: TimeInterval, endTime: TimeInterval) -> (speakerID: String, label: String)? {
        guard !speakerTimeline.isEmpty else { return nil }
        
        var bestEntry: VoiceIdentifiedEntry?
        var bestOverlap: TimeInterval = 0
        
        for entry in speakerTimeline {
            let overlapStart = max(startTime, entry.startTime)
            let overlapEnd = min(endTime, entry.endTime)
            let overlap = overlapEnd - overlapStart
            if overlap > bestOverlap {
                bestOverlap = overlap
                bestEntry = entry
            }
        }
        
        if bestEntry == nil {
            var closestDist: TimeInterval = .infinity
            for entry in speakerTimeline {
                let dist = min(
                    abs(startTime - entry.startTime),
                    abs(startTime - entry.endTime),
                    abs(endTime - entry.startTime)
                )
                if dist < closestDist {
                    closestDist = dist
                    bestEntry = entry
                }
            }
        }
        
        guard let matched = bestEntry else { return nil }
        return (speakerID: matched.speakerID, label: matched.label)
    }
    
    // MARK: - Audio Input (VAD → AudioStream)
    
    enum AudioSource { case mic, system }
    
    /// Feed audio samples from a source. Samples are VAD-filtered, then
    /// forwarded to the per-source AudioStream which handles chunking and overlap.
    func appendAudio(samples: [Float], timestamp: TimeInterval, source: AudioSource = .mic) {
        guard consecutiveErrors < Self.maxConsecutiveErrors else { return }
        
        switch source {
        case .mic:
            micVadBuffer.append(contentsOf: samples)
            processVadBuffer(source: .mic)
        case .system:
            sysVadBuffer.append(contentsOf: samples)
            processVadBuffer(source: .system)
        }
    }
    
    /// Process the VAD buffer for a source: run VAD on each 4096-sample chunk,
    /// and forward speech-containing samples to the AudioStream.
    private func processVadBuffer(source: AudioSource) {
        let vadChunkSize = VadManager.chunkSize // 4096 samples = 256ms at 16kHz
        
        let buffer: [Float]
        switch source {
        case .mic:    buffer = micVadBuffer
        case .system: buffer = sysVadBuffer
        }
        
        var offset = 0
        var chunks: [[Float]] = []
        while offset + vadChunkSize <= buffer.count {
            chunks.append(Array(buffer[offset..<(offset + vadChunkSize)]))
            offset += vadChunkSize
        }
        
        // Keep unprocessed remainder
        switch source {
        case .mic:    micVadBuffer = Array(buffer[offset...])
        case .system: sysVadBuffer = Array(buffer[offset...])
        }
        
        guard !chunks.isEmpty else { return }
        
        // Process VAD chunks serially per source to prevent state races.
        // Each source has its own serial queue so mic and system VAD
        // run concurrently but chunks within a source stay ordered.
        if let vad = vadManager {
            let vadQueue = source == .mic ? micVadQueue : sysVadQueue
            let capturedSource = source
            let capturedChunks = chunks
            
            vadQueue.async { [weak self] in
                guard let self = self else { return }
                Task { @MainActor [weak self] in
                    guard let self = self else { return }
                    for chunk in capturedChunks {
                        let currentState: VadStreamState
                        switch capturedSource {
                        case .mic:    currentState = self.micVadState
                        case .system: currentState = self.sysVadState
                        }
                        
                        do {
                            let result = try await vad.processStreamingChunk(
                                chunk,
                                state: currentState,
                                returnSeconds: true
                            )
                            self.handleVadResult(result, chunk: chunk, source: capturedSource)
                        } catch {
                            self.forwardToStream(chunk, source: capturedSource)
                        }
                    }
                }
            }
        } else {
            // No VAD available — pass all audio through
            for chunk in chunks {
                forwardToStream(chunk, source: source)
            }
        }
    }
    
    /// Handle a VAD streaming result: update speech state and forward speech to AudioStream.
    private func handleVadResult(_ result: VadStreamResult, chunk: [Float], source: AudioSource) {
        switch source {
        case .mic:
            micVadState = result.state
            if let event = result.event {
                micInSpeech = event.isStart
            }
            // Forward if we're in a speech region OR probability is above a lenient threshold
            // (use 0.3 to capture leading edges that the hysteresis hasn't triggered yet)
            if micInSpeech || result.probability > 0.3 {
                forwardToStream(chunk, source: .mic)
            }
        case .system:
            sysVadState = result.state
            if let event = result.event {
                sysInSpeech = event.isStart
            }
            if sysInSpeech || result.probability > 0.3 {
                forwardToStream(chunk, source: .system)
            }
        }
    }
    
    /// Write speech samples to the appropriate AudioStream.
    private func forwardToStream(_ samples: [Float], source: AudioSource) {
        do {
            switch source {
            case .mic:    try micStream?.write(from: samples)
            case .system: try sysStream?.write(from: samples)
            }
        } catch {
            // AudioStream write errors are non-fatal
        }
    }
    
    // MARK: - Chunk Processing
    
    /// Enqueue a chunk from AudioStream for diarization.
    /// Called from the AudioStream callback (background thread).
    /// Uses the serial processingQueue for fair scheduling between sources.
    nonisolated private func enqueueChunk(_ chunk: [Float], atTime time: TimeInterval, source: AudioSource) {
        processingQueue.async { [weak self] in
            guard let self = self else { return }
            Task { @MainActor in
                await self.processChunk(chunk, atTime: time, source: source)
            }
        }
    }
    
    private func processChunk(_ chunk: [Float], atTime time: TimeInterval, source: AudioSource) async {
        guard let manager = diarizerManager else { return }
        
        // Validate audio quality before inference
        let validation = manager.validateAudio(chunk)
        guard validation.isValid else { return }
        
        let inferenceStart = Date()
        
        do {
            let result = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<DiarizationResult, Error>) in
                processingQueue.async {
                    do {
                        let r = try manager.performCompleteDiarization(
                            chunk,
                            sampleRate: 16000,
                            atTime: time
                        )
                        continuation.resume(returning: r)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
            
            let processingTime = Date().timeIntervalSince(inferenceStart)
            
            lastTimings = DiarizationTimingSnapshot(
                chunkDurationSeconds: Double(chunk.count) / 16000.0,
                processingTimeSeconds: processingTime,
                segmentCount: result.segments.count,
                pipelineTimings: result.timings
            )
            
            for segment in result.segments {
                let speakerID = segment.speakerId
                let embedding = segment.embedding
                let segStartTime = TimeInterval(segment.startTimeSeconds)
                let segEndTime = TimeInterval(segment.endTimeSeconds)
                
                let label = resolveLabel(for: speakerID)
                
                speakerTimeline.append(VoiceIdentifiedEntry(
                    speakerID: speakerID,
                    label: label,
                    startTime: segStartTime,
                    endTime: segEndTime
                ))
                
                updateKnownSpeakerEmbedding(speakerID: speakerID, newEmbedding: embedding)
                onSpeakerSegment?(label, speakerID, segStartTime, segEndTime, embedding)
            }
            
            speakerCount = manager.speakerManager.speakerCount
            consecutiveErrors = 0
            lastProcessingError = nil
            pruneInactiveSpeakersIfNeeded()
            
        } catch {
            consecutiveErrors += 1
            let errorMsg = "Diarization error (\(source), attempt \(consecutiveErrors)): \(error.localizedDescription)"
            print("[Dialogue] \(errorMsg)")
            lastProcessingError = errorMsg
            onProcessingError?(errorMsg)
            
            if consecutiveErrors >= Self.maxConsecutiveErrors {
                let msg = "Diarization suspended after \(Self.maxConsecutiveErrors) consecutive failures"
                print("[Dialogue] \(msg)")
                lastProcessingError = msg
                onProcessingError?(msg)
            }
        }
    }
    
    // MARK: - Speaker Merge
    
    func findMergeableSpeakerPairs() -> [(sourceID: String, destinationID: String)] {
        guard let manager = diarizerManager else { return [] }
        return manager.speakerManager.findMergeablePairs().map {
            (sourceID: $0.speakerToMerge, destinationID: $0.destination)
        }
    }
    
    func mergeSpeakers(sourceID: String, into destinationID: String) {
        guard let manager = diarizerManager else { return }
        manager.speakerManager.mergeSpeaker(sourceID, into: destinationID)
        let sourceSegments = speakerSegmentMap.removeValue(forKey: sourceID) ?? []
        speakerSegmentMap[destinationID, default: []].append(contentsOf: sourceSegments)
        speakerLabelMap.removeValue(forKey: sourceID)
        speakerCount = manager.speakerManager.speakerCount
    }
    
    // MARK: - EMA Embedding Updates
    
    private func updateKnownSpeakerEmbedding(speakerID: String, newEmbedding: [Float]) {
        guard let profileID = speakerToProfileMap[speakerID],
              let profile = profileManager.profiles.first(where: { $0.id == profileID }) else { return }
        guard newEmbedding.count == profile.embedding.count else { return }
        
        var sumSquares: Float = 0
        vDSP_svesq(newEmbedding, 1, &sumSquares, vDSP_Length(newEmbedding.count))
        guard sumSquares > 0.01 else { return }
        
        profileManager.updateEmbeddingEMA(profileID: profileID, newEmbedding: newEmbedding)
    }
    
    // MARK: - Inactivity Pruning
    
    private func pruneInactiveSpeakersIfNeeded() {
        let now = Date()
        guard now.timeIntervalSince(lastPruneDate) >= Self.pruneCheckInterval else { return }
        lastPruneDate = now
        
        guard let manager = diarizerManager else { return }
        let beforeCount = manager.speakerManager.speakerCount
        manager.speakerManager.removeSpeakersInactive(for: Self.pruneInterval, keepIfPermanent: true)
        let afterCount = manager.speakerManager.speakerCount
        
        if beforeCount != afterCount {
            speakerCount = afterCount
            print("[Dialogue] Pruned \(beforeCount - afterCount) inactive speaker(s)")
        }
    }
    
    // MARK: - Enrolled Speaker Seeding
    
    /// Seed enrolled voice profiles into FluidAudio's SpeakerManager so the
    /// diarizer recognizes them during clustering, not just post-hoc.
    ///
    /// This converts VoiceProfile objects into FluidAudio Speaker objects,
    /// loads them via `initializeKnownSpeakers()`, and marks them as permanent
    /// so they survive pruning and merging.
    private func seedEnrolledProfiles(into manager: DiarizerManager) {
        let profiles = profileManager.profiles
        guard !profiles.isEmpty else {
            manager.speakerManager.reset(keepIfPermanent: false)
            return
        }
        
        var knownSpeakers: [Speaker] = []
        for profile in profiles {
            guard !profile.embedding.isEmpty else { continue }
            let speaker = Speaker(
                id: profile.id,
                name: profile.displayName,
                currentEmbedding: profile.embedding
            )
            knownSpeakers.append(speaker)
        }
        
        if knownSpeakers.isEmpty {
            manager.speakerManager.reset(keepIfPermanent: false)
            return
        }
        
        // Reset and load enrolled speakers. Using .reset mode clears any stale
        // data and loads fresh profiles. preserveIfPermanent is false because
        // we want a clean slate with only our enrolled profiles.
        manager.speakerManager.initializeKnownSpeakers(
            knownSpeakers,
            mode: .reset,
            preserveIfPermanent: false
        )
        
        // Mark enrolled speakers as permanent so they survive pruning/merging.
        for speaker in knownSpeakers {
            manager.speakerManager.makeSpeakerPermanent(speaker.id)
            speakerLabelMap[speaker.id] = speaker.name
            speakerToProfileMap[speaker.id] = speaker.id
        }
        
        print("[Dialogue] Seeded \(knownSpeakers.count) enrolled profile(s) into SpeakerManager: \(knownSpeakers.map { $0.name })")
    }
    
    // MARK: - Speaker Label Resolution
    
    private func resolveLabel(for speakerID: String) -> String {
        if let label = speakerLabelMap[speakerID] {
            // For enrolled speakers, the label is already set during seeding.
            // For unknown speakers, re-evaluate periodically in case the
            // embedding has drifted to match a known profile.
            if !speakerToProfileMap.keys.contains(speakerID) {
                // Re-check unknown speakers against enrolled profiles
                if let manager = diarizerManager,
                   let speaker = manager.speakerManager.getSpeaker(for: speakerID) {
                    if let matchedProfile = profileManager.matchSpeaker(embedding: speaker.currentEmbedding) {
                        let newLabel = matchedProfile.displayName
                        if newLabel != label {
                            speakerLabelMap[speakerID] = newLabel
                            speakerToProfileMap[speakerID] = matchedProfile.id
                            print("[Dialogue] Speaker \(speakerID) re-identified as \"\(newLabel)\" (was \"\(label)\")")
                            return newLabel
                        }
                    }
                }
            }
            return label
        }
        
        // First-time resolution: check if this is a seeded enrolled speaker
        // (their labels were set during seedEnrolledProfiles, so this path
        // handles speakers created by the diarizer during the session).
        if let manager = diarizerManager,
           let speaker = manager.speakerManager.getSpeaker(for: speakerID) {
            if let matchedProfile = profileManager.matchSpeaker(embedding: speaker.currentEmbedding) {
                let label = matchedProfile.displayName
                speakerLabelMap[speakerID] = label
                speakerToProfileMap[speakerID] = matchedProfile.id
                print("[Dialogue] Speaker \(speakerID) identified as \"\(label)\" (voice match)")
                return label
            }
        }
        
        let label = "Speaker \(nextUnknownIndex)"
        speakerLabelMap[speakerID] = label
        nextUnknownIndex += 1
        return label
    }
}

// MARK: - Pipeline Timing Snapshot

struct DiarizationTimingSnapshot: Sendable {
    let chunkDurationSeconds: Double
    let processingTimeSeconds: Double
    let segmentCount: Int
    let pipelineTimings: PipelineTimings?
    
    var realtimeFactor: Double {
        guard chunkDurationSeconds > 0 else { return 0 }
        return processingTimeSeconds / chunkDurationSeconds
    }
}
