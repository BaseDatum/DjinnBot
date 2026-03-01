import Foundation

/// Thin wrapper that creates a `RealtimePipeline` configured for the
/// meeting app audio stream (speaker prefix: "Remote-").
@available(macOS 26.0, *)
typealias MeetingPipeline = RealtimePipeline

extension MeetingPipeline {
    /// Convenience factory for the meeting audio pipeline.
    static func createMeeting() -> RealtimePipeline {
        RealtimePipeline(streamType: .meeting)
    }
}
