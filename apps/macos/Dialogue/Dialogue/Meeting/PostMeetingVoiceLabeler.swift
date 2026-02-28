import SwiftUI
import AppKit
import AVFoundation
import UniformTypeIdentifiers

// MARK: - PostMeetingVoiceLabeler

/// Manages the floating post-meeting panel for reviewing speakers and assigning names.
final class PostMeetingVoiceLabeler {
    
    private var window: NSWindow?
    
    /// Show the post-meeting labeler panel.
    @MainActor
    func show(recording: MeetingRecording) {
        let viewModel = VoiceLabelerViewModel(recording: recording)
        let contentView = PostMeetingVoiceLabelerView(viewModel: viewModel)
        
        let hostingView = NSHostingView(rootView: contentView)
        hostingView.frame = NSRect(x: 0, y: 0, width: 700, height: 550)
        
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 700, height: 550),
            styleMask: [.titled, .closable, .resizable, .utilityWindow],
            backing: .buffered,
            defer: false
        )
        panel.title = "Review Meeting Speakers"
        panel.contentView = hostingView
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.level = .floating
        panel.minSize = NSSize(width: 560, height: 400)
        panel.center()
        panel.makeKeyAndOrderFront(nil)
        
        self.window = panel
    }
    
    /// Close the panel.
    @MainActor
    func close() {
        window?.close()
        window = nil
    }
}

// MARK: - VoiceLabelerViewModel

@MainActor
final class VoiceLabelerViewModel: ObservableObject {
    let recording: MeetingRecording
    
    @Published var detectedSpeakers: [DetectedSpeaker]
    @Published var selectedSpeakerID: String?
    @Published var editingName: String = ""
    @Published var isSaving: Bool = false
    @Published var saveMessage: String?
    
    /// Suggested speaker merges from the diarization service.
    @Published var mergeablePairs: [(sourceID: String, destinationID: String)] = []
    
    /// The speaker currently being hovered over during a drag operation (for drop highlight).
    @Published var dropTargetSpeakerID: String?
    
    /// Audio player for segment playback.
    private var audioPlayer: AVAudioPlayer?
    
    init(recording: MeetingRecording) {
        self.recording = recording
        self.detectedSpeakers = recording.detectedSpeakers
        
        // Check for mergeable speaker pairs
        self.mergeablePairs = RecordingCoordinator.shared.diarizationService.findMergeableSpeakerPairs()
    }
    
    /// Segments for the currently selected speaker.
    var selectedSpeakerSegments: [TranscriptSegment] {
        guard let speakerID = selectedSpeakerID,
              let speaker = detectedSpeakers.first(where: { $0.id == speakerID }) else {
            return recording.segments
        }
        return recording.segments.filter { speaker.segmentIDs.contains($0.id) }
    }
    
    /// Select a speaker to view/edit.
    func selectSpeaker(_ id: String) {
        selectedSpeakerID = id
        if let speaker = detectedSpeakers.first(where: { $0.id == id }) {
            editingName = speaker.isIdentified ? speaker.label : ""
        }
    }
    
    /// Play a short audio clip for a given segment.
    func playSegment(_ segment: TranscriptSegment) {
        guard let audioURL = recording.audioFileURL else { return }
        
        // Load audio file and play the segment's time range
        guard let player = try? AVAudioPlayer(contentsOf: audioURL) else { return }
        player.currentTime = segment.startTime
        player.play()
        
        // Stop after segment duration
        let duration = segment.endTime - segment.startTime
        DispatchQueue.main.asyncAfter(deadline: .now() + duration) { [weak self] in
            self?.audioPlayer?.stop()
        }
        self.audioPlayer = player
    }
    
