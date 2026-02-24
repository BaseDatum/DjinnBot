import Foundation
import AVFoundation
import Combine

// MARK: - AudioEngineManager

/// Manages AVAudioEngine for capturing microphone or system audio (via BlackHole/Loopback).
/// Provides:
///   - Real-time audio level metering (for waveform display)
///   - Raw PCM buffer stream for ASR and diarization
///   - WAV file recording to disk
@MainActor
final class AudioEngineManager: ObservableObject {
    
    // MARK: - Published State
    
    /// Current RMS audio level (0.0 – 1.0), updated at ~60 Hz for waveform.
    @Published var currentLevel: Float = 0
    
    /// Whether the engine is actively capturing audio.
    @Published var isCapturing: Bool = false
    
    /// Whether capture is paused (engine running but not forwarding buffers).
    @Published var isPaused: Bool = false
    
    /// Available input devices.
    @Published var availableInputDevices: [AudioDeviceInfo] = []
    
    /// Currently selected input device ID (nil = system default).
    @Published var selectedDeviceID: AudioDeviceID?
    
    // MARK: - Callbacks
    
    /// Called on a background queue with each new audio buffer (16 kHz mono Float32).
    /// Consumers: StreamingTranscriptionService, RealTimeDiarizationService.
    var onAudioBuffer: ((_ samples: [Float], _ timestamp: TimeInterval) -> Void)?
    
    // MARK: - Private
    
    private var audioEngine: AVAudioEngine?
    private var inputNode: AVAudioInputNode?
    private var fileWriter: AVAudioFile?
    private var recordingStartTime: Date?
    private let processingQueue = DispatchQueue(label: "bot.djinn.dialogue.audio", qos: .userInteractive)
    
    /// Target format for ASR/diarization: 16 kHz, mono, Float32.
    private let targetSampleRate: Double = 16000
    private let targetChannelCount: AVAudioChannelCount = 1
    
    /// Buffer size for tap (number of frames per callback).
    private let bufferSize: AVAudioFrameCount = 4096
    
    init() {
        refreshDeviceList()
    }
    
    // MARK: - Device Enumeration
    
    /// Refresh the list of available audio input devices.
    func refreshDeviceList() {
        availableInputDevices = Self.enumerateInputDevices()
    }
    
