import AVFoundation
import Foundation
import OSLog
import ScreenCaptureKit

/// Manages dual audio capture: local microphone (AVAudioEngine) and
/// meeting app audio (ScreenCaptureKit per-app SCStream).
///
/// Audio from both sources is:
/// 1. Fed to independent `RealtimePipeline` instances for ASR + diarization
/// 2. Written to a single mixed WAV file via `MixedWAVRecorder`
///
/// **Per-app capture**: Only captures audio from detected meeting apps
/// (Zoom, Teams, Chrome, etc.) via `SCContentFilter(including:)`,
/// avoiding music players, notification sounds, and other noise.
///
/// Reference: ScreenCaptureKit per-app audio
/// https://developer.apple.com/documentation/screencapturekit
/// WWDC22 "Meet ScreenCaptureKit"
@available(macOS 26.0, *)
final class DualAudioEngine: NSObject, @unchecked Sendable {

    // MARK: - Properties

    private let audioEngine = AVAudioEngine()
    private let mixedRecorder = MixedWAVRecorder()
    private var micPipeline: RealtimePipeline?
    private var meetingPipeline: RealtimePipeline?
    private var scStream: SCStream?
    private var meetingApps: [SCRunningApplication] = []
    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "DualAudioEngine")

    /// Serial queue for ScreenCaptureKit audio callbacks.
    private let scAudioQueue = DispatchQueue(label: "bot.djinn.app.dialog.sc-audio", qos: .userInteractive)

    // MARK: - Start

    /// Start capturing audio from mic and/or meeting apps.
    ///
    /// - Parameters:
    ///   - micEnabled: Whether to capture local microphone audio
    ///   - meetingEnabled: Whether to capture meeting app audio
    func start(micEnabled: Bool, meetingEnabled: Bool) async throws {
        logger.info("Starting DualAudioEngine (mic: \(micEnabled), meeting: \(meetingEnabled))")
        TimelineManager.shared.start()

        // Prepare pipelines in parallel
        if micEnabled {
            let mic = MicPipeline.createMic()
            try await mic.prepare()
            self.micPipeline = mic
        }

        if meetingEnabled {
            meetingApps = await MeetingAppDetector.shared.runningMeetingApplications()
            if !meetingApps.isEmpty {
                let meeting = MeetingPipeline.createMeeting()
                try await meeting.prepare()
                self.meetingPipeline = meeting
                try await setupMeetingSCStream()
            } else {
                logger.warning("No meeting apps detected; skipping meeting audio capture")
            }
        }

        // Start WAV recorder
        try await mixedRecorder.start()

        // Install mic tap and start engine
        if micEnabled {
            let inputNode = audioEngine.inputNode
            let hwFormat = inputNode.inputFormat(forBus: 0)
            guard hwFormat.sampleRate > 0, hwFormat.channelCount > 0 else {
                throw DualAudioEngineError.noMicrophoneAvailable
            }

            inputNode.installTap(onBus: 0, bufferSize: 4096, format: hwFormat) { [weak self] buffer, _ in
                self?.handleMicBuffer(buffer)
            }
        }

        audioEngine.prepare()
        try audioEngine.start()
        logger.info("DualAudioEngine started")
    }

    // MARK: - ScreenCaptureKit Setup

    /// Configure ScreenCaptureKit to capture audio from detected meeting apps only.
    ///
    /// Uses `SCContentFilter(including:exceptingWindows:)` to scope capture
    /// to specific applications, producing clean meeting audio without
    /// system sounds or music.
    private func setupMeetingSCStream() async throws {
        guard !meetingApps.isEmpty else { return }

        let appNames = meetingApps.map(\.applicationName).joined(separator: ", ")
        logger.info("Setting up SCStream for apps: \(appNames)")

        // Get the main display for the content filter (required parameter)
        let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = shareable.displays.first else {
            throw DualAudioEngineError.screenCaptureSetupFailed("No display found")
        }

        // Per-app content filter: only capture audio from these applications
        let filter = SCContentFilter(
            display: display,
            including: meetingApps,
            exceptingWindows: []
        )

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 16_000
        config.channelCount = 1

        // We only want audio, not video — minimize video overhead
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 FPS minimum
        config.showsCursor = false

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        // Must add both .screen and .audio outputs; SCStream drops frames with errors if
        // the screen output handler is missing even when we only care about audio.
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: scAudioQueue)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: scAudioQueue)
        try await stream.startCapture()
        self.scStream = stream

        logger.info("SCStream capturing audio from \(self.meetingApps.count) app(s)")
    }

    // MARK: - Audio Buffer Handling

    /// Process a microphone buffer: feed to mic pipeline + mixed WAV recorder.
    private func handleMicBuffer(_ buffer: AVAudioPCMBuffer) {
        let time = TimelineManager.shared.currentAudioTime()
        TimelineManager.shared.advance(bySamples: buffer.frameLength)

        micPipeline?.processBuffer(buffer, at: time)

        // Write to WAV recorder. We deep-copy and use nonisolated(unsafe)
        // because AVAudioPCMBuffer is not Sendable but our copy is exclusively owned.
        let recorder = self.mixedRecorder
        if let wavSamples = MeetingAudioConverter.toFloatArray(buffer) as [Float]? {
            Task { await recorder.writeSamples(wavSamples) }
        }
    }

    /// Process a meeting app audio buffer: feed to meeting pipeline + mixed WAV recorder.
    private func handleMeetingBuffer(_ buffer: AVAudioPCMBuffer) {
        let time = TimelineManager.shared.currentAudioTime()
        if micPipeline == nil {
            TimelineManager.shared.advance(bySamples: buffer.frameLength)
        }

        meetingPipeline?.processBuffer(buffer, at: time)

        let recorder = self.mixedRecorder
        if let wavSamples = MeetingAudioConverter.toFloatArray(buffer) as [Float]? {
            Task { await recorder.writeSamples(wavSamples) }
        }
    }

    // MARK: - Stop

    /// Stop all capture and return the recorded WAV file URL.
    func stop() async -> URL? {
        logger.info("Stopping DualAudioEngine")

        // Stop AVAudioEngine
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)

        // Stop ScreenCaptureKit
        if let stream = scStream {
            try? await stream.stopCapture()
            self.scStream = nil
        }

        // Stop pipelines
        await micPipeline?.stop()
        await meetingPipeline?.stop()
        micPipeline = nil
        meetingPipeline = nil
        meetingApps = []

        // Stop WAV recorder and get file URL
        let wavURL = await mixedRecorder.stop()
        logger.info("DualAudioEngine stopped")
        return wavURL
    }
}

// MARK: - SCStreamOutput

@available(macOS 26.0, *)
extension DualAudioEngine: SCStreamOutput {
    /// Called by ScreenCaptureKit when a new audio sample buffer arrives
    /// from the meeting application(s).
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }

        // Convert CMSampleBuffer → AVAudioPCMBuffer
        guard let pcmBuffer = MeetingAudioConverter.pcmBuffer(from: sampleBuffer) else {
            return
        }

        handleMeetingBuffer(pcmBuffer)
    }
}

// MARK: - Errors

enum DualAudioEngineError: Error, LocalizedError {
    case noMicrophoneAvailable
    case screenCaptureSetupFailed(String)

    var errorDescription: String? {
        switch self {
        case .noMicrophoneAvailable:
            return "No microphone available. Check System Preferences > Sound > Input."
        case .screenCaptureSetupFailed(let reason):
            return "Failed to set up screen capture: \(reason)"
        }
    }
}
