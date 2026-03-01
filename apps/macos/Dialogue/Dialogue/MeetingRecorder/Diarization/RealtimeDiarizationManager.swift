import AVFoundation
import FluidAudio
import Foundation
import OSLog

/// Manages streaming speaker diarization for one audio stream using
/// FluidAudio's `SortformerDiarizer` (streaming Sortformer model).
///
/// Each stream (mic / meeting) gets its own diarizer instance so that
/// speaker slots and embeddings are tracked independently. The merge
/// engine later reconciles speakers across streams.
///
/// Reference: FluidAudio v0.12.1 – SortformerDiarizerPipeline.swift
@available(macOS 26.0, *)
actor RealtimeDiarizationManager {

    // MARK: - Properties

    private let streamType: StreamType
    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "Diarization")

    /// Streaming Sortformer diarizer from FluidAudio.
    private var diarizer: SortformerDiarizer?

    /// Accumulated time offset for absolute timestamps.
    private var totalSamplesProcessed: Int = 0

    /// Frame duration from Sortformer config (default: 0.08s per frame).
    private var frameDurationSeconds: Float = 0.08

    // MARK: - Init

    init(streamType: StreamType) {
        self.streamType = streamType
    }

    // MARK: - Setup

    /// Download models and initialise the Sortformer streaming diarizer.
    func prepare() async throws {
        logger.info("Preparing SortformerDiarizer for \(self.streamType.rawValue) stream")

        let config = SortformerConfig.default
        self.frameDurationSeconds = config.frameDurationSeconds

        let sortformerDiarizer = SortformerDiarizer(config: config)

        // Download and load models from HuggingFace (cached after first run).
        let models = try await SortformerModels.loadFromHuggingFace(config: config)
        sortformerDiarizer.initialize(models: models)

        self.diarizer = sortformerDiarizer
        logger.info("SortformerDiarizer ready for \(self.streamType.rawValue) stream")
    }

    // MARK: - Streaming Processing

    /// Process a chunk of 16 kHz mono Float32 samples.
    ///
    /// Feeds audio into the Sortformer streaming pipeline and converts
    /// frame-level speaker probabilities into `TaggedSegment` values
    /// posted to the shared `MergeEngine`.
    ///
    /// - Parameters:
    ///   - samples: Audio samples (16 kHz mono Float32)
    ///   - absoluteTime: Timeline offset for the start of this chunk
    func processChunk(_ samples: [Float], at absoluteTime: TimeInterval) async {
        guard let diarizer else { return }

        do {
            if let result = try diarizer.processSamples(samples) {
                let segments = convertToTaggedSegments(result, baseTime: absoluteTime)
                for segment in segments {
                    await MergeEngine.shared.add(segment)
                }
            }
        } catch {
            logger.error("Diarization error (\(self.streamType.rawValue)): \(error.localizedDescription)")
        }

        totalSamplesProcessed += samples.count
    }

    /// Stop the diarizer and clean up resources.
    func stop() {
        diarizer?.cleanup()
        diarizer = nil
        totalSamplesProcessed = 0
    }

    // MARK: - Conversion

    /// Convert Sortformer chunk results (frame-level speaker probabilities)
    /// into discrete `TaggedSegment` objects with speaker IDs.
    private func convertToTaggedSegments(
        _ result: SortformerChunkResult,
        baseTime: TimeInterval
    ) -> [TaggedSegment] {
        let numSpeakers = 4 // Sortformer fixed slots
        let frameCount = result.frameCount
        guard frameCount > 0 else { return [] }

        // Threshold for considering a speaker "active" in a frame
        let activationThreshold: Float = 0.5
        var segments: [TaggedSegment] = []

        // Track contiguous active regions per speaker
        for speakerIndex in 0..<numSpeakers {
            var isActive = false
            var regionStart = 0

            for frame in 0..<frameCount {
                let prob = result.getSpeakerPrediction(speaker: speakerIndex, frame: frame, numSpeakers: numSpeakers)

                if prob > activationThreshold && !isActive {
                    isActive = true
                    regionStart = frame
                } else if prob <= activationThreshold && isActive {
                    isActive = false
                    let segment = makeSegment(
                        speakerIndex: speakerIndex,
                        startFrame: result.startFrame + regionStart,
                        endFrame: result.startFrame + frame,
                        baseTime: baseTime
                    )
                    if segment.duration >= 0.3 { // Minimum 300ms segment
                        segments.append(segment)
                    }
                }
            }

            // Close any open region at end of chunk
            if isActive {
                let segment = makeSegment(
                    speakerIndex: speakerIndex,
                    startFrame: result.startFrame + regionStart,
                    endFrame: result.startFrame + frameCount,
                    baseTime: baseTime
                )
                if segment.duration >= 0.3 {
                    segments.append(segment)
                }
            }
        }

        return segments.sorted { $0.start < $1.start }
    }

    private func makeSegment(
        speakerIndex: Int,
        startFrame: Int,
        endFrame: Int,
        baseTime: TimeInterval
    ) -> TaggedSegment {
        let startTime = baseTime + TimeInterval(startFrame) * TimeInterval(frameDurationSeconds)
        let endTime = baseTime + TimeInterval(endFrame) * TimeInterval(frameDurationSeconds)
        let speakerLabel = "\(streamType.rawValue)-Speaker\(speakerIndex + 1)"

        return TaggedSegment(
            stream: streamType,
            speaker: speakerLabel,
            start: startTime,
            end: endTime
        )
    }
}
