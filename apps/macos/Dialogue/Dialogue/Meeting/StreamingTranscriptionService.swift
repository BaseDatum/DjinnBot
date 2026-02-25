import AVFoundation
import Foundation
import FluidAudio

// MARK: - StreamingTranscriptionService

/// Wraps two FluidAudio StreamingAsrManagers (Parakeet TDT v3, 600M params)
/// for real-time speech-to-text: one for microphone audio and one for system
/// audio. Each receives a coherent, single-source audio stream.
///
/// Uses the `.streaming` config preset (11s chunks, 2s left/right context)
/// which gives ~13s latency to first result but high accuracy (~2.5% WER).
///
/// StreamingAsrManager semantics:
/// - `isConfirmed == true`: The PREVIOUS volatile text was promoted to
///   confirmed. `update.text` is the deduplicated tail (new volatile).
/// - `isConfirmed == false`: `update.text` is the current volatile/partial.
@MainActor
final class StreamingTranscriptionService: ObservableObject {
    
    // MARK: - Audio Source
    
    enum AudioSource {
        case mic
        case system
    }
    
    // MARK: - Published State
    
    @Published var isReady: Bool = false
    @Published var partialText: String = ""
    @Published var errorMessage: String?
    
    // MARK: - Callbacks
    
    var onFinalSegment: ((_ text: String, _ startTime: TimeInterval, _ endTime: TimeInterval) -> Void)?
    var onPartialUpdate: ((_ text: String, _ startTime: TimeInterval) -> Void)?
    
    // MARK: - Private
    
    /// Cached ASR models for reuse across sessions.
    private var cachedModels: AsrModels?
    
    /// Separate streaming managers for each audio source.
    private var micManager: StreamingAsrManager?
    private var systemManager: StreamingAsrManager?
    
    /// Tasks consuming transcription updates from each manager.
    private var micConsumerTask: Task<Void, Never>?
    private var systemConsumerTask: Task<Void, Never>?
    
    private var streamStartTime: Date?
    
    /// Current partial (volatile) text from each source.
    private var micPartialText: String = ""
    private var systemPartialText: String = ""
    
