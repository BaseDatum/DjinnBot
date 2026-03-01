import FluidAudio
import Foundation
import OSLog
import Speech

/// Pre-downloads and caches ASR (SpeechAnalyzer) and diarization (Sortformer)
/// models at app launch so recording can start instantly without waiting for
/// model downloads.
///
/// Publish `state` so the UI can show download progress and disable recording
/// until models are ready.
@available(macOS 26.0, *)
@MainActor
final class ModelPreloader: ObservableObject {

    static let shared = ModelPreloader()

    // MARK: - Published State

    enum State: Equatable {
        case idle
        case downloading(description: String, fractionComplete: Double?)
        case ready
        case failed(String)

        var isReady: Bool { self == .ready }
    }

    @Published private(set) var state: State = .idle

    /// Optional progress object exposed for SwiftUI ProgressView binding.
    @Published private(set) var downloadProgress: Progress?

    // MARK: - Cached Results

    /// Pre-loaded Sortformer models, reused by `RealtimeDiarizationManager`.
    private(set) var sortformerModels: SortformerModels?

    /// Matched ASR locale (confirmed available on this device).
    private(set) var asrLocale: Locale?

    /// Whether ASR assets are confirmed installed.
    private(set) var asrAssetsInstalled = false

    // MARK: - Private

    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "ModelPreloader")
    private var preloadTask: Task<Void, Never>?

    private init() {}

    // MARK: - Preload

    /// Trigger model downloads. Safe to call multiple times; subsequent calls
    /// are no-ops if already loading or ready.
    func preload() {
        guard state == .idle || isFailedState else { return }
        preloadTask?.cancel()
        preloadTask = Task { await performPreload() }
    }

    private var isFailedState: Bool {
        if case .failed = state { return true }
        return false
    }

    private func performPreload() async {
        state = .downloading(description: "Checking ASR assets...", fractionComplete: nil)
        logger.info("Starting model preload")

        // --- ASR assets ---
        do {
            guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: .current) else {
                logger.warning("No supported ASR locale for \(Locale.current.identifier)")
                // ASR unavailable is non-fatal; diarization can still work
                state = .downloading(description: "Downloading diarization models...", fractionComplete: nil)
                try await preloadDiarization()
                state = .ready
                return
            }
            self.asrLocale = locale
            logger.info("ASR locale matched: \(locale.identifier)")

            let transcriber = SpeechTranscriber(
                locale: locale,
                preset: .timeIndexedProgressiveTranscription
            )

            state = .downloading(description: "Checking ASR assets...", fractionComplete: nil)

            if let downloader = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                logger.info("ASR assets need downloading")
                state = .downloading(description: "Downloading speech recognition model...", fractionComplete: 0)
                self.downloadProgress = downloader.progress

                // Observe progress on the main actor
                let progress = downloader.progress
                let observation = Task { @MainActor in
                    while !Task.isCancelled && !progress.isFinished {
                        self.state = .downloading(
                            description: "Downloading speech recognition model...",
                            fractionComplete: progress.fractionCompleted
                        )
                        try? await Task.sleep(for: .milliseconds(250))
                    }
                }

                try await downloader.downloadAndInstall()
                observation.cancel()
                self.downloadProgress = nil
                logger.info("ASR assets installed")
            } else {
                logger.info("ASR assets already installed")
            }
            self.asrAssetsInstalled = true
        } catch {
            logger.warning("ASR preload failed (non-fatal): \(error.localizedDescription)")
            // Continue to diarization even if ASR fails
        }

        // --- Diarization (Sortformer) models ---
        do {
            state = .downloading(description: "Downloading diarization models...", fractionComplete: nil)
            try await preloadDiarization()
        } catch {
            logger.error("Diarization preload failed: \(error.localizedDescription)")
            state = .failed("Failed to download diarization models: \(error.localizedDescription)")
            return
        }

        state = .ready
        logger.info("Model preload complete (ASR: \(self.asrAssetsInstalled), Diarization: \(self.sortformerModels != nil))")
    }

    private func preloadDiarization() async throws {
        let config = SortformerConfig.default
        let models = try await SortformerModels.loadFromHuggingFace(config: config)
        self.sortformerModels = models
        logger.info("Sortformer models loaded")
    }

    // MARK: - Cleanup

    /// Release cached models (e.g. on memory warning or app backgrounding).
    func releaseCachedModels() {
        sortformerModels = nil
        asrAssetsInstalled = false
        asrLocale = nil
        state = .idle
    }
}