    /// Stop audio playback.
    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
    }
    
    /// Merge two speaker clusters that the diarization service identified as similar.
    func mergeSpeakers(sourceID: String, destinationID: String) {
        guard let sourceIdx = detectedSpeakers.firstIndex(where: { $0.id == sourceID }),
              let destIdx = detectedSpeakers.firstIndex(where: { $0.id == destinationID }) else { return }
        
        let source = detectedSpeakers[sourceIdx]
        let dest = detectedSpeakers[destIdx]
        
        // Merge segments
        recording.relabelSpeaker(clusterID: sourceID, newLabel: dest.label, profileID: dest.profileID)
        
        // Move segment IDs from source to destination
        var updatedDest = detectedSpeakers[destIdx]
        updatedDest.segmentIDs.append(contentsOf: source.segmentIDs)
        detectedSpeakers[destIdx] = updatedDest
        
        // Remove source speaker
        detectedSpeakers.remove(at: sourceIdx)
        
        // Also merge in the diarization service
        RecordingCoordinator.shared.diarizationService.mergeSpeakers(sourceID: sourceID, into: destinationID)
        
        // Remove this pair from suggestions
        mergeablePairs.removeAll { $0.sourceID == sourceID && $0.destinationID == destinationID }
        
        saveMessage = "Merged \(source.label) into \(dest.label)"
        DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
            self?.saveMessage = nil
        }
    }
    
    /// Whether the selected speaker has a usable embedding for voice profile creation.
    var selectedSpeakerHasEmbedding: Bool {
        guard let speakerID = selectedSpeakerID,
              let speaker = detectedSpeakers.first(where: { $0.id == speakerID }) else {
            return false
        }
        return !speaker.representativeEmbedding.isEmpty
    }
    
    /// Save a name for the selected speaker, creating a permanent voice profile
    /// when an embedding is available, or just relabeling the segments otherwise.
    func saveVoiceProfile() {
        guard let speakerID = selectedSpeakerID,
              let speaker = detectedSpeakers.first(where: { $0.id == speakerID }),
              !editingName.trimmingCharacters(in: .whitespaces).isEmpty else {
            return
        }
        
        let name = editingName.trimmingCharacters(in: .whitespaces)
        isSaving = true
        
        Task {
            if speaker.representativeEmbedding.isEmpty {
                // No embedding available (e.g. unmatched segments) — just relabel.
                recording.relabelSpeaker(clusterID: speakerID, newLabel: name, profileID: nil)
                
                if let idx = detectedSpeakers.firstIndex(where: { $0.id == speakerID }) {
                    detectedSpeakers[idx].label = name
                    detectedSpeakers[idx].isIdentified = true
                }
                
                saveMessage = "Renamed to \(name) (no voice profile — merge with a known speaker for future recognition)"
                
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) { [weak self] in
                    self?.saveMessage = nil
                }
            } else {
                do {
                    let profile = try VoiceProfileManager.shared.createProfile(
                        displayName: name,
                        embedding: speaker.representativeEmbedding
                    )
                    
                    // Update the recording's segments with the new name
                    recording.relabelSpeaker(clusterID: speakerID, newLabel: name, profileID: profile.id)
                    
                    // Update local state
                    if let idx = detectedSpeakers.firstIndex(where: { $0.id == speakerID }) {
                        detectedSpeakers[idx].label = name
                        detectedSpeakers[idx].profileID = profile.id
                        detectedSpeakers[idx].isIdentified = true
                    }
                    
                    saveMessage = "Saved voice profile for \(name)"
                    
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                        self?.saveMessage = nil
                    }
                } catch {
                    saveMessage = "Error: \(error.localizedDescription)"
                }
            }
            
            isSaving = false
        }
    }
}

// MARK: - PostMeetingVoiceLabelerView

struct PostMeetingVoiceLabelerView: View {
    @ObservedObject var viewModel: VoiceLabelerViewModel
    
    var body: some View {
        HSplitView {
            // Left: Speaker list
            speakerListPanel
                .frame(minWidth: 200, idealWidth: 240, maxWidth: 300)
            
            // Right: Transcript + controls
            transcriptPanel
                .frame(minWidth: 300)
        }
        .frame(minWidth: 560, minHeight: 400)
    }
    
    // MARK: - Speaker List
    
    private var speakerListPanel: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Detected Speakers")
                .font(.headline)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
            
            Divider()
            
            List(selection: $viewModel.selectedSpeakerID) {
                // "All speakers" option
                Label("All Speakers", systemImage: "person.3")
                    .tag(String?.none)
                
                ForEach(viewModel.detectedSpeakers) { speaker in
                    speakerRow(speaker)
                        .tag(Optional(speaker.id))
                        .draggable(speaker.id)
                        .dropDestination(for: String.self) { droppedIDs, _ in
                            guard let sourceID = droppedIDs.first,
                                  sourceID != speaker.id else { return false }
                            viewModel.mergeSpeakers(sourceID: sourceID, destinationID: speaker.id)
                            return true
                        } isTargeted: { isTargeted in
                            viewModel.dropTargetSpeakerID = isTargeted ? speaker.id : nil
                        }
                }
            }
            .listStyle(.sidebar)
            .onChange(of: viewModel.selectedSpeakerID) { _, newValue in
                if let id = newValue {
                    viewModel.selectSpeaker(id)
                }
            }
            
            // Drag hint
            Text("Drag a speaker onto another to merge them")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .padding(.horizontal, 12)
                .padding(.vertical, 4)
            
