import AVFoundation
import CoreMedia
import Foundation
import OSLog
import Speech

/// Manages a single SpeechAnalyzer instance for realtime ASR on one audio stream.
///
/// Uses the macOS 26+ `SpeechAnalyzer` / `SpeechTranscriber` APIs for on-device
/// transcription. Each stream (mic, meeting) gets its own manager so the recogniser
/// can adapt to each audio characteristic independently.
///
/// Reference: https://developer.apple.com/documentation/speech/speechanalyzer
@available(macOS 26.0, *)
actor RealtimeTranscriptionManager {

    // MARK: - Properties

    private let streamType: StreamType
    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "Transcription")

    private var transcriber: SpeechTranscriber?
    private var analyzer: SpeechAnalyzer?
    private var resultTask: Task<Void, Never>?
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzeTask: Task<Void, Never>?

    /// Thread-safe handle for feeding buffers without actor hop.
    /// The pipeline calls `feedHandle?.yield(input)` directly from any thread.
    private(set) var feedHandle: FeedHandle?

    /// Exposed to UI for download progress tracking.
    @MainActor static var downloadProgress: Progress?

    // MARK: - Init

    init(streamType: StreamType) {
        self.streamType = streamType
    }

    // MARK: - Setup

    /// Prepare the SpeechAnalyzer pipeline.
    ///
    /// - Parameter assetsPreloaded: When `true`, skips the asset download check
    ///   because `ModelPreloader` already confirmed assets are installed. When
    ///   `false` (default), falls back to the original download-if-needed path.
    /// - Parameter preloadedLocale: A locale already matched by `ModelPreloader`.
    ///   If nil, locale matching is performed here.
    func prepare(assetsPreloaded: Bool = false, preloadedLocale: Locale? = nil) async throws {
        logger.info("[ASR] Preparing SpeechAnalyzer for \(self.streamType.rawValue) stream (assetsPreloaded: \(assetsPreloaded))")

        // 1. Match locale
        let locale: Locale
        if let preloaded = preloadedLocale {
            locale = preloaded
            logger.info("[ASR] Using pre-matched locale: \(locale.identifier)")
        } else {
            guard let matched = await SpeechTranscriber.supportedLocale(equivalentTo: .current) else {
                logger.error("[ASR] No supported locale for current locale \(Locale.current.identifier)")
                throw TranscriptionError.unsupportedLocale
            }
            locale = matched
            logger.info("[ASR] Matched locale: \(locale.identifier)")
        }

        // 2. Create transcriber
        let newTranscriber = SpeechTranscriber(
            locale: locale,
            preset: .timeIndexedProgressiveTranscription
        )
        self.transcriber = newTranscriber
        logger.info("[ASR] Created SpeechTranscriber")

        // 3. Download assets if needed (skipped when pre-loaded)
        if assetsPreloaded {
            logger.info("[ASR] Assets pre-loaded by ModelPreloader; skipping download check")
        } else {
            logger.info("[ASR] Checking asset installation status...")
            if let downloader = try await AssetInventory.assetInstallationRequest(supporting: [newTranscriber]) {
                logger.info("[ASR] Assets need downloading. Starting downloadAndInstall()...")
                await MainActor.run {
                    RealtimeTranscriptionManager.downloadProgress = downloader.progress
                }
                try await downloader.downloadAndInstall()
                await MainActor.run {
                    RealtimeTranscriptionManager.downloadProgress = nil
                }
                logger.info("[ASR] Assets downloaded and installed")
            } else {
                logger.info("[ASR] Assets already installed")
            }
        }

        // 4. Get best audio format
        guard let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [newTranscriber]) else {
            logger.error("[ASR] bestAvailableAudioFormat returned nil")
            throw TranscriptionError.noCompatibleFormat
        }
        logger.info("[ASR] Audio format: \(format)")

        // 5. Create and prepare analyzer
        let newAnalyzer = SpeechAnalyzer(modules: [newTranscriber])
        try await newAnalyzer.prepareToAnalyze(in: format)
        self.analyzer = newAnalyzer

        logger.info("[ASR] SpeechAnalyzer READY for \(self.streamType.rawValue) stream")
    }

    // MARK: - Streaming

    /// Start the transcription pipeline and begin accepting audio buffers.
    func start() async throws {
        guard let transcriber, let analyzer else {
            throw TranscriptionError.notPrepared
        }

        // Create the input stream for feeding audio buffers
        let (stream, continuation) = AsyncStream<AnalyzerInput>.makeStream()
        self.inputContinuation = continuation
        self.feedHandle = FeedHandle(continuation: continuation)

        // Start consuming transcription results.
        //
        // Progressive transcription emits many partial results with broad time
        // ranges (e.g. [0.0s-24.1s]) before emitting a final result with the
        // precise range (e.g. [18.0s-24.2s]). We detect finals by comparing
        // result.range.end to result.resultsFinalizationTime.
        let streamType = self.streamType
        let logger = self.logger
        resultTask = Task {
            do {
                for try await result in transcriber.results {
                    let range = result.range
                    let text = String(result.text.characters)
                    let finTime = result.resultsFinalizationTime

                    // A result is "final" when its end time falls within the
                    // finalized portion of the audio.
                    let isFinal = range.end <= finTime

                    if isFinal {
                        logger.debug("[ASR] FINAL: \"\(text)\" [\(range.start.seconds, format: .fixed(precision: 1))s-\(range.end.seconds, format: .fixed(precision: 1))s]")
                    }

                    let segment = ASRSegment(
                        stream: streamType,
                        text: text,
                        start: range.start.seconds,
                        end: range.end.seconds,
                        isFinal: isFinal
                    )
                    await MergeEngine.shared.addASR(segment)
                }
            } catch {
                logger.info("[ASR] Result stream ended: \(error.localizedDescription)")
            }
        }

        // Start feeding the analyzer with the input stream
        analyzeTask = Task {
            do {
                _ = try await analyzer.analyzeSequence(stream)
            } catch {
                logger.info("[ASR] Analyze sequence ended: \(error.localizedDescription)")
            }
        }

        logger.info("[ASR] Streaming started for \(streamType.rawValue)")
    }

    /// Feed an audio buffer into the transcription pipeline.
    /// Prefer using `feedHandle?.yield(...)` directly from the pipeline for ordering guarantees.
    func feed(buffer: AVAudioPCMBuffer, at time: CMTime) {
        feedHandle?.yield(buffer: buffer, at: time)
    }

    /// Stop the transcription pipeline gracefully.
    func stop() async {
        feedHandle = nil
        inputContinuation?.finish()
        inputContinuation = nil

        if let analyzer {
            try? await analyzer.finalizeAndFinishThroughEndOfInput()
        }

        resultTask?.cancel()
        analyzeTask?.cancel()
        resultTask = nil
        analyzeTask = nil
        transcriber = nil
        self.analyzer = nil
        logger.info("[ASR] Stopped")
    }
}

