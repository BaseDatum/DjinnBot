import Foundation
import SwiftData

// MARK: - Stream Type

/// Identifies which audio stream a segment originated from.
enum StreamType: String, Codable, Sendable {
    case mic = "Local"
    case meeting = "Remote"
}

// MARK: - Tagged Segment

/// A single diarized + transcribed segment on the shared audio timeline.
///
/// Combines speaker identity from diarization with transcript text from ASR,
/// tagged by which audio stream (mic vs. meeting app) it came from.
struct TaggedSegment: Identifiable, Sendable {
    let id: UUID
    let stream: StreamType
    var speaker: String
    var start: TimeInterval
    var end: TimeInterval
    var text: String
    var embedding: [Float]
    var isFinal: Bool

    init(
        id: UUID = UUID(),
        stream: StreamType,
        speaker: String,
        start: TimeInterval,
        end: TimeInterval,
        text: String = "",
        embedding: [Float] = [],
        isFinal: Bool = false
    ) {
        self.id = id
        self.stream = stream
        self.speaker = speaker
        self.start = start
        self.end = end
        self.text = text
        self.embedding = embedding
        self.isFinal = isFinal
    }

    var duration: TimeInterval { end - start }

    /// Display-friendly label combining stream prefix and speaker ID.
    var displayLabel: String { "\(stream.rawValue)-\(speaker)" }
}

// MARK: - ASR Result Wrapper

/// Lightweight container for an ASR result on the shared timeline.
struct ASRSegment: Sendable {
    let stream: StreamType
    let text: String
    let start: TimeInterval
    let end: TimeInterval
    let isFinal: Bool
}
