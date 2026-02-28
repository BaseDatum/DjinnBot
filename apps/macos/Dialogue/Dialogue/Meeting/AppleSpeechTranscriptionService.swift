import AVFoundation
import Foundation
import Speech

// MARK: - AppleSpeechTranscriptionService

/// Wraps Apple's SpeechAnalyzer / SpeechTranscriber (macOS 26+) for real-time
/// speech-to-text. Runs two independent analyzer sessions — one for microphone
/// audio and one for system audio — mirroring the dual-source pattern used by
/// the FluidAudio service.
///
/// The model is managed by the OS (downloaded via AssetInventory, auto-updated).
/// It runs out-of-process so it doesn't consume your app's memory budget.
///
/// Requires macOS 26+. Guarded at the call site; this file compiles on older
/// SDKs but the class body is behind `@available`.
@available(macOS 26, *)
@MainActor
final class AppleSpeechTranscriptionService: ObservableObject, TranscriptionServiceProtocol {
    
    // MARK: - Published State
    
    @Published var isReady: Bool = false
    @Published var partialText: String = ""
    @Published var errorMessage: String?
    
    // MARK: - Callbacks
    
    var onFinalSegment: ((_ text: String, _ startTime: TimeInterval, _ endTime: TimeInterval) -> Void)?
    var onPartialUpdate: ((_ text: String, _ startTime: TimeInterval) -> Void)?
    
    // MARK: - Private — Analyzers
    
    /// Separate SpeechAnalyzer + SpeechTranscriber per audio source.
    private var micAnalyzer: SpeechAnalyzer?
    private var sysAnalyzer: SpeechAnalyzer?
    private var micTranscriber: SpeechTranscriber?
    private var sysTranscriber: SpeechTranscriber?
    
    /// AsyncStream continuations for feeding audio to each analyzer.
    private var micInputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    private var sysInputBuilder: AsyncStream<AnalyzerInput>.Continuation?
    
    /// Tasks consuming transcription results.
    private var micConsumerTask: Task<Void, Never>?
    private var sysConsumerTask: Task<Void, Never>?
    
    /// Audio format required by SpeechAnalyzer.
    private var analyzerFormat: AVAudioFormat?
    
    /// Converter from our 16 kHz Float32 input to the analyzer's preferred format.
    private var micConverter: AVAudioConverter?
    private var sysConverter: AVAudioConverter?
    