// MARK: - Errors

// MARK: - Feed Handle (thread-safe, no actor hop)

/// A `Sendable` handle that wraps the `AsyncStream.Continuation` so the
/// pipeline can yield `AnalyzerInput` from **any thread** without going
/// through the actor, preserving call-site ordering.
@available(macOS 26.0, *)
final class FeedHandle: @unchecked Sendable {
    private let continuation: AsyncStream<AnalyzerInput>.Continuation

    init(continuation: AsyncStream<AnalyzerInput>.Continuation) {
        self.continuation = continuation
    }

    /// Yield an audio buffer directly to the SpeechAnalyzer input stream.
    /// Called synchronously from the mic tap / SCStream callback thread.
    func yield(buffer: AVAudioPCMBuffer, at time: CMTime) {
        let input = AnalyzerInput(buffer: buffer, bufferStartTime: time)
        continuation.yield(input)
    }

    /// Yield an audio buffer with automatic timing (SpeechAnalyzer tracks
    /// the stream position internally). Preferred for continuous streams.
    func yield(buffer: AVAudioPCMBuffer) {
        let input = AnalyzerInput(buffer: buffer)
        continuation.yield(input)
    }
}

// MARK: - Errors

enum TranscriptionError: Error, LocalizedError {
    case unsupportedLocale
    case noCompatibleFormat
    case notPrepared
    case assetsNotInstalled

    var errorDescription: String? {
        switch self {
        case .unsupportedLocale:
            return "No supported locale found for on-device speech recognition."
        case .noCompatibleFormat:
            return "No compatible audio format available for SpeechAnalyzer."
        case .notPrepared:
            return "Transcription manager not prepared. Call prepare() first."
        case .assetsNotInstalled:
            return "Speech recognition assets are not installed."
        }
    }
}