    /// Returns all audio input devices on the system.
    static func enumerateInputDevices() -> [AudioDeviceInfo] {
        var propSize: UInt32 = 0
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDevices,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        
        AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize)
        let deviceCount = Int(propSize) / MemoryLayout<AudioDeviceID>.size
        var deviceIDs = [AudioDeviceID](repeating: 0, count: deviceCount)
        AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &propSize, &deviceIDs)
        
        return deviceIDs.compactMap { deviceID -> AudioDeviceInfo? in
            // Check if device has input channels
            var inputAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyStreamConfiguration,
                mScope: kAudioDevicePropertyScopeInput,
                mElement: kAudioObjectPropertyElementMain
            )
            var bufferListSize: UInt32 = 0
            AudioObjectGetPropertyDataSize(deviceID, &inputAddress, 0, nil, &bufferListSize)
            
            let bufferListPtr = UnsafeMutableRawPointer.allocate(
                byteCount: Int(bufferListSize),
                alignment: MemoryLayout<AudioBufferList>.alignment
            )
            defer { bufferListPtr.deallocate() }
            
            AudioObjectGetPropertyData(deviceID, &inputAddress, 0, nil, &bufferListSize, bufferListPtr)
            let bufferList = bufferListPtr.assumingMemoryBound(to: AudioBufferList.self).pointee
            
            let channelCount = (0..<Int(bufferList.mNumberBuffers)).reduce(0) { total, i in
                let buffer = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: bufferListPtr.assumingMemoryBound(to: AudioBufferList.self)))[i]
                return total + Int(buffer.mNumberChannels)
            }
            guard channelCount > 0 else { return nil }
            
            // Get device name
            var nameAddress = AudioObjectPropertyAddress(
                mSelector: kAudioDevicePropertyDeviceNameCFString,
                mScope: kAudioObjectPropertyScopeGlobal,
                mElement: kAudioObjectPropertyElementMain
            )
            var name: CFString = "" as CFString
            var nameSize = UInt32(MemoryLayout<CFString>.size)
            AudioObjectGetPropertyData(deviceID, &nameAddress, 0, nil, &nameSize, &name)
            
            return AudioDeviceInfo(
                id: deviceID,
                name: name as String,
                inputChannels: channelCount
            )
        }
    }
    
    // MARK: - Start / Stop
    
    /// Start capturing audio from the selected input device.
    /// - Parameter fileURL: Optional URL to simultaneously write a WAV file.
    func startCapture(writingTo fileURL: URL? = nil) throws {
        guard !isCapturing else { return }
        
        let engine = AVAudioEngine()
        let input = engine.inputNode
        
        // Select specific device if requested
        if let deviceID = selectedDeviceID {
            setInputDevice(deviceID, on: engine)
        }
        
        let inputFormat = input.outputFormat(forBus: 0)
        
        // Create converter to target format (16 kHz mono Float32)
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: targetSampleRate,
            channels: targetChannelCount,
            interleaved: false
        ) else {
            throw AudioEngineError.formatCreationFailed
        }
        
        let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        
        // Set up file writer if requested
        if let url = fileURL {
            fileWriter = try AVAudioFile(
                forWriting: url,
                settings: targetFormat.settings,
                commonFormat: .pcmFormatFloat32,
                interleaved: false
            )
        }
        
        recordingStartTime = Date()
        
        // Install tap on input node
        input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { [weak self] buffer, time in
            self?.processingQueue.async { [weak self] in
                guard let self = self else { return }
                
                // Skip if paused
                let paused = DispatchQueue.main.sync { self.isPaused }
                guard !paused else { return }
                
                // Convert to target format
                let frameCount = AVAudioFrameCount(
                    Double(buffer.frameLength) * self.targetSampleRate / inputFormat.sampleRate
                )
                guard frameCount > 0,
                      let convertedBuffer = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCount) else {
                    return
                }
                
                var error: NSError?
                if let converter = converter {
                    var consumed = false
                    converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                        if consumed {
                            outStatus.pointee = .noDataNow
                            return nil
                        }
                        consumed = true
                        outStatus.pointee = .haveData
                        return buffer
                    }
                }
                
                guard error == nil, convertedBuffer.frameLength > 0 else { return }
                
                // Extract float samples
                guard let channelData = convertedBuffer.floatChannelData else { return }
                let samples = Array(UnsafeBufferPointer(
                    start: channelData[0],
                    count: Int(convertedBuffer.frameLength)
                ))
                
                // Compute RMS for metering
                let rms = Self.computeRMS(samples)
                DispatchQueue.main.async { [weak self] in
                    self?.currentLevel = rms
                }
                
                // Write to file
                if let writer = self.fileWriter {
                    try? writer.write(from: convertedBuffer)
                }
                
                // Compute timestamp relative to recording start
                let timestamp: TimeInterval
                if let start = self.recordingStartTime {
                    timestamp = Date().timeIntervalSince(start)
                } else {
                    timestamp = 0
                }
                
                // Forward to consumers
                self.onAudioBuffer?(samples, timestamp)
            }
        }
        
        try engine.start()
        
        self.audioEngine = engine
        self.inputNode = input
        self.isCapturing = true
        self.isPaused = false
    }
    
    /// Stop capturing and release resources.
    func stopCapture() {
        inputNode?.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        inputNode = nil
        fileWriter = nil
        recordingStartTime = nil
        isCapturing = false
        isPaused = false
        currentLevel = 0
    }
    
    /// Pause/resume audio forwarding (engine keeps running).
    func togglePause() {
        isPaused.toggle()
        if isPaused {
            currentLevel = 0
        }
    }
    
    // MARK: - Helpers
    
    private func setInputDevice(_ deviceID: AudioDeviceID, on engine: AVAudioEngine) {
        let inputNode = engine.inputNode
        var deviceIDVar = deviceID
        let status = AudioUnitSetProperty(
            inputNode.audioUnit!,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceIDVar,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status != noErr {
            print("[Dialogue] Failed to set audio input device: \(status)")
        }
    }
    
    /// Compute RMS level from float samples (0.0 – 1.0 range, clamped).
    nonisolated static func computeRMS(_ samples: [Float]) -> Float {
        guard !samples.isEmpty else { return 0 }
        let sumOfSquares = samples.reduce(Float(0)) { $0 + $1 * $1 }
        let rms = sqrt(sumOfSquares / Float(samples.count))
        return min(rms * 3.0, 1.0) // Scale up for visual display
    }
}

// MARK: - AudioDeviceInfo

struct AudioDeviceInfo: Identifiable, Hashable {
    let id: AudioDeviceID
    let name: String
    let inputChannels: Int
}

// MARK: - Errors

enum AudioEngineError: LocalizedError {
    case formatCreationFailed
    case deviceNotFound
    
    var errorDescription: String? {
        switch self {
        case .formatCreationFailed: return "Failed to create target audio format"
        case .deviceNotFound:       return "Selected audio device not found"
        }
    }
}
