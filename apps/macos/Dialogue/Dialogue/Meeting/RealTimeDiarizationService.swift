import Foundation
import FluidAudio
import CoreML
import Accelerate

// MARK: - RealTimeDiarizationService

/// Wraps FluidAudio's DiarizerManager for real-time speaker diarization and embedding extraction.
/// Processes audio chunks incrementally, maintains speaker clusters,
/// and identifies known speakers via VoiceProfileManager.
///
/// Enhancements over baseline:
/// - MLModelConfiguration tuning (Float16 GPU, ANE)
/// - Audio validation before processing
/// - Configurable chunk size with overlap
/// - Structured error surfacing
/// - Heavy processing off MainActor via a dedicated queue
/// - Zero-copy buffer patterns with pre-allocated chunk buffer
/// - Pipeline timing instrumentation
/// - Inactivity pruning for long meetings
@MainActor
final class RealTimeDiarizationService: ObservableObject {
    
    // MARK: - Published State
    
    /// Whether the diarization models are loaded and ready.
    @Published var isReady: Bool = false
    
    /// Number of distinct speakers detected so far.
    @Published var speakerCount: Int = 0
    
    /// Error message if loading fails.
    @Published var errorMessage: String?
    
    /// Most recent chunk processing error (surfaced to UI, auto-clears).
    @Published var lastProcessingError: String?
    
    /// Last pipeline timings for diagnostics.
    @Published var lastTimings: DiarizationTimingSnapshot?
    
    // MARK: - Callbacks
    
    /// Called when a speaker segment is identified.
    /// Parameters: (speakerLabel, speakerClusterID, startTime, endTime, embedding)
    var onSpeakerSegment: ((_ label: String, _ clusterID: String, _ startTime: TimeInterval, _ endTime: TimeInterval, _ embedding: [Float]) -> Void)?
    
    /// Called when a processing error occurs (allows coordinator to react).
    var onProcessingError: ((_ error: String) -> Void)?
    
    // MARK: - Private
    
    private var diarizerManager: DiarizerManager?
    private let profileManager: VoiceProfileManager
    private let diarizationSettings: DiarizationSettings
    
    /// Cached models so we can re-create the manager when settings change.
    private var cachedModels: DiarizerModels?
    
    /// Dedicated processing queue -- keeps heavy diarization inference off the main actor.
    private let processingQueue = DispatchQueue(label: "bot.djinn.dialogue.diarization", qos: .userInitiated)
    
    /// Separate audio buffers for each source so the diarizer processes
    /// coherent audio streams. Both share the same DiarizerManager (and
    /// therefore the same SpeakerManager), so speakers are clustered
    /// across sources.
    private var micBuffer: [Float] = []
    private var sysBuffer: [Float] = []
    
    /// Pre-allocated chunk buffer, reused across processChunk calls to avoid allocation.
    /// Sized to chunkSizeSamples. Zeroed with vDSP_vclr before each use.
    private var reusableChunkBuffer: [Float] = []
    
    /// Processing chunk size in samples. Matches the DiarizerConfig chunkDuration
    /// (default 10 seconds at 16 kHz = 160,000 samples).
    private var chunkSizeSamples: Int = 160_000
    
    /// Overlap between consecutive chunks in samples.
    /// FluidAudio default: 0 (segmentation model handles boundaries internally).
    private var chunkOverlapSamples: Int = 0
    
    /// Track processed sample counts per source.
    private var micProcessed: Int = 0
    private var sysProcessed: Int = 0
    
    /// Speaker label mapping from FluidAudio speaker IDs to our display labels.
    private var speakerLabelMap: [String: String] = [:]
    private var nextUnknownIndex: Int = 1
    
    /// Track which FluidAudio speaker IDs produced which transcript segment IDs.
    private var speakerSegmentMap: [String: [UUID]] = [:]
    
    /// Voice-identified speaker timeline: each entry records which speaker cluster
    /// (identified by voice embedding) was active during a time range.
    /// Built directly from diarization results — the authoritative source of
    /// "who spoke when" based on voice analysis.
    struct VoiceIdentifiedEntry {
        let speakerID: String
        let label: String
        let startTime: TimeInterval
        let endTime: TimeInterval
    }
    private(set) var speakerTimeline: [VoiceIdentifiedEntry] = []
    