            // Merge suggestions
            if !viewModel.mergeablePairs.isEmpty {
                Divider()
                VStack(alignment: .leading, spacing: 6) {
                    Text("Merge Suggestions")
                        .font(.caption)
                        .fontWeight(.semibold)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                    
                    ForEach(Array(viewModel.mergeablePairs.enumerated()), id: \.offset) { _, pair in
                        let srcLabel = viewModel.detectedSpeakers.first(where: { $0.id == pair.sourceID })?.label ?? pair.sourceID
                        let dstLabel = viewModel.detectedSpeakers.first(where: { $0.id == pair.destinationID })?.label ?? pair.destinationID
                        
                        HStack(spacing: 4) {
                            Text("\(srcLabel)")
                                .font(.caption2)
                            Image(systemName: "arrow.right")
                                .font(.caption2)
                                .foregroundStyle(.tertiary)
                            Text("\(dstLabel)")
                                .font(.caption2)
                            Spacer()
                            Button("Merge") {
                                viewModel.mergeSpeakers(sourceID: pair.sourceID, destinationID: pair.destinationID)
                            }
                            .controlSize(.mini)
                            .buttonStyle(.bordered)
                        }
                        .padding(.horizontal, 12)
                    }
                }
                .padding(.vertical, 6)
            }
        }
    }
    
    // MARK: - Speaker Row
    
    private func speakerRow(_ speaker: DetectedSpeaker) -> some View {
        let isDropTarget = viewModel.dropTargetSpeakerID == speaker.id
        
        return HStack {
            Circle()
                .fill(speakerColor(for: speaker.colorIndex))
                .frame(width: 8, height: 8)
            
            VStack(alignment: .leading, spacing: 2) {
                Text(speaker.label)
                    .fontWeight(.medium)
                
                Text("\(speaker.segmentIDs.count) segments")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            
            Spacer()
            
            if speaker.isIdentified {
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.caption)
            }
        }
        .padding(.vertical, 2)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .fill(isDropTarget ? Color.accentColor.opacity(0.2) : Color.clear)
                .padding(.horizontal, -4)
        )
        .overlay(
            RoundedRectangle(cornerRadius: 6)
                .strokeBorder(isDropTarget ? Color.accentColor : Color.clear, lineWidth: 2)
                .padding(.horizontal, -4)
        )
    }
    
    // MARK: - Transcript Panel
    
    private var transcriptPanel: some View {
        VStack(spacing: 0) {
            // Naming controls (shown when a specific speaker is selected)
            if let speakerID = viewModel.selectedSpeakerID,
               let speaker = viewModel.detectedSpeakers.first(where: { $0.id == speakerID }),
               !speaker.label.hasPrefix("You") {
                nameEditingSection(speaker: speaker)
                Divider()
            }
            
            // Transcript
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    ForEach(viewModel.selectedSpeakerSegments) { segment in
                        HStack(alignment: .top, spacing: 8) {
                            // Play button
                            Button {
                                viewModel.playSegment(segment)
                            } label: {
                                Image(systemName: "play.circle")
                                    .foregroundStyle(.secondary)
                            }
                            .buttonStyle(.borderless)
                            .frame(width: 20)
                            
                            // Timestamp
                            Text(formatTime(segment.startTime))
                                .font(.caption)
                                .foregroundStyle(.tertiary)
                                .frame(width: 50, alignment: .trailing)
                            
                            // Speaker label
                            Text(segment.speakerLabel)
                                .font(.caption)
                                .fontWeight(.semibold)
                                .foregroundStyle(speakerColor(for: segment.speakerColorIndex))
                                .frame(width: 80, alignment: .trailing)
                            
                            // Text
                            Text(segment.text)
                                .font(.body)
                                .textSelection(.enabled)
                        }
                        .padding(.horizontal, 12)
                    }
                }
                .padding(.vertical, 8)
            }
            
            // Save status
            if let message = viewModel.saveMessage {
                HStack {
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(.ultraThinMaterial)
            }
        }
    }
    
    // MARK: - Name Editing
    
    private func nameEditingSection(speaker: DetectedSpeaker) -> some View {
        HStack(spacing: 12) {
            Circle()
                .fill(speakerColor(for: speaker.colorIndex))
                .frame(width: 12, height: 12)
            
            if speaker.isIdentified {
                Text(speaker.label)
                    .font(.headline)
                
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                TextField("Enter name for this speaker...", text: $viewModel.editingName)
                    .textFieldStyle(.roundedBorder)
                    .frame(maxWidth: 200)
                
                Button(viewModel.selectedSpeakerHasEmbedding ? "Save Voice Profile" : "Rename Speaker") {
                    viewModel.saveVoiceProfile()
                }
                .buttonStyle(.borderedProminent)
                .disabled(viewModel.editingName.trimmingCharacters(in: .whitespaces).isEmpty || viewModel.isSaving)
                
                if !viewModel.selectedSpeakerHasEmbedding {
                    Text("No voice data — merge with another speaker for recognition")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            
            Spacer()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
    }
    
    // MARK: - Helpers
    
    private static let speakerColors: [Color] = [
        .blue, .green, .orange, .purple, .pink, .teal, .indigo, .mint
    ]
    
    private func speakerColor(for index: Int) -> Color {
        Self.speakerColors[abs(index) % Self.speakerColors.count]
    }
    
    private func formatTime(_ seconds: TimeInterval) -> String {
        let m = Int(seconds) / 60
        let s = Int(seconds) % 60
        return String(format: "%d:%02d", m, s)
    }
}
