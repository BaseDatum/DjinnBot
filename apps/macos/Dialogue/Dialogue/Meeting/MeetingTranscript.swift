import Foundation

// MARK: - TranscriptSegment

/// A single segment of transcribed speech with speaker attribution.
struct TranscriptSegment: Identifiable, Equatable, Codable, Sendable {
    let id: UUID
    var speakerLabel: String        // "You", "Speaker 1", or a named profile
    var speakerProfileID: String?   // VoiceProfile.id if matched, nil if unknown
    var text: String
    var startTime: TimeInterval     // Offset from recording start
    var endTime: TimeInterval
    var isPartial: Bool             // True while still being refined by streaming ASR
    var speakerEmbedding: [Float]?  // Raw embedding for post-meeting labeling
    
    /// Speaker color index (stable per speaker label within a meeting).
    var speakerColorIndex: Int = 0
    
    // Exclude the large embedding vector from serialization.
    enum CodingKeys: String, CodingKey {
        case id, speakerLabel, speakerProfileID, text
        case startTime, endTime, isPartial, speakerColorIndex
    }
    
    init(
        id: UUID = UUID(),
        speakerLabel: String,
        speakerProfileID: String? = nil,
        text: String,
        startTime: TimeInterval,
        endTime: TimeInterval,
        isPartial: Bool = false,
        speakerEmbedding: [Float]? = nil
    ) {
        self.id = id
        self.speakerLabel = speakerLabel
        self.speakerProfileID = speakerProfileID
        self.text = text
        self.startTime = startTime
        self.endTime = endTime
        self.isPartial = isPartial
        self.speakerEmbedding = speakerEmbedding
    }
    
    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        id = try container.decode(UUID.self, forKey: .id)
        speakerLabel = try container.decode(String.self, forKey: .speakerLabel)
        speakerProfileID = try container.decodeIfPresent(String.self, forKey: .speakerProfileID)
        text = try container.decode(String.self, forKey: .text)
        startTime = try container.decode(TimeInterval.self, forKey: .startTime)
        endTime = try container.decode(TimeInterval.self, forKey: .endTime)
        isPartial = try container.decode(Bool.self, forKey: .isPartial)
        speakerColorIndex = try container.decodeIfPresent(Int.self, forKey: .speakerColorIndex) ?? 0
        speakerEmbedding = nil  // Never decoded from disk
    }
}

// MARK: - DetectedSpeaker

/// A speaker detected during a meeting, used in the post-meeting labeling flow.
struct DetectedSpeaker: Identifiable, Equatable, Sendable {
    let id: String               // Cluster ID (e.g. "speaker-0", "speaker-1")
    var label: String            // Current display label ("You", "Speaker 1", etc.)
    var profileID: String?       // Matched VoiceProfile.id, nil if unknown
    var representativeEmbedding: [Float]  // Average embedding for this cluster
    var segmentIDs: [UUID]       // IDs of TranscriptSegments attributed to this speaker
    var isIdentified: Bool       // Whether the user has assigned a name
    
    /// Color index for consistent display.
    var colorIndex: Int = 0
}

// MARK: - MeetingRecording

/// Full meeting recording data: audio file + transcript + detected speakers.
final class MeetingRecording: ObservableObject, Identifiable {
    let id: UUID
    let startedAt: Date
    
    /// URL of the recorded audio file (WAV, stored in app support).
    @Published var audioFileURL: URL?
    
    /// All transcript segments, ordered by startTime.
    @Published var segments: [TranscriptSegment] = []
    
    /// Speakers detected during the meeting.
    @Published var detectedSpeakers: [DetectedSpeaker] = []
    
    /// Total recording duration in seconds.
    @Published var duration: TimeInterval = 0
    
    /// Whether the recording is currently active.
    @Published var isRecording: Bool = false
    
    /// Whether the recording is paused.
    @Published var isPaused: Bool = false
    
    init(id: UUID = UUID(), startedAt: Date = Date()) {
        self.id = id
        self.startedAt = startedAt
    }
    
    // MARK: - Segment Management
    
    /// Append or update a segment. If a segment with the same ID exists, update it.
    func upsertSegment(_ segment: TranscriptSegment) {
        if let idx = segments.firstIndex(where: { $0.id == segment.id }) {
            segments[idx] = segment
        } else {
            // Insert in chronological order
            let insertIdx = segments.firstIndex { $0.startTime > segment.startTime } ?? segments.endIndex
            segments.insert(segment, at: insertIdx)
        }
    }
    
    /// Update speaker labels for all segments belonging to a given cluster.
    func relabelSpeaker(clusterID: String, newLabel: String, profileID: String?) {
        guard let speaker = detectedSpeakers.first(where: { $0.id == clusterID }) else { return }
        
        for segmentID in speaker.segmentIDs {
            if let idx = segments.firstIndex(where: { $0.id == segmentID }) {
                segments[idx].speakerLabel = newLabel
                segments[idx].speakerProfileID = profileID
            }
        }
        
        if let speakerIdx = detectedSpeakers.firstIndex(where: { $0.id == clusterID }) {
            detectedSpeakers[speakerIdx].label = newLabel
            detectedSpeakers[speakerIdx].profileID = profileID
            detectedSpeakers[speakerIdx].isIdentified = true
        }
    }
    
    // MARK: - Audio Storage
    
    /// Returns the directory for storing meeting audio files.
    static var audioStorageDirectory: URL {
        let appSupport = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
        let dir = appSupport.appendingPathComponent("Dialogue/Meetings", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    
    /// Generate a unique audio file URL for this meeting.
    func makeAudioFileURL() -> URL {
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HHmmss"
        let name = "meeting_\(formatter.string(from: startedAt)).wav"
        return Self.audioStorageDirectory.appendingPathComponent(name)
    }
}
