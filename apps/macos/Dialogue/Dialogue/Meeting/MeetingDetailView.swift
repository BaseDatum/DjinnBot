import SwiftUI
import AVFoundation

// MARK: - MeetingDetailView

/// Detail view for reviewing a saved meeting transcript.
struct MeetingDetailView: View {
    let meeting: MeetingMetadata
    
    @StateObject private var viewModel: MeetingDetailViewModel
    
    init(meeting: MeetingMetadata) {
        self.meeting = meeting
        _viewModel = StateObject(wrappedValue: MeetingDetailViewModel(meeting: meeting))
    }
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            headerSection
            
            Divider()
            
            // Transcript
            if viewModel.segments.isEmpty {
                emptyTranscriptView
            } else {
                transcriptSection
            }
        }
        .frame(minWidth: 500, minHeight: 400)
    }
    
    // MARK: - Header
    
    private var headerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: sourceIcon)
                    .font(.title2)
                    .foregroundStyle(sourceColor)
                
                VStack(alignment: .leading, spacing: 2) {
                    Text(meeting.displayName)
                        .font(.title2)
                        .fontWeight(.semibold)
                    
                    HStack(spacing: 12) {
                        if let app = meeting.sourceApp {
                            Label(app, systemImage: "app")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        
                        Label(formatDuration(meeting.duration), systemImage: "clock")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        Label("\(meeting.speakerCount) speaker\(meeting.speakerCount == 1 ? "" : "s")", systemImage: "person.2")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        
                        Label("\(meeting.segmentCount) segment\(meeting.segmentCount == 1 ? "" : "s")", systemImage: "text.quote")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                
                Spacer()
                
                // Audio playback controls
                if viewModel.hasAudio {
                    Button {
                        viewModel.togglePlayback()
                    } label: {
                        Image(systemName: viewModel.isPlaying ? "pause.circle.fill" : "play.circle.fill")
                            .font(.title)
                    }
                    .buttonStyle(.borderless)
                    .help(viewModel.isPlaying ? "Pause" : "Play")
                }
            }
            
            // Speaker chips
            if !meeting.detectedSpeakers.isEmpty {
                HStack(spacing: 6) {
                    ForEach(meeting.detectedSpeakers) { speaker in
                        HStack(spacing: 4) {
                            Circle()
                                .fill(speakerColor(for: speaker))
                                .frame(width: 6, height: 6)
                            Text(speaker.label)
                                .font(.caption2)
                        }
                        .padding(.horizontal, 8)
                        .padding(.vertical, 3)
                        .background(.quaternary, in: Capsule())
                    }
                }
            }
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
        .background(Color(nsColor: .controlBackgroundColor))
    }
    
    // MARK: - Transcript
    
    private var transcriptSection: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                ForEach(viewModel.segments) { segment in
                    HStack(alignment: .top, spacing: 8) {
                        // Timestamp
                        Text(formatTime(segment.startTime))
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                            .frame(width: 50, alignment: .trailing)
                        
                        // Play from here
                        if viewModel.hasAudio {
                            Button {
                                viewModel.playFrom(time: segment.startTime)
                            } label: {
                                Image(systemName: "play.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)
                            .frame(width: 20)
                        }
                        
                        // Speaker label
                        Text(segment.speakerLabel)
                            .font(.caption)
                            .fontWeight(.semibold)
                            .foregroundStyle(Self.speakerColors[abs(segment.speakerColorIndex) % Self.speakerColors.count])
                            .frame(width: 80, alignment: .trailing)
                        
                        // Text
                        Text(segment.text)
                            .font(.body)
                            .textSelection(.enabled)
                    }
                    .padding(.horizontal, 16)
                }
            }
            .padding(.vertical, 12)
        }
    }
    
    private var emptyTranscriptView: some View {
        VStack(spacing: 12) {
            Spacer()
            Image(systemName: "text.page.slash")
                .font(.system(size: 40))
                .foregroundStyle(.tertiary)
            Text("No transcript available")
                .font(.headline)
                .foregroundStyle(.secondary)
            Text("This meeting's transcript may have been removed.")
                .font(.caption)
                .foregroundStyle(.tertiary)
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
    
    // MARK: - Helpers
    
    private var sourceIcon: String {
        switch meeting.sourceType {
        case .manual: return "record.circle"
        case .call: return "phone"
        case .meetingApp: return "video"
        }
    }
    
    private var sourceColor: Color {
        switch meeting.sourceType {
        case .manual: return .red
        case .call: return .green
        case .meetingApp: return .blue
        }
    }
    
    private func speakerColor(for speaker: DetectedSpeakerSummary) -> Color {
        let colors: [Color] = [.blue, .green, .orange, .purple, .pink, .teal, .indigo, .mint]
        let idx = abs(speaker.label.hashValue) % colors.count
        return colors[idx]
    }
    
    private func formatDuration(_ seconds: TimeInterval) -> String {
        let h = Int(seconds) / 3600
        let m = (Int(seconds) % 3600) / 60
        let s = Int(seconds) % 60
        if h > 0 {
            return String(format: "%d:%02d:%02d", h, m, s)
        }
        return String(format: "%02d:%02d", m, s)
    }
    
    private func formatTime(_ seconds: TimeInterval) -> String {
        let m = Int(seconds) / 60
        let s = Int(seconds) % 60
        return String(format: "%d:%02d", m, s)
    }
    
    /// Speaker colors for transcript display.
    private static let speakerColors: [Color] = [
        .blue, .green, .orange, .purple, .pink, .teal, .indigo, .mint
    ]
}

// MARK: - MeetingDetailViewModel

@MainActor
final class MeetingDetailViewModel: ObservableObject {
    let meeting: MeetingMetadata
    
    @Published var segments: [TranscriptSegment] = []
    @Published var isPlaying: Bool = false
    @Published var hasAudio: Bool = false
    
    private var audioPlayer: AVAudioPlayer?
    
    init(meeting: MeetingMetadata) {
        self.meeting = meeting
        loadData()
    }
    
    private func loadData() {
        segments = MeetingStore.shared.loadTranscript(for: meeting)
        
        if let audioURL = MeetingStore.shared.audioFileURL(for: meeting) {
            hasAudio = FileManager.default.fileExists(atPath: audioURL.path)
        }
    }
    
    func togglePlayback() {
        if isPlaying {
            audioPlayer?.pause()
            isPlaying = false
        } else {
            if audioPlayer == nil {
                guard let audioURL = MeetingStore.shared.audioFileURL(for: meeting),
                      let player = try? AVAudioPlayer(contentsOf: audioURL) else { return }
                audioPlayer = player
            }
            audioPlayer?.play()
            isPlaying = true
        }
    }
    
    func playFrom(time: TimeInterval) {
        if audioPlayer == nil {
            guard let audioURL = MeetingStore.shared.audioFileURL(for: meeting),
                  let player = try? AVAudioPlayer(contentsOf: audioURL) else { return }
            audioPlayer = player
        }
        audioPlayer?.currentTime = time
        audioPlayer?.play()
        isPlaying = true
    }
    
    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        isPlaying = false
    }
}