    /// Source format: 16 kHz, mono, Float32 (matches AudioEngineManager output).
    private let sourceFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: 16000,
        channels: 1,
        interleaved: true
    )!
    
    private var streamStartTime: Date?
    
    /// Current partial (volatile) text from each source.
    private var micPartialText: String = ""
    private var sysPartialText: String = ""
    
    // MARK: - Model Loading
    
    func loadModel() async {
        do {
            // Create a transcriber to determine format and check model availability
            let transcriber = SpeechTranscriber(
                locale: Locale.current,
                transcriptionOptions: [],
                reportingOptions: [.volatileResults],
                attributeOptions: [.audioTimeRange]
            )
            
            // Ensure the model is downloaded
            try await ensureModelInstalled(transcriber: transcriber)
            
            // Get the preferred audio format
            let analyzer = SpeechAnalyzer(modules: [transcriber])
            self.analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber]
            )
            
            // Clean up the probe analyzer (we'll create fresh ones for streaming)
            await analyzer.cancelAndFinishNow()
            
            isReady = true
            errorMessage = nil
            print("[Dialogue] Apple SpeechAnalyzer loaded")
        } catch {
            errorMessage = "Failed to load Apple Speech: \(error.localizedDescription)"
            print("[Dialogue] Apple SpeechAnalyzer load error: \(error)")
        }
    }
    
    static func modelsExistLocally() -> Bool {
        // Apple manages model storage; check if the locale is installed
        if #available(macOS 26, *) {
            // We can't call async from a static sync method, so assume available
            // if the OS supports it. The actual check happens in loadModel().
            return true
        }
        return false
    }
    
    func unloadModel() {
        micAnalyzer = nil
        sysAnalyzer = nil
        micTranscriber = nil
        sysTranscriber = nil
        micConverter = nil
        sysConverter = nil
        analyzerFormat = nil
        micInputBuilder = nil
        sysInputBuilder = nil
        micConsumerTask?.cancel()
        sysConsumerTask?.cancel()
        micConsumerTask = nil
        sysConsumerTask = nil
        isReady = false
        partialText = ""
        errorMessage = nil
        print("[Dialogue] Apple SpeechAnalyzer unloaded")
    }
    
    // MARK: - Streaming Interface
    
    func startStreaming() {
        guard isReady, let format = analyzerFormat else { return }
        
        micPartialText = ""
        sysPartialText = ""
        partialText = ""
        streamStartTime = Date()
        
        // Set up converters if source format differs from analyzer format
        if sourceFormat != format {
            micConverter = AVAudioConverter(from: sourceFormat, to: format)
            sysConverter = AVAudioConverter(from: sourceFormat, to: format)
        }
        
        // Create mic analyzer session
        let micT = SpeechTranscriber(
            locale: Locale.current,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        self.micTranscriber = micT
        let micA = SpeechAnalyzer(modules: [micT])
        self.micAnalyzer = micA
        
        // Create system audio analyzer session
        let sysT = SpeechTranscriber(
            locale: Locale.current,
            transcriptionOptions: [],
            reportingOptions: [.volatileResults],
            attributeOptions: [.audioTimeRange]
        )
        self.sysTranscriber = sysT
        let sysA = SpeechAnalyzer(modules: [sysT])
        self.sysAnalyzer = sysA
        
        // Create input streams
        let (micStream, micBuilder) = AsyncStream<AnalyzerInput>.makeStream()
        self.micInputBuilder = micBuilder
        
        let (sysStream, sysBuilder) = AsyncStream<AnalyzerInput>.makeStream()
        self.sysInputBuilder = sysBuilder
        
        // Start analyzers
        Task {
            do {
                try await micA.start(inputSequence: micStream)
                try await sysA.start(inputSequence: sysStream)
                
                // Consume mic results
                micConsumerTask = Task { @MainActor [weak self] in
                    guard let self, let transcriber = self.micTranscriber else { return }
                    do {
                        for try await result in transcriber.results {
                            self.handleResult(result, source: .mic)
                        }
                    } catch {
                        print("[Dialogue] Apple ASR mic consumer error: \(error)")
                    }
                }
                
                // Consume system results
                sysConsumerTask = Task { @MainActor [weak self] in
                    guard let self, let transcriber = self.sysTranscriber else { return }
                    do {
                        for try await result in transcriber.results {
                            self.handleResult(result, source: .system)
                        }
                    } catch {
                        print("[Dialogue] Apple ASR system consumer error: \(error)")
                    }
                }
                
                print("[Dialogue] Apple SpeechAnalyzer streaming started (dual-source)")
            } catch {
                print("[Dialogue] Failed to start Apple SpeechAnalyzer: \(error)")
                self.errorMessage = "Apple Speech streaming failed: \(error.localizedDescription)"
            }
        }
    }
    
    func stopStreaming() async {
        let elapsed = streamStartTime.map { Date().timeIntervalSince($0) } ?? 0
        
        // Emit remaining partials as final
        if !micPartialText.isEmpty {
            onFinalSegment?(micPartialText, max(elapsed - 1.0, 0), elapsed)
            micPartialText = ""
        }
        if !sysPartialText.isEmpty {
            onFinalSegment?(sysPartialText, max(elapsed - 1.0, 0), elapsed)
            sysPartialText = ""
        }
        
        // Finalize both analyzers — flushes volatile → final
        micInputBuilder?.finish()
        sysInputBuilder?.finish()
        
        if let micA = micAnalyzer {
            do {
                try await micA.finalizeAndFinishThroughEndOfInput()
            } catch {
                print("[Dialogue] Apple ASR mic finalize error: \(error)")
            }
        }
        if let sysA = sysAnalyzer {
            do {
                try await sysA.finalizeAndFinishThroughEndOfInput()
            } catch {
                print("[Dialogue] Apple ASR system finalize error: \(error)")
            }
        }
        
        micConsumerTask?.cancel()
        sysConsumerTask?.cancel()
        micConsumerTask = nil
        sysConsumerTask = nil
        micAnalyzer = nil
        sysAnalyzer = nil
        micTranscriber = nil
        sysTranscriber = nil
        micInputBuilder = nil
        sysInputBuilder = nil
        micConverter = nil
        sysConverter = nil
        partialText = ""
    }
    
    func appendMicAudio(samples: [Float], timestamp: TimeInterval) {
        guard let builder = micInputBuilder else { return }
        if let buffer = convertSamplesToAnalyzerBuffer(samples, converter: micConverter) {
            let input = AnalyzerInput(buffer: buffer)
            builder.yield(input)
        }
    }
    
    func appendSystemAudio(samples: [Float], timestamp: TimeInterval) {
        guard let builder = sysInputBuilder else { return }
        if let buffer = convertSamplesToAnalyzerBuffer(samples, converter: sysConverter) {
            let input = AnalyzerInput(buffer: buffer)
            builder.yield(input)
        }
    }
    
    // MARK: - Private Helpers
    
    private enum AudioSource {
        case mic
        case system
    }
    
    /// Handle a transcription result from Apple's SpeechTranscriber.
    private func handleResult(_ result: SpeechTranscriber.Result, source: AudioSource) {
        let text = String(result.text.characters)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let elapsed = streamStartTime.map { Date().timeIntervalSince($0) } ?? 0
        
        guard !text.isEmpty else { return }
        
        if result.isFinal {
            // Finalized result — emit as confirmed segment
            // Include any accumulated partial text that this finalizes
            let previousPartial = source == .mic ? micPartialText : sysPartialText
            let finalText: String
            if previousPartial.isEmpty {
                finalText = text
            } else {
                // The final result replaces the volatile, so just use the final text
                finalText = text
            }
            
            // Extract timing from attributed string if available
            var startTime = max(elapsed - 1.0, 0)
            var endTime = elapsed
            if let timeRange = result.text.runs.first(where: { $0.audioTimeRange != nil })?.audioTimeRange {
                startTime = timeRange.start.seconds
                endTime = timeRange.end.seconds
            }
            
            onFinalSegment?(finalText, startTime, endTime)
            
            // Clear volatile for this source
            switch source {
            case .mic: micPartialText = ""
            case .system: sysPartialText = ""
            }
            updateMergedPartialText()
        } else {
            // Volatile result — update partial display
            switch source {
            case .mic: micPartialText = text
            case .system: sysPartialText = text
            }
            updateMergedPartialText()
            onPartialUpdate?(partialText, elapsed)
        }
    }
    
    private func updateMergedPartialText() {
        let parts = [micPartialText, sysPartialText].filter { !$0.isEmpty }
        partialText = parts.joined(separator: " ")
    }
    
    /// Convert raw Float32 samples to a buffer in the analyzer's expected format.
    private func convertSamplesToAnalyzerBuffer(
        _ samples: [Float],
        converter: AVAudioConverter?
    ) -> AVAudioPCMBuffer? {
        let sampleCount = samples.count
        let sourceBuffer = AVAudioPCMBuffer(
            pcmFormat: sourceFormat,
            frameCapacity: AVAudioFrameCount(sampleCount)
        )!
        sourceBuffer.frameLength = AVAudioFrameCount(sampleCount)
        
        samples.withUnsafeBufferPointer { srcPtr in
            let dstPtr = sourceBuffer.floatChannelData![0]
            memcpy(dstPtr, srcPtr.baseAddress!, sampleCount * MemoryLayout<Float>.stride)
        }
        
        // If no conversion needed, return source buffer directly
        guard let converter else {
            return sourceBuffer
        }
        
        // Convert to analyzer format
        guard let format = analyzerFormat else { return sourceBuffer }
        let ratio = format.sampleRate / sourceFormat.sampleRate
        let outputCapacity = AVAudioFrameCount(Double(sampleCount) * ratio) + 1
        guard let outputBuffer = AVAudioPCMBuffer(
            pcmFormat: format,
            frameCapacity: outputCapacity
        ) else { return nil }
        
        do {
            try converter.convert(to: outputBuffer, from: sourceBuffer)
            return outputBuffer
        } catch {
            print("[Dialogue] Apple ASR audio conversion error: \(error)")
            return nil
        }
    }
    
    /// Ensure the speech model for the current locale is installed.
    private func ensureModelInstalled(transcriber: SpeechTranscriber) async throws {
        let locale = Locale.current
        
        // Check if the language is supported
        let supported = await SpeechTranscriber.supportedLocales
        let bcp47 = locale.identifier(.bcp47)
        guard supported.map({ $0.identifier(.bcp47) }).contains(bcp47) else {
            throw AppleSpeechError.localeNotSupported(bcp47)
        }
        
        // Check if already installed
        let installed = await SpeechTranscriber.installedLocales
        if installed.map({ $0.identifier(.bcp47) }).contains(bcp47) {
            print("[Dialogue] Apple Speech model already installed for \(bcp47)")
            return
        }
        
        // Download and install
        print("[Dialogue] Downloading Apple Speech model for \(bcp47)...")
        if let downloader = try await AssetInventory.assetInstallationRequest(
            supporting: [transcriber]
        ) {
            try await downloader.downloadAndInstall()
            print("[Dialogue] Apple Speech model installed for \(bcp47)")
        }
    }
}

// MARK: - Errors

@available(macOS 26, *)
enum AppleSpeechError: LocalizedError {
    case localeNotSupported(String)
    
    var errorDescription: String? {
        switch self {
        case .localeNotSupported(let locale):
            return "Apple Speech does not support locale: \(locale)"
        }
    }
}
