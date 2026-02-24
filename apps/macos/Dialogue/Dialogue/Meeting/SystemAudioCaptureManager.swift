import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia

// MARK: - SystemAudioCaptureManager

/// Captures system audio (all app output) using ScreenCaptureKit.
/// This picks up remote meeting participants whose audio plays through the system.
/// Requires macOS 15.0+ and the user to grant Screen Recording permission
/// (even though we only capture audio, not video).
@MainActor
final class SystemAudioCaptureManager: NSObject, ObservableObject {
    
    // MARK: - Published State
    
    @Published var isCapturing: Bool = false
    @Published var currentLevel: Float = 0
    @Published var permissionGranted: Bool = false
    @Published var errorMessage: String?
    
    // MARK: - Callback
    
    /// Called on a background queue with each new system audio buffer (16 kHz mono Float32).
    /// Set this before calling `startCapture()`.
    nonisolated(unsafe) var onAudioBuffer: ((_ samples: [Float], _ timestamp: TimeInterval) -> Void)?
    
    // MARK: - Private
    
    private var stream: SCStream?
    private var startTime: Date?
    private let processingQueue = DispatchQueue(label: "bot.djinn.dialogue.sysaudio", qos: .userInteractive)
    
    /// Target format for resampling.
    private let targetSampleRate: Double = 16000
    
    // MARK: - Permission Check
    
    /// Check if we have screen recording permission (required for system audio capture).
    func checkPermission() async {
        do {
            // Attempting to get shareable content tests the permission
            let _ = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            permissionGranted = true
        } catch {
            permissionGranted = false
            errorMessage = "Screen Recording permission required for system audio capture. Grant it in System Settings > Privacy & Security > Screen Recording."
        }
    }
    
    // MARK: - Start / Stop
    
    /// Start capturing system audio.
    /// - Parameter excludingBundleID: Optional bundle ID to exclude from capture
    ///   (e.g. our own app to avoid feedback).
    func startCapture(excludingBundleID: String? = "bot.djinn.app.dialog") async throws {
        guard !isCapturing else { return }
        
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        
        // Build filter: capture all audio, optionally excluding our own app
        let filter: SCContentFilter
        if let bundleID = excludingBundleID,
           let ownApp = content.applications.first(where: { $0.bundleIdentifier == bundleID }) {
            // Exclude our own app from system audio capture to prevent feedback
            filter = SCContentFilter(display: content.displays.first!, excludingApplications: [ownApp], exceptingWindows: [])
        } else {
            filter = SCContentFilter(display: content.displays.first!, excludingApplications: [], exceptingWindows: [])
        }
        
        // Configure: audio only, no video
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48000           // Capture at native rate
        config.channelCount = 1             // Mono
        
        // No video capture (minimizes overhead)
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1) // 1 FPS minimum
        config.showsCursor = false
        
        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: processingQueue)
        try await stream.startCapture()
        
        self.stream = stream
        self.startTime = Date()
        self.isCapturing = true
        self.errorMessage = nil
    }
    
    /// Stop capturing system audio.
    func stopCapture() async {
        guard isCapturing, let stream = stream else { return }
        
        do {
            try await stream.stopCapture()
        } catch {
            print("[Dialogue] Error stopping system audio capture: \(error)")
        }
        
        self.stream = nil
        self.startTime = nil
        self.isCapturing = false
        self.currentLevel = 0
    }
}

// MARK: - SCStreamOutput

extension SystemAudioCaptureManager: SCStreamOutput {
    
    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio else { return }
        guard sampleBuffer.isValid, sampleBuffer.numSamples > 0 else { return }
        
        // Extract audio samples from the CMSampleBuffer
        guard let blockBuffer = sampleBuffer.dataBuffer else { return }
        
        var lengthAtOffset: Int = 0
        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>?
        
        let status = CMBlockBufferGetDataPointer(
            blockBuffer,
            atOffset: 0,
            lengthAtOffsetOut: &lengthAtOffset,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard status == noErr, let dataPointer = dataPointer else { return }
        
        // Get the audio format description
        guard let formatDesc = sampleBuffer.formatDescription,
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(formatDesc)?.pointee else {
            return
        }
        
        let sourceSampleRate = asbd.mSampleRate
        let channelCount = Int(asbd.mChannelsPerFrame)
        let bytesPerFrame = Int(asbd.mBytesPerFrame)
        let sampleCount = totalLength / bytesPerFrame
        
        guard sampleCount > 0, bytesPerFrame > 0 else { return }
        
        // Convert to Float32 mono samples
        var floatSamples: [Float]
        
        if asbd.mFormatFlags & kAudioFormatFlagIsFloat != 0 {
            // Already float format
            let floatPtr = UnsafeRawPointer(dataPointer).bindMemory(to: Float.self, capacity: sampleCount * channelCount)
            if channelCount == 1 {
                floatSamples = Array(UnsafeBufferPointer(start: floatPtr, count: sampleCount))
            } else {
                // Downmix to mono
                floatSamples = [Float](repeating: 0, count: sampleCount)
                for i in 0..<sampleCount {
                    var sum: Float = 0
                    for ch in 0..<channelCount {
                        sum += floatPtr[i * channelCount + ch]
                    }
                    floatSamples[i] = sum / Float(channelCount)
                }
            }
        } else if asbd.mBitsPerChannel == 16 {
            // Int16 format
            let int16Ptr = UnsafeRawPointer(dataPointer).bindMemory(to: Int16.self, capacity: sampleCount * channelCount)
            floatSamples = [Float](repeating: 0, count: sampleCount)
            for i in 0..<sampleCount {
                if channelCount == 1 {
                    floatSamples[i] = Float(int16Ptr[i]) / 32768.0
                } else {
                    var sum: Float = 0
                    for ch in 0..<channelCount {
                        sum += Float(int16Ptr[i * channelCount + ch]) / 32768.0
                    }
                    floatSamples[i] = sum / Float(channelCount)
                }
            }
        } else {
            return // Unsupported format
        }
        
        // Resample to 16 kHz if needed
        if sourceSampleRate != targetSampleRate {
            floatSamples = resample(floatSamples, from: sourceSampleRate, to: targetSampleRate)
        }
        
        guard !floatSamples.isEmpty else { return }
        
        // Compute level
        let rms = AudioEngineManager.computeRMS(floatSamples)
        DispatchQueue.main.async { [weak self] in
            self?.currentLevel = rms
        }
        
        // Compute timestamp
        let timestamp: TimeInterval
        let presentationTime = sampleBuffer.presentationTimeStamp
        if presentationTime.isValid {
            timestamp = presentationTime.seconds
        } else {
            timestamp = 0
        }
        
        onAudioBuffer?(floatSamples, timestamp)
    }
    
    /// Simple linear interpolation resampler.
    nonisolated private func resample(_ samples: [Float], from sourceSR: Double, to targetSR: Double) -> [Float] {
        let ratio = targetSR / sourceSR
        let outputCount = Int(Double(samples.count) * ratio)
        guard outputCount > 0 else { return [] }
        
        var output = [Float](repeating: 0, count: outputCount)
        for i in 0..<outputCount {
            let srcIdx = Double(i) / ratio
            let srcIdxFloor = Int(srcIdx)
            let frac = Float(srcIdx - Double(srcIdxFloor))
            
            let s0 = samples[min(srcIdxFloor, samples.count - 1)]
            let s1 = samples[min(srcIdxFloor + 1, samples.count - 1)]
            output[i] = s0 + frac * (s1 - s0)
        }
        return output
    }
}
