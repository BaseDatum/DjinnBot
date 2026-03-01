import AVFoundation
import Accelerate

/// Utilities for converting audio buffers between formats.
///
/// The meeting recorder standardises on **16 kHz mono Float32** for both
/// the SpeechAnalyzer and FluidAudio diarization pipelines.
enum MeetingAudioConverter {

    /// Target format: 16 kHz, mono, Float32, non-interleaved.
    static let targetFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!

    // MARK: - Buffer Conversion

    /// Convert an arbitrary PCM buffer to 16 kHz mono Float32.
    ///
    /// Returns the original buffer unchanged if it already matches the target format.
    /// Uses AVAudioConverter for sample-rate conversion when needed.
    static func convertTo16kMono(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let srcFormat = buffer.format

        // Already in target format
        if srcFormat.sampleRate == 16_000,
           srcFormat.channelCount == 1,
           srcFormat.commonFormat == .pcmFormatFloat32 {
            return buffer
        }

        guard let converter = AVAudioConverter(from: srcFormat, to: targetFormat) else {
            return nil
        }

        // Calculate output frame capacity
        let ratio = targetFormat.sampleRate / srcFormat.sampleRate
        let outputFrameCount = AVAudioFrameCount(Double(buffer.frameLength) * ratio)
        guard outputFrameCount > 0,
              let outputBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: outputFrameCount) else {
            return nil
        }

        var error: NSError?
        var consumed = false
        converter.convert(to: outputBuffer, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        if let error {
            print("[MeetingAudioConverter] Conversion error: \(error.localizedDescription)")
            return nil
        }
        return outputBuffer
    }

    // MARK: - Float Array Extraction

    /// Extract a contiguous `[Float]` from a PCM buffer's first channel.
    static func toFloatArray(_ buffer: AVAudioPCMBuffer) -> [Float] {
        guard let channelData = buffer.floatChannelData else { return [] }
        let count = Int(buffer.frameLength)
        return Array(UnsafeBufferPointer(start: channelData[0], count: count))
    }

    // MARK: - CMSampleBuffer → AVAudioPCMBuffer

    /// Convert a `CMSampleBuffer` (from ScreenCaptureKit) to `AVAudioPCMBuffer`.
    ///
    /// ScreenCaptureKit delivers audio as `CMSampleBuffer`; this bridges it to
    /// AVFoundation for the processing pipeline.
    static func pcmBuffer(from sampleBuffer: CMSampleBuffer) -> AVAudioPCMBuffer? {
        guard let formatDescription = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else {
            return nil
        }

        guard let avFormat = AVAudioFormat(streamDescription: asbd) else {
            return nil
        }

        let frameCount = CMSampleBufferGetNumSamples(sampleBuffer)
        guard frameCount > 0,
              let pcmBuffer = AVAudioPCMBuffer(pcmFormat: avFormat, frameCapacity: AVAudioFrameCount(frameCount)) else {
            return nil
        }
        pcmBuffer.frameLength = AVAudioFrameCount(frameCount)

        // Copy sample data into the PCM buffer
        guard let blockBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else {
            return nil
        }

        var lengthAtOffset: Int = 0
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        let status = CMBlockBufferGetDataPointer(
            blockBuffer, atOffset: 0, lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength, dataPointerOut: &dataPointer
        )

        guard status == noErr, let srcData = dataPointer else {
            return nil
        }

        // Copy bytes into the audio buffer
        if let mutableAudioData = pcmBuffer.audioBufferList.pointee.mBuffers.mData {
            memcpy(mutableAudioData, srcData, min(totalLength, Int(pcmBuffer.audioBufferList.pointee.mBuffers.mDataByteSize)))
        }

        return pcmBuffer
    }
}
