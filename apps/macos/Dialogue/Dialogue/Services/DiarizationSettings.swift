import Foundation
import Combine

// MARK: - DiarizationPipeline

/// Which diarization pipeline to use.
enum DiarizationPipeline: String, CaseIterable, Identifiable {
    /// Traditional segmentation + embedding extraction + clustering pipeline.
    /// Best for: offline/batch processing, unlimited speakers.
    case segmentationClustering = "segmentation_clustering"
    
    /// End-to-end neural Sortformer pipeline (NVIDIA).
    /// Best for: real-time streaming, low latency, up to 4 speakers.
    /// Requires Sortformer model download.
    case sortformer = "sortformer"
    
    var id: String { rawValue }
    
    var displayName: String {
        switch self {
        case .segmentationClustering: return "Segmentation + Clustering"
        case .sortformer: return "Sortformer (Neural)"
        }
    }
    
    var subtitle: String {
        switch self {
        case .segmentationClustering: return "Traditional pipeline, unlimited speakers"
        case .sortformer: return "End-to-end neural, up to 4 speakers, lower latency"
        }
    }
}

// MARK: - DiarizationSettings

/// User preferences for speaker diarization (who-spoke-when detection).
/// Persisted via UserDefaults.
@MainActor
final class DiarizationSettings: ObservableObject {
    static let shared = DiarizationSettings()

    private let defaults = UserDefaults.standard

    // MARK: - Keys

    private enum Key {
        static let clusteringThreshold = "dialogue.diarization.clusteringThreshold"
        static let minSpeechDuration = "dialogue.diarization.minSpeechDuration"
        static let chunkDuration = "dialogue.diarization.chunkDuration"
        static let pipeline = "dialogue.diarization.pipeline"
    }

    // MARK: - Defaults (match FluidAudio DiarizerConfig.default)

    /// Default speaker clustering threshold (cosine distance).
    /// Used directly as SpeakerManager.speakerThreshold — the maximum cosine
    /// distance for assigning audio to an existing speaker cluster.
    ///
    /// FluidAudio cosine distance interpretation:
    ///   < 0.3  = Very high confidence match
    ///   0.3-0.5 = Strong match
    ///   0.5-0.7 = Threshold zone
    ///   0.7-0.9 = Should create new speaker
    ///   > 0.9  = Clearly different
    ///
    /// SpeakerManager default: 0.65. We match FluidAudio's default.
    /// Note: this controls DIARIZATION (clustering unknown speakers), not
    /// identification (matching enrolled profiles). Identification uses
    /// VoiceProfileManager's cosine similarity threshold.
    static let defaultThreshold: Double = 0.65

    /// Allowed range for the clustering threshold slider.
    /// Lower = more aggressive splitting, higher = more aggressive merging.
    static let thresholdRange: ClosedRange<Double> = 0.4...0.95

    /// Default minimum speech duration in seconds.
    /// FluidAudio reference: 1.0s — segments shorter than this are discarded.
    static let defaultMinSpeechDuration: Double = 1.0

    /// Allowed range for minimum speech duration.
    static let minSpeechDurationRange: ClosedRange<Double> = 0.3...3.0
    
    /// Default chunk duration in seconds.
    /// FluidAudio streaming reference: 5.0s with 3.0s skip (2s overlap).
    /// 5s balances speaker slot capacity (3 per chunk) with latency.
    static let defaultChunkDuration: Double = 5.0
    
    /// Allowed range for chunk duration.
    static let chunkDurationRange: ClosedRange<Double> = 3.0...15.0

    // MARK: - Published Properties

    /// Speaker clustering threshold.
    /// Lower values make the diarizer more likely to treat similar-sounding
    /// voices as separate speakers. Higher values make it more likely to
    /// group them as the same speaker.
    @Published var clusteringThreshold: Double {
        didSet { defaults.set(clusteringThreshold, forKey: Key.clusteringThreshold) }
    }
    
    /// Minimum speech segment duration in seconds.
    /// Segments shorter than this are discarded as noise/artifacts.
    /// Lower values capture brief interjections; higher values reduce false positives.
    @Published var minSpeechDuration: Double {
        didSet { defaults.set(minSpeechDuration, forKey: Key.minSpeechDuration) }
    }
    
    /// Audio chunk duration in seconds for the diarization pipeline.
    /// Longer chunks provide more context for accurate speaker embedding
    /// extraction but increase latency. Shorter chunks give faster results
    /// but may reduce accuracy for similar-sounding speakers.
    @Published var chunkDuration: Double {
        didSet { defaults.set(chunkDuration, forKey: Key.chunkDuration) }
    }
    
    /// Which diarization pipeline to use.
    /// Sortformer provides lower latency and end-to-end neural diarization but
    /// is limited to 4 speakers. The traditional pipeline supports unlimited speakers.
    @Published var pipeline: DiarizationPipeline {
        didSet { defaults.set(pipeline.rawValue, forKey: Key.pipeline) }
    }

    // MARK: - Init

    private init() {
        defaults.register(defaults: [
            Key.clusteringThreshold: Self.defaultThreshold,
            Key.minSpeechDuration: Self.defaultMinSpeechDuration,
            Key.chunkDuration: Self.defaultChunkDuration,
            Key.pipeline: DiarizationPipeline.segmentationClustering.rawValue,
        ])

        self.clusteringThreshold = defaults.double(forKey: Key.clusteringThreshold)
        self.minSpeechDuration = defaults.double(forKey: Key.minSpeechDuration)
        self.chunkDuration = defaults.double(forKey: Key.chunkDuration)
        
        let pipelineRaw = defaults.string(forKey: Key.pipeline) ?? DiarizationPipeline.segmentationClustering.rawValue
        self.pipeline = DiarizationPipeline(rawValue: pipelineRaw) ?? .segmentationClustering
    }
}
