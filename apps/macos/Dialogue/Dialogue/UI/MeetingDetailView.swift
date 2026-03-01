import SwiftUI
import AppKit

/// Displays the transcript of a saved meeting.
///
/// Shows the meeting name, date, and a scrollable list of transcript entries
/// with speaker labels and timestamps, reusing the same visual style as
/// the live MeetingRecorderView transcript.
struct MeetingDetailView: View {
    let meeting: SavedMeeting
    @State private var entries: [TranscriptEntry] = []
    @State private var loadError: String?

    var body: some View {
        VStack(spacing: 0) {
            // Header
            header
            Divider()

            // Transcript content
            if let error = loadError {
                errorView(error)
            } else if entries.isEmpty {
                emptyView
            } else {
                transcriptList
            }
        }
        .frame(minWidth: 500, minHeight: 400)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear { loadTranscript() }
    }

    // MARK: - Header

    private var header: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(meeting.displayName)
                    .font(.title2)
                    .fontWeight(.semibold)
                Text(meeting.date, style: .date)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            if meeting.hasRecording {
                Button {
                    NSWorkspace.shared.open(meeting.recordingURL)
                } label: {
                    Label("Open Recording", systemImage: "waveform")
                        .font(.caption)
                }
                .buttonStyle(.bordered)
            }

            Button {
                NSWorkspace.shared.activateFileViewerSelecting([meeting.folderURL])
            } label: {
                Label("Show in Finder", systemImage: "folder")
                    .font(.caption)
            }
            .buttonStyle(.bordered)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
    }

    // MARK: - Transcript List

    private var transcriptList: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                ForEach(entries) { entry in
                    MeetingTranscriptRow(entry: entry)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
        }
    }

    // MARK: - Empty / Error states

    private var emptyView: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "text.bubble")
                .font(.system(size: 48))
                .foregroundStyle(.quaternary)
            Text("No Transcript")
                .font(.title2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            Text("This meeting does not have a transcript file.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func errorView(_ message: String) -> some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "exclamationmark.triangle")
                .font(.system(size: 48))
                .foregroundStyle(.yellow)
            Text("Failed to Load Transcript")
                .font(.title2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            Text(message)
                .font(.subheadline)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Loading

    private func loadTranscript() {
        guard meeting.hasTranscript else {
            entries = []
            return
        }
        if let loaded = MeetingStore.shared.loadTranscript(for: meeting) {
            entries = loaded
        } else {
            loadError = "Could not read transcript.json"
        }
    }
}

// MARK: - Single Transcript Row

private struct MeetingTranscriptRow: View {
    let entry: TranscriptEntry

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            // Timestamp
            Text(formatTimestamp(entry.start))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 52, alignment: .trailing)

            // Speaker pill
            Text(entry.speaker)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(speakerColor(for: entry.speaker), in: Capsule())

            // Text
            Text(entry.text)
                .font(.body)
                .foregroundStyle(.primary)

            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 4)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(speakerColor(for: entry.speaker).opacity(0.05))
        )
    }

    private func formatTimestamp(_ time: TimeInterval) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }

    private func speakerColor(for speaker: String) -> Color {
        let localColors: [Color] = [.blue, .purple, .indigo, .mint]
        let remoteColors: [Color] = [.orange, .pink, .red, .yellow]
        let isLocal = speaker.hasPrefix("Local")
        let palette = isLocal ? localColors : remoteColors
        let hash = abs(speaker.hashValue)
        return palette[hash % palette.count]
    }
}