    /// Concurrency guard -- serializes chunk processing.
    private var isProcessing: Bool = false
    
    /// Consecutive error counter for backoff.
    private var consecutiveErrors: Int = 0
    private static let maxConsecutiveErrors = 5
    
    /// Inactivity pruning: last time we pruned stale speakers.
    private var lastPruneDate: Date = Date()
    /// Prune speakers inactive for more than this interval (10 minutes).
    private static let pruneInterval: TimeInterval = 600
    /// How often to check for pruning (every 2 minutes).
    private static let pruneCheckInterval: TimeInterval = 120
    
    // MARK: - Init
    
    nonisolated init(profileManager: VoiceProfileManager? = nil, diarizationSettings: DiarizationSettings? = nil) {
        self.profileManager = profileManager ?? VoiceProfileManager.shared
        self.diarizationSettings = diarizationSettings ?? DiarizationSettings.shared
    }
    
    // MARK: - Model Loading
    
    /// Load diarization models with optimized MLModelConfiguration.
    /// Call once after model download completes.
    func loadModels() async {
        do {
            // Download with optimized configuration matching FluidAudio reference
            let models = try await DiarizerModels.download(
                configuration: Self.optimizedModelConfiguration()
            )
            cachedModels = models
            
            let threshold = Float(diarizationSettings.clusteringThreshold)
            let config = Self.makeConfig(threshold: threshold, settings: diarizationSettings)
            let manager = DiarizerManager(config: config)
            manager.initialize(models: models)
            
            // Apply chunk sizing from config
            chunkSizeSamples = Int(config.chunkDuration) * 16_000
            chunkOverlapSamples = Int(config.chunkOverlap) * 16_000
            reusableChunkBuffer = [Float](repeating: 0, count: chunkSizeSamples)
            
            self.diarizerManager = manager
            isReady = true
            errorMessage = nil
            print("[Dialogue] FluidAudio diarizer loaded (threshold: \(threshold), chunk: \(config.chunkDuration)s, minSpeech: \(config.minSpeechDuration)s)")
        } catch {
            errorMessage = "Failed to load diarization models: \(error.localizedDescription)"
            print("[Dialogue] FluidAudio load error: \(error)")
        }
    }
    
    /// Optimized MLModelConfiguration matching FluidAudio's reference defaults.
    /// Enables Float16 GPU accumulation for ~2x speedup and selects appropriate compute units.
    private static func optimizedModelConfiguration() -> MLModelConfiguration {
        let config = MLModelConfiguration()
        // Enable Float16 optimization for ~2x speedup (matches FluidAudio DiarizerModels.swift)
        config.allowLowPrecisionAccumulationOnGPU = true
        // Use all compute units (CPU + GPU + ANE) for best performance
        let isCI = ProcessInfo.processInfo.environment["CI"] != nil
        config.computeUnits = isCI ? .cpuAndNeuralEngine : .all
        return config
    }
    
