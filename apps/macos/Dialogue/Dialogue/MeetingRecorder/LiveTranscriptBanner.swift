import SwiftUI

/// A collapsible banner shown below the title bar during recording.
///
/// Behavior:
/// - Starts expanded showing the live transcript.
/// - Auto-collapses after 15 seconds unless the user is hovering or has manually reopened it.
/// - When collapsed, shows an animated "Transcribing..." indicator.
/// - Chevron button: points up when expanded (click to collapse), down when collapsed (click to expand).
/// - User intent is first-class: if the user manually expands after auto-collapse,
///   it stays open until they manually collapse it.
@available(macOS 26.0, *)
struct LiveTranscriptBanner: View {
    @ObservedObject var recorder: MeetingRecorderController

    // MARK: - Collapse State

    /// Whether the transcript area is expanded (showing full transcript).
    @State private var isExpanded = true

    /// True once the user has deliberately toggled open after auto-collapse.
    /// Prevents further auto-collapses.
    @State private var userDidManuallyExpand = false

    /// Whether the mouse is currently inside the banner.
    @State private var isHovering = false

    /// Timer for the auto-collapse countdown.
    @State private var autoCollapseTask: Task<Void, Never>?

    /// Tracks whether the initial auto-collapse window has passed.
    @State private var autoCollapseWindowExpired = false

    // MARK: - Animated Dots

    @State private var dotCount = 1
    @State private var dotTimer: Timer?

    // MARK: - Auto Scroll

    @State private var autoScroll = true

    var body: some View {
        VStack(spacing: 0) {
            if isExpanded {
                expandedContent
                    .transition(.move(edge: .top).combined(with: .opacity))
                toggleBar
            } else {
                collapsedBar
                    .transition(.opacity)
            }

            Divider()
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .onHover { hovering in
            isHovering = hovering
        }
        .onAppear {
            startAutoCollapseTimer()
            startDotAnimation()
        }
        .onDisappear {
            cancelAutoCollapse()
            stopDotAnimation()
        }
        .onChange(of: recorder.isRecording) { _, isRecording in
            if isRecording {
                // New recording started: reset state
                isExpanded = true
                userDidManuallyExpand = false
                autoCollapseWindowExpired = false
                startAutoCollapseTimer()
                startDotAnimation()
            } else {
                cancelAutoCollapse()
                stopDotAnimation()
            }
        }
    }

    // MARK: - Expanded Content

    private var expandedContent: some View {
        VStack(spacing: 0) {
            if recorder.mergedSegments.isEmpty {
                HStack(spacing: 6) {
                    ProgressView()
                        .controlSize(.small)
                    Text("Waiting for audio...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
                .frame(height: 60)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            ForEach(recorder.mergedSegments) { segment in
                                BannerTranscriptRow(segment: segment)
                                    .id(segment.id)
                            }
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                    }
                    .frame(maxHeight: 150)
                    .onChange(of: recorder.mergedSegments.count) { _, _ in
                        if autoScroll, let last = recorder.mergedSegments.last {
                            withAnimation(.easeOut(duration: 0.15)) {
                                proxy.scrollTo(last.id, anchor: .bottom)
                            }
                        }
                    }
                }
            }
        }
    }

    // MARK: - Collapsed Bar (chevron + indicator in one row)

    private var collapsedBar: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded = true
                userDidManuallyExpand = true
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "chevron.down")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)

                Circle()
                    .fill(Color.red)
                    .frame(width: 6, height: 6)

                Text("Transcribing" + String(repeating: ".", count: dotCount))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .frame(width: 100, alignment: .leading)

                if recorder.isRecording {
                    Text(recorder.formattedDuration)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.tertiary)
                }

                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Toggle Bar (expanded state only)

    private var toggleBar: some View {
        Button {
            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded = false
            }
        } label: {
            HStack {
                Spacer()
                Image(systemName: "chevron.up")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Spacer()
            }
            .frame(height: 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    // MARK: - Auto-Collapse Logic

    private func startAutoCollapseTimer() {
        cancelAutoCollapse()
        autoCollapseWindowExpired = false

        autoCollapseTask = Task { @MainActor in
            try? await Task.sleep(for: .seconds(15))
            guard !Task.isCancelled else { return }

            autoCollapseWindowExpired = true

            // Don't collapse if user manually expanded or is hovering
            if userDidManuallyExpand { return }

            if isHovering {
                // Wait for mouse to leave, then collapse
                await waitForMouseExit()
                // Re-check: user may have manually expanded while we waited
                if userDidManuallyExpand { return }
            }

            withAnimation(.easeInOut(duration: 0.2)) {
                isExpanded = false
            }
        }
    }

    /// Polls until the mouse leaves the banner area.
    private func waitForMouseExit() async {
        while isHovering && !Task.isCancelled && !userDidManuallyExpand {
            try? await Task.sleep(for: .milliseconds(200))
        }
    }

    private func cancelAutoCollapse() {
        autoCollapseTask?.cancel()
        autoCollapseTask = nil
    }

    // MARK: - Dot Animation

    private func startDotAnimation() {
        stopDotAnimation()
        dotTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
            Task { @MainActor in
                dotCount = (dotCount % 3) + 1
            }
        }
    }

    private func stopDotAnimation() {
        dotTimer?.invalidate()
        dotTimer = nil
    }
}

// MARK: - Banner Transcript Row

private struct BannerTranscriptRow: View {
    let segment: TaggedSegment

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(formatTimestamp(segment.start))
                .font(.system(.caption2, design: .monospaced))
                .foregroundStyle(.tertiary)
                .frame(width: 40, alignment: .trailing)

            Text(segment.speaker)
                .font(.caption2)
                .fontWeight(.semibold)
                .foregroundStyle(.white)
                .padding(.horizontal, 4)
                .padding(.vertical, 1)
                .background(speakerColor(for: segment.speaker), in: Capsule())

            if segment.text.isEmpty {
                Text("...")
                    .font(.caption)
                    .foregroundStyle(.quaternary)
                    .italic()
            } else {
                Text(segment.text)
                    .font(.caption)
                    .foregroundStyle(segment.isFinal ? .primary : .secondary)
                    .opacity(segment.isFinal ? 1.0 : 0.7)
            }

            Spacer(minLength: 0)
        }
        .padding(.vertical, 2)
    }

    private func formatTimestamp(_ time: TimeInterval) -> String {
        let minutes = Int(time) / 60
        let seconds = Int(time) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

/// Deterministic color from speaker label hash.
private func speakerColor(for speaker: String) -> Color {
    let localColors: [Color] = [.blue, .purple, .indigo, .mint]
    let remoteColors: [Color] = [.orange, .pink, .red, .yellow]
    let isLocal = speaker.hasPrefix("Local")
    let palette = isLocal ? localColors : remoteColors
    let hash = abs(speaker.hashValue)
    return palette[hash % palette.count]
}
