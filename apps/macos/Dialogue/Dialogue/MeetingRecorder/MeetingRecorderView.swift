import SwiftUI

/// Main view for the MeetingRecorder module.
///
/// Shows recording controls at the top, a live scrolling transcript in the center,
/// and detected meeting app info. Each speaker gets a consistent color.
@available(macOS 26.0, *)
struct MeetingRecorderView: View {
    @StateObject private var recorder = MeetingRecorderController()
    @State private var autoScroll = true

    var body: some View {
        VStack(spacing: 0) {
            // MARK: - Header / Controls
            RecordingControlBar(recorder: recorder)

            Divider()

            // MARK: - Transcript
            if recorder.mergedSegments.isEmpty && !recorder.isRecording {
                emptyState
            } else {
                TranscriptScrollView(
                    segments: recorder.mergedSegments,
                    autoScroll: $autoScroll
                )
            }

            Divider()

            // MARK: - Status Footer
            StatusBar(recorder: recorder)
        }
        .frame(minWidth: 500, minHeight: 400)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var emptyState: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "waveform.circle")
                .font(.system(size: 48))
                .foregroundStyle(.quaternary)
            Text("Meeting Recorder")
                .font(.title2)
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
            Text("Press Record to start capturing audio.\nMeeting apps will be detected automatically.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Recording Control Bar

@available(macOS 26.0, *)
private struct RecordingControlBar: View {
    @ObservedObject var recorder: MeetingRecorderController

    var body: some View {
        HStack(spacing: 12) {
            // Record / Stop button
            Button {
                Task {
                    if recorder.isRecording {
                        await recorder.stop()
                    } else {
                        await recorder.start()
                    }
                }
            } label: {
                HStack(spacing: 6) {
                    Circle()
                        .fill(recorder.isRecording ? Color.red : Color.red.opacity(0.6))
                        .frame(width: 10, height: 10)
                        .overlay {
                            if recorder.isRecording {
                                Circle()
                                    .fill(Color.red)
                                    .frame(width: 10, height: 10)
                                    .scaleEffect(1.4)
                                    .opacity(0.3)
                                    .animation(
                                        .easeInOut(duration: 0.8).repeatForever(autoreverses: true),
                                        value: recorder.isRecording
                                    )
                            }
                        }
                    Text(recorder.isRecording ? "Stop" : "Record")
                        .fontWeight(.medium)
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .buttonStyle(.borderedProminent)
            .tint(recorder.isRecording ? .red : .accentColor)
            .disabled(recorder.isStarting)

            // Duration
            if recorder.isRecording {
                Text(recorder.formattedDuration)
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(.secondary)
            }

            Spacer()

            // Detected apps badge
            if recorder.isRecording {
                HStack(spacing: 4) {
                    Image(systemName: "app.connected.to.app.below.fill")
                        .font(.caption)
                    Text(recorder.detectedMeetingApps)
                        .font(.caption)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(.ultraThinMaterial, in: Capsule())
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
}

// MARK: - Transcript Scroll View

private struct TranscriptScrollView: View {
    let segments: [TaggedSegment]
    @Binding var autoScroll: Bool

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(segments) { segment in
                        TranscriptRow(segment: segment)
                            .id(segment.id)
                    }
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
            }
            .onChange(of: segments.count) { _, _ in
                if autoScroll, let last = segments.last {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo(last.id, anchor: .bottom)
                    }
                }
            }
        }
    }
}

// MARK: - Single Transcript Row

private struct TranscriptRow: View {
    let segment: TaggedSegment

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            // Timestamp
            Text(formatTimestamp(segment.start))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 52, alignment: .trailing)

            // Speaker pill
            Text(segment.speaker)
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundStyle(.white)
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(speakerColor(for: segment.speaker), in: Capsule())

            // Transcript text
            if segment.text.isEmpty {
                Text("...")
                    .font(.body)
                    .foregroundStyle(.quaternary)
                    .italic()
            } else {
                Text(segment.text)
                    .font(.body)
                    .foregroundStyle(segment.isFinal ? .primary : .secondary)
                    .opacity(segment.isFinal ? 1.0 : 0.7)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 4)
        .background(
            RoundedRectangle(cornerRadius: 4)
                .fill(speakerColor(for: segment.speaker).opacity(0.05))
        )
    }

    private func formatTimestamp(_ time: TimeInterval) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// MARK: - Speaker Color Mapping

/// Deterministic color assignment based on speaker label hash.
/// Local speakers get warm tones, remote speakers get cool tones.
private func speakerColor(for speaker: String) -> Color {
    let localColors: [Color] = [
        .blue, .purple, .indigo, .mint
    ]
    let remoteColors: [Color] = [
        .orange, .pink, .red, .yellow
    ]

    let isLocal = speaker.hasPrefix("Local")
    let palette = isLocal ? localColors : remoteColors

    // Stable hash to pick a color
    let hash = abs(speaker.hashValue)
    return palette[hash % palette.count]
}

// MARK: - Status Bar

@available(macOS 26.0, *)
private struct StatusBar: View {
    @ObservedObject var recorder: MeetingRecorderController

    var body: some View {
        HStack(spacing: 12) {
            if let error = recorder.errorMessage {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.yellow)
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            } else if recorder.isRecording {
                Circle()
                    .fill(.green)
                    .frame(width: 6, height: 6)
                Text("Recording")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                let speakers = Set(recorder.mergedSegments.map(\.speaker))
                Text("\(speakers.count) speaker\(speakers.count == 1 ? "" : "s")")
                    .font(.caption)
                    .foregroundStyle(.tertiary)

                Text("\(recorder.mergedSegments.count) segments")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                Text("Ready")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }

            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 6)
    }
}

// MARK: - Preview

@available(macOS 26.0, *)
#Preview {
    MeetingRecorderView()
        .frame(width: 700, height: 500)
}
