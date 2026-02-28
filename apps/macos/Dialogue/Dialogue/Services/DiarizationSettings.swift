import Foundation
import Combine

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
    }

    // MARK: - Defaults

    /// Default clustering threshold (matches FluidAudio's recommended value).
    static let defaultThreshold: Double = 0.7

    /// Allowed range for the slider. Lower = more aggressive splitting,
    /// higher = more aggressive merging.
    static let thresholdRange: ClosedRange<Double> = 0.4...0.95

    // MARK: - Published Properties

    /// Speaker clustering threshold.
    /// Lower values make the diarizer more likely to treat similar-sounding
    /// voices as separate speakers. Higher values make it more likely to
    /// group them as the same speaker.
    @Published var clusteringThreshold: Double {
        didSet { defaults.set(clusteringThreshold, forKey: Key.clusteringThreshold) }
    }

    // MARK: - Init

    private init() {
        defaults.register(defaults: [
            Key.clusteringThreshold: Self.defaultThreshold,
        ])

        self.clusteringThreshold = defaults.double(forKey: Key.clusteringThreshold)
    }
}
