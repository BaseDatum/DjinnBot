import AVFoundation
import Foundation

// MARK: - ASREngine

/// Which speech recognition engine to use for transcription.
enum ASREngine: String, CaseIterable, Identifiable {
    /// FluidAudio Parakeet TDT v3 (bundled, always available).
    case fluidAudio = "fluidAudio"
    /// Apple SpeechAnalyzer / SpeechTranscriber (requires macOS 26+).
    case appleSpeech = "appleSpeech"
    
    var id: String { rawValue }
    
    var displayName: String {
        switch self {
        case .fluidAudio: return "FluidAudio (Parakeet TDT)"
        case .appleSpeech: return "Apple Speech (SpeechAnalyzer)"
        }
    }
    
    var subtitle: String {
        switch self {
        case .fluidAudio: return "Bundled model, 600M params, ~2.5% WER"
        case .appleSpeech: return "System model, auto-updated by Apple"
        }
    }
    
    /// The currently selected engine, persisted in UserDefaults.
    static var current: ASREngine {
        get {
            let raw = UserDefaults.standard.string(forKey: "dialogue.asrEngine") ?? ASREngine.appleSpeech.rawValue
            return ASREngine(rawValue: raw) ?? .appleSpeech
        }
        set {
            UserDefaults.standard.set(newValue.rawValue, forKey: "dialogue.asrEngine")
        }
    }
    
    /// Whether Apple Speech is available on this system.
    static var isAppleSpeechAvailable: Bool {
        if #available(macOS 26, *) {
            return true
        }
        return false
    }
}

// MARK: - TranscriptionServiceProtocol

/// Common interface for streaming speech-to-text services.
/// Both FluidAudio (Parakeet TDT) and Apple SpeechAnalyzer conform to this.
///
/// The protocol is deliberately *not* an ObservableObject — the coordinator
/// reads properties directly and republishes what it needs to SwiftUI views.
@MainActor
protocol TranscriptionServiceProtocol: AnyObject {
    
    // MARK: - State
    
    /// Whether the model is loaded and ready for streaming.
    var isReady: Bool { get }
    
    /// Current partial (volatile) text from the ASR engine.
    var partialText: String { get }
    
    /// Error message if model loading or streaming failed.
    var errorMessage: String? { get }
    
    // MARK: - Callbacks
    
    /// Called when a confirmed/final transcript segment is produced.
    var onFinalSegment: ((_ text: String, _ startTime: TimeInterval, _ endTime: TimeInterval) -> Void)? { get set }
    
    /// Called when partial/volatile text updates.
    var onPartialUpdate: ((_ text: String, _ startTime: TimeInterval) -> Void)? { get set }
    
    // MARK: - Lifecycle
    
    /// Load or ensure models are available. Call once before streaming.
    func loadModel() async
    
    /// Begin a streaming session. Audio can be appended after this returns.
    func startStreaming()
    
    /// End the streaming session. Flushes remaining audio and emits final segments.
    func stopStreaming() async
    
    /// Tear down and release model resources (for engine switching).
    func unloadModel()
    
    // MARK: - Audio Input
    
    /// Feed microphone audio samples (16 kHz, Float32, mono).
    func appendMicAudio(samples: [Float], timestamp: TimeInterval)
    
    /// Feed system audio samples (16 kHz, Float32, mono).
    func appendSystemAudio(samples: [Float], timestamp: TimeInterval)
    
    // MARK: - Availability
    
    /// Whether the model files exist locally (can start without download).
    static func modelsExistLocally() -> Bool
}
