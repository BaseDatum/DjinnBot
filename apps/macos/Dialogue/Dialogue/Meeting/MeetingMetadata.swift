import Foundation

// MARK: - MeetingSourceType

/// How the meeting/call was detected and initiated.
enum MeetingSourceType: String, Codable, CaseIterable {
    /// User manually pressed the record button.
    case manual
    /// Auto-detected voice/video call (Slack, FaceTime, Signal, WhatsApp, Teams).
    case call
    /// Meeting-specific app was opened (Zoom, Google Meet).
    case meetingApp
}

// MARK: - DetectedSpeakerSummary

/// Lightweight speaker info for persisted metadata (no embeddings).
struct DetectedSpeakerSummary: Codable, Identifiable {
    let id: String
    var label: String
    var segmentCount: Int
    var isIdentified: Bool
}

// MARK: - MeetingMetadata

/// Persisted metadata for a recorded meeting.
struct MeetingMetadata: Codable, Identifiable, Equatable {
    let id: UUID
    let createdAt: Date
    var duration: TimeInterval
    var sourceApp: String?
    var sourceBundleID: String?
    var sourceType: MeetingSourceType
    var speakerCount: Int
    var segmentCount: Int
    var displayName: String
    var detectedSpeakers: [DetectedSpeakerSummary]
    
    /// Directory URL for this meeting's files (computed, not stored).
    var directoryName: String {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HHmmss"
        return formatter.string(from: createdAt)
    }
    
    /// Human-readable display name from the creation timestamp.
    static func makeDisplayName(from date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        return formatter.string(from: date)
    }
    
    /// Create metadata from a completed recording.
    static func from(
        recording: MeetingRecording,
        sourceApp: String? = nil,
        sourceBundleID: String? = nil,
        sourceType: MeetingSourceType = .manual
    ) -> MeetingMetadata {
        let speakerSummaries = recording.detectedSpeakers.map { speaker in
            DetectedSpeakerSummary(
                id: speaker.id,
                label: speaker.label,
                segmentCount: speaker.segmentIDs.count,
                isIdentified: speaker.isIdentified
            )
        }
        
        return MeetingMetadata(
            id: recording.id,
            createdAt: recording.startedAt,
            duration: recording.duration,
            sourceApp: sourceApp,
            sourceBundleID: sourceBundleID,
            sourceType: sourceType,
            speakerCount: recording.detectedSpeakers.count,
            segmentCount: recording.segments.count,
            displayName: makeDisplayName(from: recording.startedAt),
            detectedSpeakers: speakerSummaries
        )
    }
    
    static func == (lhs: MeetingMetadata, rhs: MeetingMetadata) -> Bool {
        lhs.id == rhs.id
    }
}