    /// Audio format for converting raw samples to AVAudioPCMBuffer.
    private let audioFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    )!
    
    // MARK: - Model Loading
    
    func loadModel() async {
        do {
            let models: AsrModels
            if let cached = cachedModels {
                models = cached
            } else {
                models = try await AsrModels.downloadAndLoad()
                self.cachedModels = models
            }
            
            // Validate models
            let testManager = AsrManager(config: .default)
            try await testManager.initialize(models: models)
            testManager.cleanup()
            
            self.isReady = true
            self.errorMessage = nil
            print("[Dialogue] FluidAudio ASR loaded (Parakeet TDT v3)")
        } catch {
            self.errorMessage = "Failed to load FluidAudio ASR: \(error.localizedDescription)"
            print("[Dialogue] FluidAudio ASR load error: \(error)")
        }
    }
    
    static func modelsExistLocally() -> Bool {
        let cacheDir = AsrModels.defaultCacheDirectory(for: .v3)
        return FileManager.default.fileExists(atPath: cacheDir.path)
    }
    
    // MARK: - Streaming Interface
    
    func startStreaming() {
        guard isReady, let models = cachedModels else { return }
        
        micPartialText = ""
        systemPartialText = ""
        partialText = ""
        streamStartTime = Date()
        
        // Use .streaming config: 11s chunks, 2s left/right context, 0.80 confirmation
        let mic = StreamingAsrManager(config: .streaming)
        let sys = StreamingAsrManager(config: .streaming)
        self.micManager = mic
        self.systemManager = sys
        
        Task {
            do {
                try await mic.start(models: models, source: .microphone)
                try await sys.start(models: models, source: .system)
                
                micConsumerTask = Task { @MainActor [weak self] in
                    for await update in await mic.transcriptionUpdates {
                        guard let self else { break }
                        self.handleUpdate(update, from: .mic)
                    }
                }
                
                systemConsumerTask = Task { @MainActor [weak self] in
                    for await update in await sys.transcriptionUpdates {
                        guard let self else { break }
                        self.handleUpdate(update, from: .system)
                    }
                }
                
                print("[Dialogue] Streaming ASR started (dual-source: mic + system, .streaming config)")
            } catch {
                print("[Dialogue] Failed to start streaming ASR: \(error)")
                self.errorMessage = "Streaming start failed: \(error.localizedDescription)"
            }
        }
    }
    
    func stopStreaming() async {
        let elapsed = streamStartTime.map { Date().timeIntervalSince($0) } ?? 0
        
        // Emit any remaining partial text as final before finishing
        if !micPartialText.isEmpty {
            onFinalSegment?(micPartialText, max(elapsed - 1.0, 0), elapsed)
            micPartialText = ""
        }
        if !systemPartialText.isEmpty {
            onFinalSegment?(systemPartialText, max(elapsed - 1.0, 0), elapsed)
            systemPartialText = ""
        }
        
        // Finish both managers
        if let mic = micManager {
            do {
                let finalText = try await mic.finish()
                let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    print("[Dialogue] Mic final transcript: \(trimmed.prefix(80))...")
                }
            } catch {
                print("[Dialogue] Mic streaming finish error: \(error)")
            }
        }
        
        if let sys = systemManager {
            do {
                let finalText = try await sys.finish()
                let trimmed = finalText.trimmingCharacters(in: .whitespacesAndNewlines)
                if !trimmed.isEmpty {
                    print("[Dialogue] System final transcript: \(trimmed.prefix(80))...")
                }
            } catch {
                print("[Dialogue] System streaming finish error: \(error)")
            }
        }
        
        micConsumerTask?.cancel()
        systemConsumerTask?.cancel()
        micConsumerTask = nil
        systemConsumerTask = nil
        micManager = nil
        systemManager = nil
        partialText = ""
    }
    
    func appendMicAudio(samples: [Float], timestamp: TimeInterval) {
        guard let manager = micManager else { return }
        let buffer = createAudioBuffer(from: samples)
        Task {
            await manager.streamAudio(buffer)
        }
    }
    
    func appendSystemAudio(samples: [Float], timestamp: TimeInterval) {
        guard let manager = systemManager else { return }
        let buffer = createAudioBuffer(from: samples)
        Task {
            await manager.streamAudio(buffer)
        }
    }
    
    // MARK: - Batch Transcription
    
    func transcribeBatch(audioSamples: [Float]) async throws -> String {
        let models = try await AsrModels.downloadAndLoad()
        let manager = AsrManager(config: .default)
        try await manager.initialize(models: models)
        defer { manager.cleanup() }
        
        var speechAudio = audioSamples
        let trailingSilenceSamples = 16_000
        let maxSingleChunkSamples = 240_000
        if speechAudio.count + trailingSilenceSamples <= maxSingleChunkSamples {
            speechAudio += [Float](repeating: 0, count: trailingSilenceSamples)
        }
        
        let result = try await manager.transcribe(speechAudio)
        return result.text
    }
    
    // MARK: - Private Helpers
    
    /// Handle a transcription update from either the mic or system manager.
    ///
    /// When `isConfirmed == true`, the previous volatile text was just promoted
    /// internally. `update.text` is the deduplicated tail (trailing punctuation
    /// etc. from the chunk boundary). We combine them as the confirmed segment.
    private func handleUpdate(_ update: StreamingTranscriptionUpdate, from source: AudioSource) {
        let chunkText = update.text.trimmingCharacters(in: .whitespacesAndNewlines)
        let elapsed = streamStartTime.map { Date().timeIntervalSince($0) } ?? 0
        
        if update.isConfirmed {
            let previousPartial = source == .mic ? micPartialText : systemPartialText
            
            // Build confirmed segment: previous partial + deduplicated tail
            let confirmedSegment = [previousPartial, chunkText]
                .filter { !$0.isEmpty }
                .joined(separator: " ")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            
            if !confirmedSegment.isEmpty {
                let segmentDuration = Double(confirmedSegment.count) / 15.0
                onFinalSegment?(confirmedSegment, max(elapsed - segmentDuration, 0), elapsed)
            }
            
            // Clear partial (confirmed segment was emitted)
            switch source {
            case .mic: micPartialText = ""
            case .system: systemPartialText = ""
            }
            updateMergedPartialText()
            
        } else if !chunkText.isEmpty {
            // Non-empty volatile: update partial display
            switch source {
            case .mic: micPartialText = chunkText
            case .system: systemPartialText = chunkText
            }
            updateMergedPartialText()
            onPartialUpdate?(partialText, elapsed)
        }
        // Empty volatile updates ignored to prevent clearing valid partial text
    }
    
    private func updateMergedPartialText() {
        let parts = [micPartialText, systemPartialText].filter { !$0.isEmpty }
        partialText = parts.joined(separator: " ")
    }
    
    private func createAudioBuffer(from samples: [Float]) -> AVAudioPCMBuffer {
        let sampleCount = samples.count
        let buffer = AVAudioPCMBuffer(
            pcmFormat: audioFormat,
            frameCapacity: AVAudioFrameCount(sampleCount)
        )!
        buffer.frameLength = AVAudioFrameCount(sampleCount)
        
        samples.withUnsafeBufferPointer { srcPtr in
            let dstPtr = buffer.floatChannelData![0]
            memcpy(dstPtr, srcPtr.baseAddress!, sampleCount * MemoryLayout<Float>.stride)
        }
        
        return buffer
    }
}
