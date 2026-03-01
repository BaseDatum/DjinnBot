import AVFoundation
import Foundation
import OSLog

/// Records a mixed-down 16 kHz mono WAV file from all audio streams in parallel.
///
/// Buffers from both mic and meeting pipelines are written sequentially to a
/// single WAV file via `AVAudioFile`. The output is suitable for archival and
/// post-hoc re-processing.
actor MixedWAVRecorder {

    // MARK: - Properties

    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "WAVRecorder")
    private var audioFile: AVAudioFile?
    private var outputURL: URL?
    private var totalFramesWritten: AVAudioFrameCount = 0

    /// Target format for the output WAV file.
    private let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!

    // MARK: - Lifecycle

    /// Begin recording to a new WAV file in the app's recordings directory.
    func start() throws {
        let recordingsDir = Self.recordingsDirectory()
        try FileManager.default.createDirectory(at: recordingsDir, withIntermediateDirectories: true)

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        let filename = "meeting_\(formatter.string(from: Date())).wav"
        let url = recordingsDir.appendingPathComponent(filename)

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatLinearPCM),
            AVSampleRateKey: 16_000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
        ]

        audioFile = try AVAudioFile(forWriting: url, settings: settings)
        outputURL = url
        totalFramesWritten = 0
        logger.info("WAV recording started: \(url.lastPathComponent)")
    }

    /// Write an audio buffer to the WAV file.
    ///
    /// The buffer is first converted to 16 kHz mono if needed.
    func write(_ buffer: AVAudioPCMBuffer) {
        guard let converted = MeetingAudioConverter.convertTo16kMono(buffer) else { return }
        guard let file = audioFile else { return }

        do {
            try file.write(from: converted)
            totalFramesWritten += converted.frameLength
        } catch {
            logger.error("WAV write error: \(error.localizedDescription)")
        }
    }

    /// Write pre-extracted Float32 samples to the WAV file (Sendable-safe entry point).
    ///
    /// Reconstructs an `AVAudioPCMBuffer` from the float array inside actor isolation,
    /// avoiding the need to send non-Sendable `AVAudioPCMBuffer` across boundaries.
    func writeSamples(_ samples: [Float]) {
        guard !samples.isEmpty, let file = audioFile else { return }
        guard let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(samples.count)) else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        guard let channelData = buffer.floatChannelData else { return }
        samples.withUnsafeBufferPointer { src in
            channelData[0].update(from: src.baseAddress!, count: samples.count)
        }
        do {
            try file.write(from: buffer)
            totalFramesWritten += buffer.frameLength
        } catch {
            logger.error("WAV write error: \(error.localizedDescription)")
        }
    }

    /// Stop recording and return the file URL.
    func stop() -> URL? {
        let url = outputURL
        let frames = totalFramesWritten
        audioFile = nil
        outputURL = nil
        totalFramesWritten = 0

        if let url {
            let durationSec = Double(frames) / 16_000.0
            logger.info("WAV recording stopped: \(url.lastPathComponent) (\(String(format: "%.1f", durationSec))s)")
        }
        return url
    }

    // MARK: - Directory

    static func recordingsDirectory() -> URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        return appSupport
            .appendingPathComponent("Dialogue", isDirectory: true)
            .appendingPathComponent("Recordings", isDirectory: true)
    }
}
