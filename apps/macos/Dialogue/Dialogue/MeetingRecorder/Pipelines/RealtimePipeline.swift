import AVFoundation
import CoreMedia
import FluidAudio
import Foundation
import OSLog

/// Base realtime processing pipeline that runs both ASR (SpeechAnalyzer)
/// and diarization (FluidAudio Sortformer) on a single audio stream.
///
/// Two instances are created: one for the microphone and one for meeting app audio.
/// Each pipeline manages its own transcription and diarization managers.
@available(macOS 26.0, *)
final class RealtimePipeline: Sendable {

    // MARK: - Properties

    let streamType: StreamType
    private let transcriptionManager: RealtimeTranscriptionManager
    private let diarizationManager: RealtimeDiarizationManager
    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "Pipeline")
    private var asrAvailable = false

    /// Thread-safe handle for feeding buffers to SpeechAnalyzer without actor hop.
    private var asrFeedHandle: FeedHandle?

    /// Per-pipeline sample counter used as the single time base for both ASR
    /// and diarization. Guarantees both systems see identical timestamps.
    private var sampleOffset: Int64 = 0

    // MARK: - Init

    init(streamType: StreamType) {
        self.streamType = streamType
        self.transcriptionManager = RealtimeTranscriptionManager(streamType: streamType)
        self.diarizationManager = RealtimeDiarizationManager(streamType: streamType)
    }

    // MARK: - Lifecycle

    /// Prepare both ASR and diarization sub-systems using pre-loaded models
    /// from `ModelPreloader`.
    ///
    /// When `ModelPreloader.shared` has already downloaded models, this skips
    /// all network operations and initializes instantly. Falls back to downloading
    /// if pre-loaded models are unavailable.
    ///
    /// ASR preparation is best-effort: if speech assets are missing, diarization
    /// still runs and the WAV is still recorded. ASR can be retried later on the file.
    func prepare() async throws {
        let preloader = await ModelPreloader.shared
        let sortformerModels = await preloader.sortformerModels
        let asrAssetsPreloaded = await preloader.asrAssetsInstalled
        let asrLocale = await preloader.asrLocale

        logger.info("Preparing \(self.streamType.rawValue) pipeline (preloaded ASR: \(asrAssetsPreloaded), preloaded diarization: \(sortformerModels != nil))")

        // Diarization is required; ASR is best-effort
        async let diarizationResult: () = diarizationManager.prepare(preloadedModels: sortformerModels)

        do {
            try await transcriptionManager.prepare(
                assetsPreloaded: asrAssetsPreloaded,
                preloadedLocale: asrLocale
            )
            try await transcriptionManager.start()
            asrFeedHandle = await transcriptionManager.feedHandle
            asrAvailable = true
            logger.info("\(self.streamType.rawValue) ASR ready")
        } catch {
            asrAvailable = false
            asrFeedHandle = nil
            logger.warning("\(self.streamType.rawValue) ASR unavailable: \(error.localizedDescription). Continuing with diarization only.")
        }

        try await diarizationResult
        logger.info("\(self.streamType.rawValue) pipeline ready (ASR: \(self.asrAvailable))")
    }

    // MARK: - Audio Processing

    /// Process an incoming audio buffer from AVAudioEngine or ScreenCaptureKit.
    ///
    /// The buffer is first converted to 16 kHz mono Float32 if needed, then
    /// fed to both ASR and diarization concurrently.
    ///
    /// - Parameters:
    ///   - buffer: Raw audio buffer from the capture source
    ///   - absoluteTime: Wall-clock offset from recording start
    /// Process an incoming audio buffer. Must be called from a context where
    /// it is safe to send the buffer (the caller owns it exclusively).
    func processBuffer(_ buffer: AVAudioPCMBuffer, at absoluteTime: TimeInterval) {
        // Convert to 16 kHz mono if needed
        guard let converted = MeetingAudioConverter.convertTo16kMono(buffer) else {
            logger.warning("Failed to convert buffer for \(self.streamType.rawValue) pipeline")
            return
        }

        // Extract the float array synchronously (value type, safe to send).
        let samples = MeetingAudioConverter.toFloatArray(converted)
        guard !samples.isEmpty else { return }

        // Single time base: sample-count driven, shared by ASR and diarization.
        // CMTimeMake gives exact rational representation — no floating-point rounding.
        let bufferTime = CMTimeMake(value: sampleOffset, timescale: 16_000)
        let bufferTimeSeconds = Double(sampleOffset) / 16_000.0
        sampleOffset += Int64(samples.count)

        // Feed ASR synchronously via FeedHandle (no actor hop, preserves ordering).
        if asrAvailable, let handle = asrFeedHandle {
            if let asrBuffer = Self.bufferFromSamples(samples) {
                handle.yield(buffer: asrBuffer, at: bufferTime)
            }
        }

        // Feed diarization with the SAME time base.
        let diarizationMgr = self.diarizationManager
        Task {
            await diarizationMgr.processChunk(samples, at: bufferTimeSeconds)
        }
    }

    /// Create a 16 kHz mono **Int16** AVAudioPCMBuffer from Float32 samples.
    ///
    /// SpeechAnalyzer requires Int16 format (confirmed by bestAvailableAudioFormat
    /// returning `<AVAudioFormat: 1 ch, 16000 Hz, Int16>`).
    private static func bufferFromSamples(_ samples: [Float]) -> AVAudioPCMBuffer? {
        guard let int16Format = AVAudioFormat(
            commonFormat: .pcmFormatInt16,
            sampleRate: 16_000,
            channels: 1,
            interleaved: true
        ) else { return nil }

        guard let buffer = AVAudioPCMBuffer(pcmFormat: int16Format, frameCapacity: AVAudioFrameCount(samples.count)) else {
            return nil
        }
        buffer.frameLength = AVAudioFrameCount(samples.count)

        // Convert Float32 [-1.0, 1.0] → Int16 [-32768, 32767]
        guard let int16Ptr = buffer.int16ChannelData else { return nil }
        for i in 0..<samples.count {
            let clamped = max(-1.0, min(1.0, samples[i]))
            int16Ptr[0][i] = Int16(clamped * 32767.0)
        }
        return buffer
    }

    // MARK: - Shutdown

    /// Stop both ASR and diarization, releasing all resources.
    func stop() async {
        logger.info("Stopping \(self.streamType.rawValue) pipeline")
        await transcriptionManager.stop()
        await diarizationManager.stop()
    }
}
