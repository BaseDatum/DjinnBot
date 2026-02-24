import Foundation
import FluidAudio

// MARK: - RealTimeDiarizationService

/// Wraps FluidAudio's DiarizerManager for real-time speaker diarization and embedding extraction.
/// Processes audio chunks incrementally, maintains speaker clusters,
/// and identifies known speakers via VoiceProfileManager.
@MainActor
final class RealTimeDiarizationService: ObservableObject {
    
    // MARK: - Published State
    
    /// Whether the diarization models are loaded and ready.
    @Published var isReady: Bool = false
    
    /// Number of distinct speakers detected so far.
    @Published var speakerCount: Int = 0
    
    /// Error message if loading fails.
    @Published var errorMessage: String?
    
    // MARK: - Callbacks
    
    /// Called when a speaker segment is identified.
    /// Parameters: (speakerLabel, speakerClusterID, startTime, endTime, embedding)
    var onSpeakerSegment: ((_ label: String, _ clusterID: String, _ startTime: TimeInterval, _ endTime: TimeInterval, _ embedding: [Float]) -> Void)?
    
    // MARK: - Private
    
    private var diarizerManager: DiarizerManager?
    private let profileManager: VoiceProfileManager
    
    /// Separate audio buffers for each source so the diarizer processes
    /// coherent audio streams. Both share the same DiarizerManager (and
    /// therefore the same SpeakerManager), so speakers are clustered
    /// across sources.
    private var micBuffer: [Float] = []
    private var sysBuffer: [Float] = []
    
    /// Processing chunk size (5 seconds at 16kHz).
    private let chunkSizeSamples = 80000
    
    /// Track processed sample counts per source.
    private var micProcessed: Int = 0
    private var sysProcessed: Int = 0
    
    /// Speaker label mapping from FluidAudio speaker IDs to our display labels.
    private var speakerLabelMap: [String: String] = [:]
    private var nextUnknownIndex: Int = 1
    
    /// Track which FluidAudio speaker IDs produced which transcript segment IDs.
    private var speakerSegmentMap: [String: [UUID]] = [:]
    
    /// Concurrency guard.
    private var isProcessing: Bool = false
    
    // MARK: - Init
    
    nonisolated init(profileManager: VoiceProfileManager? = nil) {
        self.profileManager = profileManager ?? VoiceProfileManager.shared
    }
    
    // MARK: - Model Loading
    
    /// Load diarization models. Call once after model download completes.
    func loadModels() async {
        do {
            let models = try await DiarizerModels.download()
            let config = DiarizerConfig(
                clusteringThreshold: 0.7,
                minSpeechDuration: 1.0,
                chunkDuration: 10.0
            )
            let manager = DiarizerManager(config: config)
            manager.initialize(models: models)
            
            self.diarizerManager = manager
            isReady = true
            errorMessage = nil
            print("[Dialogue] FluidAudio diarizer loaded")
        } catch {
            errorMessage = "Failed to load diarization models: \(error.localizedDescription)"
            print("[Dialogue] FluidAudio load error: \(error)")
        }
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
        nextUnknownIndex = 1
        speakerCount = 0
        isProcessing = false
        
        guard let manager = diarizerManager else { return }
        
        // Reset the speaker database but keep permanent speakers, then re-seed
        // with the latest voice profiles from Keychain.
        manager.speakerManager.reset(keepIfPermanent: false)
        
        let profiles = profileManager.profiles
        let knownSpeakers = profiles.map { profile in
            Speaker(
                id: profile.id,
                name: profile.displayName,
                currentEmbedding: profile.embedding,
                isPermanent: true
            )
        }
        if !knownSpeakers.isEmpty {
            manager.speakerManager.initializeKnownSpeakers(knownSpeakers, mode: .overwrite)
            
            // Pre-populate label map for known speakers
            for profile in profiles {
                speakerLabelMap[profile.id] = profile.displayName
            }
            
            print("[Dialogue] Diarization session started with \(knownSpeakers.count) known speaker(s): \(profiles.map { $0.displayName })")
        } else {
            print("[Dialogue] Diarization session started with no known speakers")
        }
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
        
        var colorIdx = 0
        let speakers = allSpeakers.map { (id, speaker) -> DetectedSpeaker in
            let label = speakerLabelMap[id] ?? speaker.name
            let isKnown = profileManager.profiles.contains { $0.id == id }
            let segIDs = speakerSegmentMap[id] ?? []
            
            let thisColor: Int
            if isKnown && label == "You" {
                thisColor = 0
            } else {
                colorIdx += 1
                thisColor = colorIdx
            }
            
            return DetectedSpeaker(
                id: id,
                label: label,
                profileID: isKnown ? id : nil,
                representativeEmbedding: speaker.currentEmbedding,
                segmentIDs: segIDs,
                isIdentified: isKnown,
                colorIndex: thisColor
            )
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
    
    /// Audio source identifier.
    enum AudioSource { case mic, system }
    
    /// Feed new audio samples from a specific source.
    /// Mic and system audio are buffered independently so the diarizer
    /// always processes a coherent single-source chunk. Both share the
    /// same underlying DiarizerManager/SpeakerManager, so speakers are
    /// clustered across sources automatically.
    func appendAudio(samples: [Float], timestamp: TimeInterval, source: AudioSource = .mic) {
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
        
        let chunkStart = processed
        let chunkEnd = min(buffer.count, chunkStart + chunkSizeSamples)
        guard chunkEnd > chunkStart else { return }
        
        let chunk = Array(buffer[chunkStart..<chunkEnd])
        let chunkStartTime = Double(chunkStart) / 16000.0
        
        do {
            let result = try manager.performCompleteDiarization(
                chunk,
                sampleRate: 16000,
                atTime: chunkStartTime
            )
            
            for segment in result.segments {
                let speakerID = segment.speakerId
                let embedding = segment.embedding
                let startTime = TimeInterval(segment.startTimeSeconds)
                let endTime = TimeInterval(segment.endTimeSeconds)
                
                let label = resolveLabel(for: speakerID)
                onSpeakerSegment?(label, speakerID, startTime, endTime, embedding)
            }
            
            speakerCount = manager.speakerManager.speakerCount
            
            switch source {
            case .mic:    micProcessed = chunkEnd
            case .system: sysProcessed = chunkEnd
            }
            
        } catch {
            print("[Dialogue] Diarization error (\(source)): \(error)")
        }
    }
    
    /// Resolve a FluidAudio speaker ID to a display label.
    /// Known speakers (seeded from VoiceProfileManager) keep their profile names.
    /// Unknown speakers get "Speaker N" labels.
    private func resolveLabel(for speakerID: String) -> String {
        // Already mapped?
        if let label = speakerLabelMap[speakerID] {
            return label
        }
        
        // Check if this is a known profile ID (e.g. "primary-user")
        if let profile = profileManager.profiles.first(where: { $0.id == speakerID }) {
            speakerLabelMap[speakerID] = profile.displayName
            return profile.displayName
        }
        
        // Check if FluidAudio's speaker has a name from initializeKnownSpeakers
        if let manager = diarizerManager,
           let speaker = manager.speakerManager.getSpeaker(for: speakerID),
           speaker.isPermanent {
            speakerLabelMap[speakerID] = speaker.name
            return speaker.name
        }
        
        // Assign new unknown label
        let label = "Speaker \(nextUnknownIndex)"
        speakerLabelMap[speakerID] = label
        nextUnknownIndex += 1
        return label
    }
}
