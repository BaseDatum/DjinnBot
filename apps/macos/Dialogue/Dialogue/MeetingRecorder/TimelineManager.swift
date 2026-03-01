import AVFoundation
import Foundation
import os

/// Shared singleton managing the audio timeline clock.
///
/// All audio buffers from both mic and meeting streams reference this
/// clock so that diarization segments and ASR results share a single
/// monotonic time base.
final class TimelineManager: ObservableObject, @unchecked Sendable {
    static let shared = TimelineManager()

    let sampleRate: Double = 16_000.0

    /// Host-time anchor captured when recording starts.
    private(set) var recordingStartHostTime: TimeInterval = 0

    /// Total audio samples processed (used for WAV length calculation).
    private let lock = NSLock()
    private var _sampleCount: UInt64 = 0

    private init() {}

    // MARK: - Lifecycle

    func start() {
        recordingStartHostTime = CACurrentMediaTime()
        lock.lock()
        _sampleCount = 0
        lock.unlock()
    }

    // MARK: - Timing

    /// Advance the sample counter by the given frame count.
    func advance(bySamples count: AVAudioFrameCount) {
        lock.lock()
        _sampleCount += UInt64(count)
        lock.unlock()
    }

    /// Cumulative audio seconds based on sample counter.
    var cumulativeAudioSeconds: TimeInterval {
        lock.lock()
        let count = _sampleCount
        lock.unlock()
        return Double(count) / sampleRate
    }

    /// Wall-clock offset since recording started.
    func currentAudioTime() -> TimeInterval {
        CACurrentMediaTime() - recordingStartHostTime
    }

    /// Current position expressed as CMTime (for SpeechAnalyzer input).
    func cmTimeNow() -> CMTime {
        CMTime(seconds: cumulativeAudioSeconds, preferredTimescale: 1_000)
    }
}