    /// Create a DiarizerConfig matching FluidAudio's reference defaults.
    ///
    /// Reference: FluidAudio DiarizerTypes.swift `DiarizerConfig.default`
    /// - clusteringThreshold: 0.7 (configurable via Settings)
    /// - chunkDuration: 10s
    /// - chunkOverlap: 0.0 (FluidAudio default — segmentation model handles
    ///   boundaries internally; adding overlap wastes ~10% processing and can
    ///   produce duplicate segments)
    /// - minSpeechDuration: 1.0s (segments shorter than this are discarded)
    /// - minEmbeddingUpdateDuration: 2.0s (need this much speech to update embeddings)
    /// - minActiveFramesCount: 10.0 (minimum active frames for valid speech detection)
    ///
    /// SpeakerManager thresholds are derived automatically by DiarizerManager:
    /// - speakerThreshold = clusteringThreshold * 1.2 (reduces over-segmentation)
    /// - embeddingThreshold = clusteringThreshold * 0.8 (updates on high-confidence matches)
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
            chunkOverlap: 0.0      // FluidAudio default — no overlap needed
        )
    }
    
    /// Re-create the diarizer manager with the current threshold setting.
    /// Call this when the user changes the clustering threshold in Settings.
    /// Re-create the diarizer manager with the current settings.
    /// Call this when the user changes diarization settings.
    func applySettings() {
        guard let models = cachedModels else { return }
        
        let threshold = Float(diarizationSettings.clusteringThreshold)
        let config = Self.makeConfig(threshold: threshold, settings: diarizationSettings)
        let manager = DiarizerManager(config: config)
        manager.initialize(models: models)
        
        chunkSizeSamples = Int(config.chunkDuration) * 16_000
        chunkOverlapSamples = Int(config.chunkOverlap) * 16_000
        reusableChunkBuffer = [Float](repeating: 0, count: chunkSizeSamples)
        
        self.diarizerManager = manager
        print("[Dialogue] Diarizer settings applied (threshold: \(threshold), chunk: \(config.chunkDuration)s, minSpeech: \(config.minSpeechDuration)s)")
    }
    
    // MARK: - Streaming Interface
    
    /// Reset state for a new recording session.
    func startSession() {
        micBuffer.removeAll(keepingCapacity: true)
        sysBuffer.removeAll(keepingCapacity: true)
        micProcessed = 0
        sysProcessed = 0
        speakerLabelMap.removeAll()
        speakerSegmentMap.removeAll()
        speakerTimeline.removeAll()
        speakerToProfileMap.removeAll()
        nextUnknownIndex = 1
        speakerCount = 0
        isProcessing = false
        consecutiveErrors = 0
        lastProcessingError = nil
        lastTimings = nil
        lastPruneDate = Date()
        
        guard let manager = diarizerManager else { return }
        
        // IMPORTANT: Do NOT seed enrolled voice profiles into the SpeakerManager.
        //
        // The SpeakerManager's assignment threshold (clusteringThreshold * 1.2)
        // is designed for diarization (clustering unknown speakers), NOT for
        // speaker identification (matching against enrolled profiles). Seeding
        // enrolled speakers causes the permissive diarization threshold to
        // match unrelated voices (even different genders) to the enrolled
        // profile, labeling everyone as "You".
        //
        // Instead, let the diarizer cluster speakers freely, then identify
        // which clusters correspond to enrolled profiles in `resolveLabel()`
        // using VoiceProfileManager's strict matching threshold (cosine
        // similarity > 0.75).
        manager.speakerManager.reset(keepIfPermanent: false)
        
        print("[Dialogue] Diarization session started (\(profileManager.profiles.count) enrolled profile(s) available for post-hoc identification)")
    }
    
    /// Stop the session and return detected speakers with their embeddings.
    func stopSession() -> [DetectedSpeaker] {
        guard let manager = diarizerManager else {
            micBuffer.removeAll()
            sysBuffer.removeAll()
            return []
        }
        
        // Get all speakers from the manager's speaker database
        let allSpeakers = manager.speakerManager.getAllSpeakers()
        let knownClusterIDs = Set(allSpeakers.map { $0.0 })
        
        var colorIdx = 0
        var speakers = allSpeakers.map { (id, speaker) -> DetectedSpeaker in
            let label = speakerLabelMap[id] ?? speaker.name
            let segIDs = speakerSegmentMap[id] ?? []
            
            // Post-hoc identification: check if this cluster matches an
            // enrolled voice profile using the strict matching threshold.
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
        
        // Include orphaned speakers that have linked segments but no FluidAudio
        // cluster (e.g. "Speaker ?" segments that arrived before diarization
        // produced results). These need to appear in the post-meeting review so
        // the user can name or merge them.
        for (clusterID, segIDs) in speakerSegmentMap where !knownClusterIDs.contains(clusterID) {
            guard !segIDs.isEmpty else { continue }
            
            let label = speakerLabelMap[clusterID] ?? "Speaker ?"
            colorIdx += 1
            
            speakers.append(DetectedSpeaker(
                id: clusterID,
                label: label,
                profileID: nil,
                representativeEmbedding: [],  // No embedding available
                segmentIDs: segIDs,
                isIdentified: false,
                colorIndex: colorIdx
            ))
        }
        
        print("[Dialogue] Diarization session ended — \(speakers.count) speaker(s) detected: \(speakers.map { "\($0.label) (\($0.segmentIDs.count) segs)" })")
        
        micBuffer.removeAll()
        sysBuffer.removeAll()
        return speakers
    }
    
    /// Record that a transcript segment ID belongs to a given speaker cluster.
    func linkSegment(id: UUID, toSpeaker speakerID: String) {
        speakerSegmentMap[speakerID, default: []].append(id)
    }
    
    /// Move a segment from one speaker cluster to another.
    /// Used during post-recording reconciliation when orphan segments are
    /// retroactively matched to proper diarization clusters.
    func relinkSegment(id: UUID, from oldSpeakerID: String, to newSpeakerID: String) {
        speakerSegmentMap[oldSpeakerID]?.removeAll { $0 == id }
        // Clean up empty clusters
        if speakerSegmentMap[oldSpeakerID]?.isEmpty == true {
            speakerSegmentMap.removeValue(forKey: oldSpeakerID)
        }
        speakerSegmentMap[newSpeakerID, default: []].append(id)
    }
    
    // MARK: - Speaker Timeline Lookup
    
    /// Find the voice-identified speaker cluster that was active during a given
    /// time range. Returns the (speakerID, label) of the best-matching entry
    /// based on maximum time overlap, or nearest entry if no direct overlap.
    ///
    /// This is the authoritative way to resolve "who was speaking at time T"
    /// because it queries the diarizer's voice-separated speaker timeline.
    func findSpeaker(startTime: TimeInterval, endTime: TimeInterval) -> (speakerID: String, label: String)? {
        guard !speakerTimeline.isEmpty else { return nil }
        
        // Find the entry with the best direct time overlap
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
        
        // If no direct overlap, find the nearest entry by proximity
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
    
    /// Audio source identifier.
    enum AudioSource { case mic, system }
    
    /// Feed new audio samples from a specific source.
    /// Mic and system audio are buffered independently so the diarizer
    /// always processes a coherent single-source chunk. Both share the
    /// same underlying DiarizerManager/SpeakerManager, so speakers are
    /// clustered across sources automatically.
    func appendAudio(samples: [Float], timestamp: TimeInterval, source: AudioSource = .mic) {
        // Skip if we've hit too many consecutive errors (backoff)
        guard consecutiveErrors < Self.maxConsecutiveErrors else { return }
        
        switch source {
        case .mic:
            micBuffer.append(contentsOf: samples)
            let unprocessed = micBuffer.count - micProcessed
            if unprocessed >= chunkSizeSamples && !isProcessing {
                Task { await processChunk(source: .mic, timestamp: timestamp) }
            }
        case .system:
            sysBuffer.append(contentsOf: samples)
            let unprocessed = sysBuffer.count - sysProcessed
            if unprocessed >= chunkSizeSamples && !isProcessing {
                Task { await processChunk(source: .system, timestamp: timestamp) }
            }
        }
    }
    
    // MARK: - Speaker Merge
    
    /// Find pairs of speakers that are similar enough to merge.
    /// Used in the post-meeting labeler to suggest merges.
    func findMergeableSpeakerPairs() -> [(sourceID: String, destinationID: String)] {
        guard let manager = diarizerManager else { return [] }
        return manager.speakerManager.findMergeablePairs().map {
            (sourceID: $0.speakerToMerge, destinationID: $0.destination)
        }
    }
    
    /// Merge two speaker clusters.
    func mergeSpeakers(sourceID: String, into destinationID: String) {
        guard let manager = diarizerManager else { return }
        manager.speakerManager.mergeSpeaker(sourceID, into: destinationID)
        
        // Merge segment tracking
        let sourceSegments = speakerSegmentMap.removeValue(forKey: sourceID) ?? []
        speakerSegmentMap[destinationID, default: []].append(contentsOf: sourceSegments)
        
        // Update label map
        speakerLabelMap.removeValue(forKey: sourceID)
        
        speakerCount = manager.speakerManager.speakerCount
    }
    
    // MARK: - Processing
    
    private func processChunk(source: AudioSource, timestamp: TimeInterval) async {
        guard !isProcessing, let manager = diarizerManager else { return }
        isProcessing = true
        defer { isProcessing = false }
        
        let buffer: [Float]
        let processed: Int
        switch source {
        case .mic:    buffer = micBuffer;  processed = micProcessed
        case .system: buffer = sysBuffer;  processed = sysProcessed
        }
        
        // Calculate chunk boundaries with overlap
        let chunkStart: Int
        if processed == 0 {
            chunkStart = 0
        } else {
            // Step back by overlap amount from the last processed position
            chunkStart = max(0, processed - chunkOverlapSamples)
        }
        let chunkEnd = min(buffer.count, chunkStart + chunkSizeSamples)
        guard chunkEnd > chunkStart else { return }
        
        let chunkLength = chunkEnd - chunkStart
        let chunkStartTime = Double(chunkStart) / 16000.0
        
        // --- Audio Validation ---
        // Validate the chunk before spending inference time on it.
        let validation = manager.validateAudio(buffer[chunkStart..<chunkEnd])
        guard validation.isValid else {
            // Skip this chunk silently (silence, too short, NaN, etc.)
            switch source {
            case .mic:    micProcessed = chunkEnd
            case .system: sysProcessed = chunkEnd
            }
            return
        }
        
        // --- Zero-copy chunk extraction ---
        // Use the pre-allocated reusable buffer instead of allocating a new array.
        if reusableChunkBuffer.count < chunkSizeSamples {
            reusableChunkBuffer = [Float](repeating: 0, count: chunkSizeSamples)
        }
        // Zero the buffer with vDSP
        reusableChunkBuffer.withUnsafeMutableBufferPointer { ptr in
            vDSP_vclr(ptr.baseAddress!, 1, vDSP_Length(ptr.count))
        }
        // Copy chunk data into reusable buffer
        reusableChunkBuffer.withUnsafeMutableBufferPointer { dstPtr in
            let _ = buffer[chunkStart..<chunkEnd].withContiguousStorageIfAvailable { srcPtr in
                memcpy(dstPtr.baseAddress!, srcPtr.baseAddress!, chunkLength * MemoryLayout<Float>.stride)
            }
        }
        let chunk = reusableChunkBuffer[0..<chunkLength]
        
        // --- Offload heavy inference to background queue ---
        let inferenceStart = Date()
        
        do {
            let result = try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<DiarizationResult, Error>) in
                processingQueue.async {
                    do {
                        let r = try manager.performCompleteDiarization(
                            chunk,
                            sampleRate: 16000,
                            atTime: chunkStartTime
                        )
                        continuation.resume(returning: r)
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
            
            let processingTime = Date().timeIntervalSince(inferenceStart)
            
            // --- Pipeline timing snapshot ---
            lastTimings = DiarizationTimingSnapshot(
                chunkDurationSeconds: Double(chunkLength) / 16000.0,
                processingTimeSeconds: processingTime,
                segmentCount: result.segments.count,
                pipelineTimings: result.timings
            )
            
            // Process results back on MainActor
            for segment in result.segments {
                let speakerID = segment.speakerId
                let embedding = segment.embedding
                let segStartTime = TimeInterval(segment.startTimeSeconds)
                let segEndTime = TimeInterval(segment.endTimeSeconds)
                
                let label = resolveLabel(for: speakerID)
                
                // Record in the voice-identified timeline
                speakerTimeline.append(VoiceIdentifiedEntry(
                    speakerID: speakerID,
                    label: label,
                    startTime: segStartTime,
                    endTime: segEndTime
                ))
                
                // --- EMA embedding update for known speakers ---
                updateKnownSpeakerEmbedding(speakerID: speakerID, newEmbedding: embedding)
                
                onSpeakerSegment?(label, speakerID, segStartTime, segEndTime, embedding)
            }
            
            speakerCount = manager.speakerManager.speakerCount
            consecutiveErrors = 0
            lastProcessingError = nil
            
            // Advance processed mark past the core (non-overlap) portion
            switch source {
            case .mic:    micProcessed = chunkEnd
            case .system: sysProcessed = chunkEnd
            }
            
            // --- Inactivity pruning for long meetings ---
            pruneInactiveSpeakersIfNeeded()
            
        } catch {
            consecutiveErrors += 1
            let errorMsg = "Diarization error (\(source), attempt \(consecutiveErrors)): \(error.localizedDescription)"
            print("[Dialogue] \(errorMsg)")
            
            // Surface error to UI
            lastProcessingError = errorMsg
            onProcessingError?(errorMsg)
            
            // Still advance so we don't re-process the same failing chunk
            switch source {
            case .mic:    micProcessed = chunkEnd
            case .system: sysProcessed = chunkEnd
            }
            
            if consecutiveErrors >= Self.maxConsecutiveErrors {
                let msg = "Diarization suspended after \(Self.maxConsecutiveErrors) consecutive failures"
                print("[Dialogue] \(msg)")
                lastProcessingError = msg
                onProcessingError?(msg)
            }
        }
    }
    
    // MARK: - EMA Embedding Updates
    
    /// Maps diarizer speaker IDs to matched voice profile IDs.
    /// Populated during `resolveLabel` when a post-hoc match is found.
    private var speakerToProfileMap: [String: String] = [:]
    
    /// Update a known speaker's voice profile embedding using EMA blending.
    /// Since enrolled speakers are no longer seeded into the SpeakerManager,
    /// we use the post-hoc identification map to find the profile to update.
    private func updateKnownSpeakerEmbedding(speakerID: String, newEmbedding: [Float]) {
        // Look up which profile this diarizer speaker was identified as
        guard let profileID = speakerToProfileMap[speakerID],
              let profile = profileManager.profiles.first(where: { $0.id == profileID }) else { return }
        guard newEmbedding.count == profile.embedding.count else { return }
        
        // Validate embedding quality (skip near-zero embeddings)
        var sumSquares: Float = 0
        vDSP_svesq(newEmbedding, 1, &sumSquares, vDSP_Length(newEmbedding.count))
        guard sumSquares > 0.01 else { return }
        
        // Update the profile with the new observation
        profileManager.updateEmbeddingEMA(profileID: profileID, newEmbedding: newEmbedding)
    }
    
    // MARK: - Inactivity Pruning
    
    /// Periodically remove stale non-permanent speaker clusters in long meetings.
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
            print("[Dialogue] Pruned \(beforeCount - afterCount) inactive speaker(s) (\(afterCount) remaining)")
        }
    }
    
    // MARK: - Speaker Label Resolution
    
    /// Resolve a FluidAudio speaker ID to a display label.
    ///
    /// Uses post-hoc identification: after the diarizer assigns a cluster ID
    /// based purely on voice similarity, we check if the cluster's representative
    /// embedding matches any enrolled voice profile. This uses VoiceProfileManager's
    /// strict threshold (cosine similarity > 0.75) — much stricter than the
    /// diarizer's clustering threshold — so only genuine matches are labeled.
    ///
    /// Unmatched speakers get "Speaker N" labels.
    private func resolveLabel(for speakerID: String) -> String {
        // Already mapped?
        if let label = speakerLabelMap[speakerID] {
            return label
        }
        
        // Post-hoc identification: check if this diarizer cluster's embedding
        // matches any enrolled voice profile.
        if let manager = diarizerManager,
           let speaker = manager.speakerManager.getSpeaker(for: speakerID) {
            // Use VoiceProfileManager's strict matching (cosine similarity > 0.75)
            // NOT the diarizer's permissive clustering threshold.
            if let matchedProfile = profileManager.matchSpeaker(embedding: speaker.currentEmbedding) {
                let label = matchedProfile.displayName
                speakerLabelMap[speakerID] = label
                speakerToProfileMap[speakerID] = matchedProfile.id
                print("[Dialogue] Speaker \(speakerID) identified as \"\(label)\" (post-hoc voice match)")
                return label
            }
        }
        
        // No enrolled profile match — assign new unknown label
        let label = "Speaker \(nextUnknownIndex)"
        speakerLabelMap[speakerID] = label
        nextUnknownIndex += 1
        return label
    }
}

// MARK: - Pipeline Timing Snapshot

/// Lightweight timing data for the most recent diarization chunk (for diagnostics).
struct DiarizationTimingSnapshot: Sendable {
    let chunkDurationSeconds: Double
    let processingTimeSeconds: Double
    let segmentCount: Int
    let pipelineTimings: PipelineTimings?
    
    /// Real-time factor: < 1.0 means faster than real-time.
    var realtimeFactor: Double {
        guard chunkDurationSeconds > 0 else { return 0 }
        return processingTimeSeconds / chunkDurationSeconds
    }
}
