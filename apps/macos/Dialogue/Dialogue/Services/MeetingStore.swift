import Foundation
import Combine

// MARK: - MeetingStore

/// Manages persisted meeting records on disk.
///
/// Storage layout under `~/Documents/Dialogue/Meetings/`:
/// ```
/// 2026-02-28_143022/
///   metadata.json
///   transcript.json
///   audio.wav
/// ```
@MainActor
final class MeetingStore: ObservableObject {
    static let shared = MeetingStore()
    
    /// All meeting metadata, sorted most-recent first.
    @Published private(set) var meetings: [MeetingMetadata] = []
    
    private let fileManager = FileManager.default
    private var watcher: DispatchSourceFileSystemObject?
    
    /// Root directory for all meeting storage.
    var meetingsDirectory: URL {
        let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let dir = docs.appendingPathComponent("Dialogue/Meetings", isDirectory: true)
        try? fileManager.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }
    
    private init() {
        refresh()
        startWatching()
    }
    
    // MARK: - Public API
    
    /// Refresh the meetings list by scanning the storage directory.
    func refresh() {
        meetings = loadAllMeetings()
    }
    
    /// Save a completed recording with its metadata and transcript.
    /// Moves the audio file into the meeting directory.
    @discardableResult
    func saveMeeting(
        recording: MeetingRecording,
        sourceApp: String? = nil,
        sourceBundleID: String? = nil,
        sourceType: MeetingSourceType = .manual
    ) -> URL? {
        let metadata = MeetingMetadata.from(
            recording: recording,
            sourceApp: sourceApp,
            sourceBundleID: sourceBundleID,
            sourceType: sourceType
        )
        
        let meetingDir = meetingsDirectory.appendingPathComponent(metadata.directoryName, isDirectory: true)
        
        do {
            try fileManager.createDirectory(at: meetingDir, withIntermediateDirectories: true)
            
            // Save metadata
            let metadataURL = meetingDir.appendingPathComponent("metadata.json")
            let encoder = JSONEncoder()
            encoder.dateEncodingStrategy = .iso8601
            encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            let metadataData = try encoder.encode(metadata)
            try metadataData.write(to: metadataURL, options: .atomic)
            
            // Save transcript (only finalized segments)
            let transcriptURL = meetingDir.appendingPathComponent("transcript.json")
            let finalSegments = recording.segments.filter { !$0.isPartial }
            let transcriptData = try encoder.encode(finalSegments)
            try transcriptData.write(to: transcriptURL, options: .atomic)
            
            // Move audio file into the meeting directory
            if let audioURL = recording.audioFileURL,
               fileManager.fileExists(atPath: audioURL.path) {
                let destAudioURL = meetingDir.appendingPathComponent("audio.wav")
                if fileManager.fileExists(atPath: destAudioURL.path) {
                    try fileManager.removeItem(at: destAudioURL)
                }
                try fileManager.moveItem(at: audioURL, to: destAudioURL)
            }
            
            print("[Dialogue] Meeting saved: \(metadata.displayName) → \(meetingDir.lastPathComponent)")
            refresh()
            return meetingDir
            
        } catch {
            print("[Dialogue] Failed to save meeting: \(error)")
            return nil
        }
    }
    
    /// Load the transcript segments for a given meeting.
    func loadTranscript(for meeting: MeetingMetadata) -> [TranscriptSegment] {
        let meetingDir = meetingsDirectory.appendingPathComponent(meeting.directoryName, isDirectory: true)
        let transcriptURL = meetingDir.appendingPathComponent("transcript.json")
        
        guard let data = try? Data(contentsOf: transcriptURL) else {
            print("[Dialogue] No transcript found for meeting \(meeting.id)")
            return []
        }
        
        do {
            let decoder = JSONDecoder()
            return try decoder.decode([TranscriptSegment].self, from: data)
        } catch {
            print("[Dialogue] Failed to decode transcript: \(error)")
            return []
        }
    }
    
    /// Get the audio file URL for a meeting.
    func audioFileURL(for meeting: MeetingMetadata) -> URL? {
        let meetingDir = meetingsDirectory.appendingPathComponent(meeting.directoryName, isDirectory: true)
        let audioURL = meetingDir.appendingPathComponent("audio.wav")
        return fileManager.fileExists(atPath: audioURL.path) ? audioURL : nil
    }
    
    /// Delete a meeting (moves to Trash).
    func deleteMeeting(id: UUID) {
        guard let meeting = meetings.first(where: { $0.id == id }) else { return }
        let meetingDir = meetingsDirectory.appendingPathComponent(meeting.directoryName, isDirectory: true)
        
        do {
            try fileManager.trashItem(at: meetingDir, resultingItemURL: nil)
            print("[Dialogue] Meeting deleted: \(meeting.displayName)")
            refresh()
        } catch {
            print("[Dialogue] Failed to delete meeting: \(error)")
        }
    }
    
    /// Delete a meeting by metadata reference.
    func deleteMeeting(_ meeting: MeetingMetadata) {
        deleteMeeting(id: meeting.id)
    }
    
    // MARK: - Loading
    
    /// Scan the meetings directory and load all metadata files.
    private func loadAllMeetings() -> [MeetingMetadata] {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: meetingsDirectory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        
        var results: [MeetingMetadata] = []
        
        for item in contents {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            guard isDir else { continue }
            
            let metadataURL = item.appendingPathComponent("metadata.json")
            guard let data = try? Data(contentsOf: metadataURL),
                  let metadata = try? decoder.decode(MeetingMetadata.self, from: data) else {
                continue
            }
            results.append(metadata)
        }
        
        // Sort most recent first
        results.sort { $0.createdAt > $1.createdAt }
        return results
    }
    
    // MARK: - File System Watching
    
    private func startWatching() {
        let dir = meetingsDirectory
        let fd = open(dir.path, O_EVTONLY)
        guard fd >= 0 else { return }
        
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        
        source.setEventHandler { [weak self] in
            self?.refresh()
        }
        
        source.setCancelHandler {
            close(fd)
        }
        
        source.resume()
        self.watcher = source
    }
    
    private func stopWatching() {
        watcher?.cancel()
        watcher = nil
    }
}
