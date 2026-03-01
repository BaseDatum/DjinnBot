import Foundation

/// Thin wrapper that creates a `RealtimePipeline` configured for the
/// local microphone stream (speaker prefix: "Local-").
@available(macOS 26.0, *)
typealias MicPipeline = RealtimePipeline

extension MicPipeline {
    /// Convenience factory for the mic pipeline.
    static func createMic() -> RealtimePipeline {
        RealtimePipeline(streamType: .mic)
    }
}
