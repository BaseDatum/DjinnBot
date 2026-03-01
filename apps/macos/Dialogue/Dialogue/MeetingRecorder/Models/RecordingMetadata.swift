import Foundation

/// Metadata for a completed meeting recording.
struct RecordingMetadata: Codable, Sendable {
    let id: UUID
    let startDate: Date
    let endDate: Date
    let durationSeconds: TimeInterval
    let wavFileURL: URL?
    let detectedApps: [String]
    let speakerCount: Int
    let segmentCount: Int

    init(
        id: UUID = UUID(),
        startDate: Date,
        endDate: Date = .now,
        durationSeconds: TimeInterval,
        wavFileURL: URL?,
        detectedApps: [String],
        speakerCount: Int,
        segmentCount: Int
    ) {
        self.id = id
        self.startDate = startDate
        self.endDate = endDate
        self.durationSeconds = durationSeconds
        self.wavFileURL = wavFileURL
        self.detectedApps = detectedApps
        self.speakerCount = speakerCount
        self.segmentCount = segmentCount
    }

    /// Persist metadata as JSON sidecar next to the WAV file.
    func writeSidecar() throws {
        guard let wavURL = wavFileURL else { return }
        let sidecarURL = wavURL.deletingPathExtension().appendingPathExtension("json")
        let data = try JSONEncoder().encode(self)
        try data.write(to: sidecarURL, options: .atomic)
    }
}
