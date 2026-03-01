import Foundation
import Combine
import OSLog

/// Represents a single saved meeting on disk.
struct SavedMeeting: Identifiable, Hashable {
    let id: String           // Folder name (meetingName or timestamp)
    let folderURL: URL
    let displayName: String
    let date: Date
    let hasRecording: Bool
    let hasTranscript: Bool

    var recordingURL: URL { folderURL.appendingPathComponent("recording.wav") }
    var transcriptURL: URL { folderURL.appendingPathComponent("transcript.json") }

    func hash(into hasher: inout Hasher) { hasher.combine(folderURL) }
    static func == (lhs: SavedMeeting, rhs: SavedMeeting) -> Bool { lhs.folderURL == rhs.folderURL }
}

/// Transcript entry stored in transcript.json.
struct TranscriptEntry: Codable, Identifiable {
    var id: String { "\(start)-\(speaker)-\(text.prefix(20))" }
    let speaker: String
    let start: TimeInterval
    let end: TimeInterval
    let text: String
    let stream: String       // "Local" or "Remote"
    let isFinal: Bool
}

/// Manages the ~/Documents/Dialog/Meetings directory.
///
/// Responsible for:
/// - Saving recordings (WAV + transcript JSON) into per-meeting folders
/// - Scanning the directory and publishing the list of saved meetings
/// - Loading transcript data for display
final class MeetingStore: ObservableObject {
    static let shared = MeetingStore()

    /// All discovered meetings, sorted newest first.
    @Published var meetings: [SavedMeeting] = []

