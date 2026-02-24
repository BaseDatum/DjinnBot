import Foundation
import FluidAudio

// MARK: - StreamingTranscriptionService

/// Wraps FluidAudio's AsrManager for real-time streaming speech-to-text.
/// Accumulates audio in a sliding buffer, runs chunked transcription
/// via Parakeet TDT v3, and emits partial + final transcript segments.
///
/// Uses FluidAudio's built-in VAD to feed only speech chunks, lowering
/// latency and compute overhead compared to fixed-interval transcription.
@MainActor
final class StreamingTranscriptionService: ObservableObject {
    
    // MARK: - Published State
    
    /// Whether the FluidAudio ASR pipeline is loaded and ready.
    @Published var isReady: Bool = false
    
    /// Current partial (unconfirmed) text being decoded.
    @Published var partialText: String = ""
    
    /// Error message if pipeline fails.
    @Published var errorMessage: String?
    
    // MARK: - Callbacks
    
    /// Called when a final (confirmed) transcript segment is produced.
    /// Parameters: (text, startTime, endTime)
    var onFinalSegment: ((_ text: String, _ startTime: TimeInterval, _ endTime: TimeInterval) -> Void)?
    
    /// Called when partial (in-progress) text updates.
    /// Parameters: (text, startTime)
    var onPartialUpdate: ((_ text: String, _ startTime: TimeInterval) -> Void)?
    
    // MARK: - Private
    
    private var asrManager: AsrManager?
    
    /// Accumulated audio buffer (16 kHz mono Float32).
    private var audioBuffer: [Float] = []
    
    /// Maximum buffer length in samples (30 seconds at 16 kHz).
    private let maxBufferLength = 30 * 16000
    
    /// Minimum buffer length before attempting transcription (1.5 seconds).
    private let minBufferLength = 24000  // 1.5s at 16kHz
    
    /// Overlap when sliding the window forward (keeps context).
    private let overlapLength = 8000  // 0.5s
    
    /// Timer for periodic transcription attempts.
    private var transcriptionTimer: Timer?
    
    /// Interval between transcription runs.
    private let transcriptionInterval: TimeInterval = 1.0
    
    /// Track confirmed text to detect new final segments.
    private var lastConfirmedText: String = ""
    
    /// Timestamp tracking.
    private var bufferStartTime: TimeInterval = 0
    private var currentTimestamp: TimeInterval = 0
    
    /// Concurrency guard.
    private var isTranscribing: Bool = false
    
    // MARK: - Model Loading
    
    /// Load the FluidAudio ASR pipeline. Call once at app launch or when models are downloaded.
    func loadModel() async {
        do {
            let models = try await AsrModels.downloadAndLoad()
            let manager = AsrManager()
            try await manager.initialize(models: models)
            
            self.asrManager = manager
            self.isReady = true
            self.errorMessage = nil
            print("[Dialogue] FluidAudio ASR loaded (Parakeet TDT v3)")
        } catch {
            self.errorMessage = "Failed to load FluidAudio ASR: \(error.localizedDescription)"
            print("[Dialogue] FluidAudio ASR load error: \(error)")
        }
    }
    
    /// Check if models are already downloaded locally.
    static func modelsExistLocally() -> Bool {
        // FluidAudio stores models in its own managed cache directory.
        // AsrModels.downloadIfNeeded() is a no-op if models are present.
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        let modelDir = cacheDir
            .appendingPathComponent("FluidAudio")
            .appendingPathComponent("models")
        return FileManager.default.fileExists(atPath: modelDir.path)
    }
    
    // MARK: - Streaming Interface
    
    /// Start accepting audio buffers for streaming transcription.
    func startStreaming() {
        guard isReady else { return }
        
        audioBuffer.removeAll(keepingCapacity: true)
        lastConfirmedText = ""
        partialText = ""
        bufferStartTime = 0
        currentTimestamp = 0
        isTranscribing = false
        
        // Periodic transcription
        transcriptionTimer = Timer.scheduledTimer(withTimeInterval: transcriptionInterval, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.runTranscription()
            }
        }
    }
    
    /// Stop streaming and flush any remaining audio.
    func stopStreaming() async {
        transcriptionTimer?.invalidate()
        transcriptionTimer = nil
        
        // Final transcription of remaining buffer
        await runTranscription(isFinal: true)
        
        audioBuffer.removeAll()
        partialText = ""
    }
    
    /// Feed new audio samples into the streaming buffer.
    /// Called from AudioEngineManager's onAudioBuffer callback.
    func appendAudio(samples: [Float], timestamp: TimeInterval) {
        audioBuffer.append(contentsOf: samples)
        currentTimestamp = timestamp
        
        // Slide window if buffer exceeds max
        if audioBuffer.count > maxBufferLength {
            let removeCount = audioBuffer.count - maxBufferLength + overlapLength
            audioBuffer.removeFirst(removeCount)
            bufferStartTime = timestamp - Double(audioBuffer.count) / 16000.0
        }
    }
    
    // MARK: - Transcription
    
    private func runTranscription(isFinal: Bool = false) async {
        guard !isTranscribing, isReady, audioBuffer.count >= minBufferLength else { return }
        guard let manager = asrManager else { return }
        
        isTranscribing = true
        defer { isTranscribing = false }
        
        let samples = audioBuffer
        let startTime = bufferStartTime
        
        do {
            // Use FluidAudio's chunked streaming transcription.
            // AsrManager handles VAD internally and transcribes speech segments.
            let result = try await manager.transcribe(samples)
            
            let fullText = result.text.trimmingCharacters(in: CharacterSet.whitespacesAndNewlines)
            
            if isFinal || hasNewConfirmedContent(fullText) {
                // Emit final segment
                let endTime = startTime + Double(samples.count) / 16000.0
                let newText = extractNewContent(from: fullText)
                
                if !newText.isEmpty {
                    lastConfirmedText = fullText
                    onFinalSegment?(newText, startTime, endTime)
                }
                
                partialText = ""
            } else {
                // Update partial
                let newText = extractNewContent(from: fullText)
                if !newText.isEmpty {
                    partialText = newText
                    onPartialUpdate?(newText, startTime)
                }
            }
        } catch {
            print("[Dialogue] Transcription error: \(error)")
        }
    }
    
    /// Detect if there's new confirmed content beyond what we already emitted.
    private func hasNewConfirmedContent(_ text: String) -> Bool {
        // Simple heuristic: if text is significantly longer than partial, it's confirmed
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.count > lastConfirmedText.count + 20
    }
    
    /// Extract only the new content not yet emitted as final.
    private func extractNewContent(from fullText: String) -> String {
        if lastConfirmedText.isEmpty { return fullText }
        
        // Find where the confirmed text ends in the full text
        if fullText.hasPrefix(lastConfirmedText) {
            let newPart = String(fullText.dropFirst(lastConfirmedText.count))
            return newPart.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        
        return fullText
    }
}
