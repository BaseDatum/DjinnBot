import SwiftUI
import AVFoundation
import CoreAudio
import FluidAudio

// MARK: - VoiceEnrollmentView

/// A modal view that guides the user through recording a voice sample
/// for primary speaker enrollment ("You").
struct VoiceEnrollmentView: View {
    @ObservedObject var viewModel: VoiceEnrollmentViewModel
    var onComplete: () -> Void
    var onSkip: () -> Void
    
    var body: some View {
        VStack(spacing: 24) {
            // Header
            Image(systemName: "waveform.circle.fill")
                .font(.system(size: 48))
                .foregroundStyle(.tint)
            
            Text("Welcome to Dialogue")
                .font(.title2)
                .fontWeight(.semibold)
            
            Text("Press Record and read the paragraph below out loud in your normal speaking voice.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 400)
            
            // Reading script — doubles as Dialogue marketing copy
            GroupBox {
                Text(Self.enrollmentScript)
                    .font(.system(.body, design: .serif))
                    .lineSpacing(4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .textSelection(.enabled)
            }
            .frame(maxWidth: 400)
            
            // Recording visualization
            VStack(spacing: 12) {
                // Waveform / level indicator
                ZStack {
                    RoundedRectangle(cornerRadius: 12)
                        .fill(Color(.controlBackgroundColor))
                        .frame(height: 60)
                    
                    if viewModel.isRecording {
                        WaveformView(
                            level: viewModel.audioLevel,
                            width: 320,
                            height: 50
                        )
                        .frame(width: 320, height: 50)
                    } else if viewModel.isProcessing {
                        ProgressView("Processing voice sample...")
                            .progressViewStyle(.circular)
                    } else if viewModel.enrollmentComplete {
                        Label("Voice enrolled successfully", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                    } else {
                        Text("Press Record to begin")
                            .foregroundStyle(.tertiary)
                    }
                }
                .frame(maxWidth: 360)
                
                // Duration indicator
                if viewModel.isRecording {
                    HStack {
                        Circle()
                            .fill(.red)
                            .frame(width: 8, height: 8)
                        
                        Text(formatDuration(viewModel.recordingDuration))
                            .font(.system(.body, design: .monospaced))
                        
                        Spacer()
                        
                        if viewModel.recordingDuration >= 20 {
                            Text("Ready - press Stop when done")
                                .font(.caption)
                                .foregroundStyle(.green)
                        } else {
                            Text("Keep speaking... (\(20 - Int(viewModel.recordingDuration))s more)")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: 360)
                }
            }
            
            // Error
            if let error = viewModel.errorMessage {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .frame(maxWidth: 360)
            }
            
            // Microphone selector (shown before and during recording)
            if !viewModel.enrollmentComplete && !viewModel.isProcessing {
                HStack(spacing: 8) {
                    Image(systemName: "mic")
                        .foregroundStyle(.secondary)
                    
                    Picker("Microphone", selection: $viewModel.selectedDeviceID) {
                        Text("System Default").tag(AudioDeviceID?.none)
                        ForEach(viewModel.availableDevices) { device in
                            Text(device.name).tag(AudioDeviceID?.some(device.id))
                        }
                    }
                    .labelsHidden()
                    .frame(maxWidth: 240)
                    .disabled(viewModel.isRecording)
                }
            }
            
            // Controls
            HStack(spacing: 16) {
                if viewModel.enrollmentComplete {
                    Button("Done") {
                        onComplete()
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                } else if viewModel.isRecording {
                    Button("Stop") {
                        viewModel.stopRecording()
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.red)
                    .controlSize(.large)
                    .disabled(viewModel.recordingDuration < 5) // Minimum 5s
                } else if !viewModel.isProcessing {
                    Button("Record") {
                        viewModel.startRecording()
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    
                    Button("Skip for Now") {
                        onSkip()
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                }
            }
        }
        .padding(32)
        .frame(width: 480)
        .frame(minHeight: 580, maxHeight: 700)
    }
    
    // MARK: - Enrollment Script
    
    /// A ~30-second reading passage that introduces Dialogue's features while
    /// capturing a wide range of phonemes, pitch variation, and natural cadence
    /// for robust voice enrollment.
    private static let enrollmentScript = """
    Dialogue makes meetings effortless. It records and transcribes your \
    calls in real time, automatically captures action items, and keeps your \
    calendar up to date. Whether you're joining a quick check-in or a \
    major project review, Dialogue handles the busywork so you can focus \
    on the conversation. Never worry about forgetting a follow-up or \
    losing track of who said what -- everything is organized and \
    searchable the moment your meeting ends.
    """
    
    private func formatDuration(_ seconds: TimeInterval) -> String {
        let m = Int(seconds) / 60
        let s = Int(seconds) % 60
        return String(format: "%d:%02d", m, s)
    }
}

// MARK: - VoiceEnrollmentViewModel

@MainActor
final class VoiceEnrollmentViewModel: ObservableObject {
    @Published var isRecording = false
    @Published var isProcessing = false
    @Published var enrollmentComplete = false
    @Published var recordingDuration: TimeInterval = 0
    @Published var audioLevel: Float = 0
    @Published var errorMessage: String?
    
    /// Available input (microphone) devices.
    @Published var availableDevices: [AudioDeviceInfo] = []
    /// Currently selected device ID. `nil` means system default.
    @Published var selectedDeviceID: AudioDeviceID?
    
    private var audioEngine: AVAudioEngine?
    private var recordedSamples: [Float] = []
    private var recordingTimer: Timer?
    private var recordingStartDate: Date?
    
    /// Target format: 16 kHz mono Float32.
    private let sampleRate: Double = 16000
    
    init() {
        availableDevices = AudioEngineManager.enumerateInputDevices()
    }
    
    // MARK: - Recording
    
    func startRecording() {
        errorMessage = nil
        recordedSamples.removeAll()
        
        let engine = AVAudioEngine()
        let input = engine.inputNode
        
        // Apply selected input device AFTER accessing inputNode but BEFORE
        // querying the format — matches AudioEngineManager.startCapture() ordering.
        // The node must exist first, then the device switch updates its hardware format.
        if let deviceID = selectedDeviceID {
            setInputDevice(deviceID, on: engine)
        }
        
        let inputFormat = input.outputFormat(forBus: 0)
        
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            errorMessage = "Microphone not available — check System Settings > Privacy & Security > Microphone"
            return
        }
        
        guard let targetFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        ) else {
            errorMessage = "Failed to create audio format"
            return
        }
        
        let converter = AVAudioConverter(from: inputFormat, to: targetFormat)
        
        input.installTap(onBus: 0, bufferSize: 4096, format: inputFormat) { [weak self] buffer, _ in
            guard let self = self else { return }
            
            let frameCount = AVAudioFrameCount(
                Double(buffer.frameLength) * self.sampleRate / inputFormat.sampleRate
            )
            guard frameCount > 0,
                  let converted = AVAudioPCMBuffer(pcmFormat: targetFormat, frameCapacity: frameCount) else { return }
            
            var error: NSError?
            var consumed = false
            converter?.convert(to: converted, error: &error) { _, outStatus in
                if consumed {
                    outStatus.pointee = .noDataNow
                    return nil
                }
                consumed = true
                outStatus.pointee = .haveData
                return buffer
            }
            
            guard error == nil, converted.frameLength > 0,
                  let channelData = converted.floatChannelData else { return }
            
            let samples = Array(UnsafeBufferPointer(
                start: channelData[0],
                count: Int(converted.frameLength)
            ))
            
            let rms = AudioEngineManager.computeRMS(samples)
            
            DispatchQueue.main.async { [weak self] in
                self?.recordedSamples.append(contentsOf: samples)
                self?.audioLevel = rms
            }
        }
        
        do {
            try engine.start()
            self.audioEngine = engine
            self.isRecording = true
            self.recordingStartDate = Date()
            
            recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self = self, let start = self.recordingStartDate else { return }
                    self.recordingDuration = Date().timeIntervalSince(start)
                    
                    // Auto-stop at 45 seconds
                    if self.recordingDuration >= 45 {
                        self.stopRecording()
                    }
                }
            }
        } catch {
            errorMessage = "Failed to start recording: \(error.localizedDescription)"
        }
    }
    
    func stopRecording() {
        recordingTimer?.invalidate()
        recordingTimer = nil
        audioEngine?.inputNode.removeTap(onBus: 0)
        audioEngine?.stop()
        audioEngine = nil
        isRecording = false
        audioLevel = 0
        
        // Process the recording to extract embedding
        processEnrollment()
    }
    
    // MARK: - Enrollment Processing
    
    private func processEnrollment() {
        guard recordedSamples.count >= Int(sampleRate * 5) else {
            errorMessage = "Recording too short. Please record at least 5 seconds."
            return
        }
        
        isProcessing = true
        
        Task {
            do {
                // Use FluidAudio to extract speaker embedding from the recording
                let models = try await DiarizerModels.download()
                let manager = DiarizerManager()
                manager.initialize(models: models)
                
                let result = try manager.performCompleteDiarization(
                    recordedSamples,
                    sampleRate: Int(sampleRate)
                )
                
                // Collect all embeddings from the recording
                let embeddings = result.segments.map { $0.embedding }
                guard !embeddings.isEmpty else {
                    errorMessage = "Could not detect voice in recording. Please try again in a quiet environment."
                    isProcessing = false
                    return
                }
                
                let avgEmbedding = averageEmbeddings(embeddings)
                
                // Enroll as primary user
                try VoiceProfileManager.shared.enrollPrimaryUser(embedding: avgEmbedding)
                
                enrollmentComplete = true
                isProcessing = false
                
            } catch {
                errorMessage = "Enrollment failed: \(error.localizedDescription)"
                isProcessing = false
            }
        }
    }
    
    // MARK: - Device Selection
    
    /// Set the audio input device on an AVAudioEngine.
    /// Must be called AFTER accessing `engine.inputNode` (to initialize the node)
    /// but BEFORE `engine.start()`.
    private func setInputDevice(_ deviceID: AudioDeviceID, on engine: AVAudioEngine) {
        var deviceIDVar = deviceID
        let status = AudioUnitSetProperty(
            engine.inputNode.audioUnit!,
            kAudioOutputUnitProperty_CurrentDevice,
            kAudioUnitScope_Global,
            0,
            &deviceIDVar,
            UInt32(MemoryLayout<AudioDeviceID>.size)
        )
        if status != noErr {
            print("[Dialogue] Failed to set enrollment input device: \(status)")
            errorMessage = "Failed to select microphone (error \(status))"
        }
    }
    
    /// Compute the element-wise average of multiple embedding vectors.
    private func averageEmbeddings(_ embeddings: [[Float]]) -> [Float] {
        guard let first = embeddings.first else { return [] }
        guard embeddings.count > 1 else { return first }
        
        var avg = [Float](repeating: 0, count: first.count)
        for emb in embeddings {
            for i in 0..<min(avg.count, emb.count) {
                avg[i] += emb[i]
            }
        }
        let count = Float(embeddings.count)
        return avg.map { $0 / count }
    }
}