    private let fileManager = FileManager.default
    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "MeetingStore")
    private var watcher: DispatchSourceFileSystemObject?

    /// Root directory: ~/Documents/Dialog/Meetings
    let rootFolder: URL

    private init() {
        let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        rootFolder = docs.appendingPathComponent("Dialog/Meetings", isDirectory: true)
        try? fileManager.createDirectory(at: rootFolder, withIntermediateDirectories: true)
        refresh()
        startWatching()
    }

    // MARK: - Save a Meeting

    /// Save a completed meeting recording and transcript to disk.
    ///
    /// Creates ~/Documents/Dialog/Meetings/{name}/recording.wav and transcript.json
    ///
    /// - Parameters:
    ///   - name: Optional meeting name. Falls back to a timestamp.
    ///   - wavSourceURL: The temporary WAV file to move into the meeting folder.
    ///   - segments: The transcript segments to serialize.
    /// - Returns: The created SavedMeeting, or nil on failure.
    @discardableResult
    func saveMeeting(
        name: String? = nil,
        wavSourceURL: URL?,
        segments: [TaggedSegment]
    ) -> SavedMeeting? {
        let folderName = sanitizedFolderName(name)
        let meetingFolder = rootFolder.appendingPathComponent(folderName, isDirectory: true)

        do {
            try fileManager.createDirectory(at: meetingFolder, withIntermediateDirectories: true)

            // Move WAV file
            var hasRecording = false
            if let sourceURL = wavSourceURL, fileManager.fileExists(atPath: sourceURL.path) {
                let destWAV = meetingFolder.appendingPathComponent("recording.wav")
                // If the file already exists (shouldn't normally), remove it first
                if fileManager.fileExists(atPath: destWAV.path) {
                    try fileManager.removeItem(at: destWAV)
                }
                try fileManager.moveItem(at: sourceURL, to: destWAV)
                hasRecording = true
                logger.info("Saved recording to \(meetingFolder.lastPathComponent)/recording.wav")
            }

            // Write transcript JSON
            var hasTranscript = false
            if !segments.isEmpty {
                let entries = segments.map { seg in
                    TranscriptEntry(
                        speaker: seg.speaker,
                        start: seg.start,
                        end: seg.end,
                        text: seg.text,
                        stream: seg.stream.rawValue,
                        isFinal: seg.isFinal
                    )
                }
                let encoder = JSONEncoder()
                encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
                let data = try encoder.encode(entries)
                let transcriptURL = meetingFolder.appendingPathComponent("transcript.json")
                try data.write(to: transcriptURL, options: Data.WritingOptions.atomic)

                // Write plain-text transcript (time-sorted, one line per segment)
                let sortedEntries = entries.sorted { $0.start < $1.start }
                let lines = sortedEntries.map { entry in
                    let minutes = Int(entry.start) / 60
                    let seconds = Int(entry.start) % 60
                    return String(format: "%d:%02d %@: %@", minutes, seconds, entry.speaker, entry.text)
                }
                let txtURL = meetingFolder.appendingPathComponent("transcript.txt")
                try lines.joined(separator: "\n").write(to: txtURL, atomically: true, encoding: .utf8)

                hasTranscript = true
                logger.info("Saved transcript with \(segments.count) segments")
            }

            let meeting = SavedMeeting(
                id: folderName,
                folderURL: meetingFolder,
                displayName: displayName(from: folderName),
                date: Date(),
                hasRecording: hasRecording,
                hasTranscript: hasTranscript
            )

            refresh()
            return meeting

        } catch {
            logger.error("Failed to save meeting: \(error.localizedDescription)")
            return nil
        }
    }

    // MARK: - Load Transcript

    /// Load transcript entries from a saved meeting's transcript.json.
    func loadTranscript(for meeting: SavedMeeting) -> [TranscriptEntry]? {
        let url = meeting.transcriptURL
        guard fileManager.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode([TranscriptEntry].self, from: data)
    }

    // MARK: - Refresh / Scan

    /// Re-scan the Meetings directory and update the published list.
    func refresh() {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: rootFolder,
            includingPropertiesForKeys: [.isDirectoryKey, .creationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            meetings = []
            return
        }

        var result: [SavedMeeting] = []
        for item in contents {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            guard isDir else { continue }

            let folderName = item.lastPathComponent
            let recordingExists = fileManager.fileExists(
                atPath: item.appendingPathComponent("recording.wav").path
            )
            let transcriptExists = fileManager.fileExists(
                atPath: item.appendingPathComponent("transcript.json").path
            )

            // Only show folders that contain at least one artifact
            guard recordingExists || transcriptExists else { continue }

            let creationDate = (try? item.resourceValues(forKeys: [.creationDateKey]))?.creationDate ?? .distantPast

            result.append(SavedMeeting(
                id: folderName,
                folderURL: item,
                displayName: displayName(from: folderName),
                date: creationDate,
                hasRecording: recordingExists,
                hasTranscript: transcriptExists
            ))
        }

        // Sort newest first
        meetings = result.sorted { $0.date > $1.date }
    }

    // MARK: - File Watching

    private func startWatching() {
        let fd = open(rootFolder.path, O_EVTONLY)
        guard fd >= 0 else { return }

        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        source.setEventHandler { [weak self] in self?.refresh() }
        source.setCancelHandler { close(fd) }
        source.resume()
        watcher = source
    }

    // MARK: - Helpers

    private func sanitizedFolderName(_ name: String?) -> String {
        if let name = name?.trimmingCharacters(in: .whitespaces), !name.isEmpty {
            // Remove filesystem-unsafe characters
            let safe = name.components(separatedBy: CharacterSet.alphanumerics.union(.whitespaces).union(CharacterSet(charactersIn: "-_")).inverted).joined()
            let uniqueName = uniqueFolderName(safe.isEmpty ? "Meeting" : safe)
            return uniqueName
        }
        // Fallback to timestamp
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        return formatter.string(from: Date())
    }

    private func uniqueFolderName(_ base: String) -> String {
        var name = base
        var counter = 1
        while fileManager.fileExists(atPath: rootFolder.appendingPathComponent(name).path) {
            name = "\(base) \(counter)"
            counter += 1
        }
        return name
    }

    private func displayName(from folderName: String) -> String {
        // Try parsing as timestamp format: yyyy-MM-dd_HH-mm-ss
        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd_HH-mm-ss"
        if let date = formatter.date(from: folderName) {
            let display = DateFormatter()
            display.dateStyle = .medium
            display.timeStyle = .short
            return display.string(from: date)
        }
        // Otherwise use the folder name as-is
        return folderName
    }
}
