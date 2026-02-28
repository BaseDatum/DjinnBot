import SwiftUI
import MarkdownUI

/// The floating chat toolbar that warps up from the bottom edge of the window.
/// - Collapsed: input bar with inline response preview — messages are sent and
///   responses shown without opening the full panel.
/// - Expanded: full chat panel (60-80% of window height, resizable)
///
/// Triggered by mouse proximity to bottom edge or Cmd+K keyboard shortcut.
struct FloatingChatToolbar: View {
    @ObservedObject var detector: BottomEdgeDetector
    @StateObject private var chatManager = ChatSessionManager.shared
    
    /// Whether the toolbar is visible (controlled by mouse proximity or keyboard).
    @Binding var isVisible: Bool
    
    /// Whether the panel is expanded to full chat mode.
    @State private var isExpanded: Bool = false
    
    /// Input text for the collapsed bar's text field.
    @State private var collapsedInput: String = ""
    
    /// Focus state for the collapsed bar's text field — used to force a
    /// visual refresh after clearing the input (works around a macOS SwiftUI
    /// bug where TextField doesn't update visually when @State changes
    /// inside onCommit/onSubmit).
    @FocusState private var collapsedInputFocused: Bool
    
    /// Whether the inline response area is showing in collapsed mode.
    @State private var showInlineResponse: Bool = false
    
    /// Whether the mouse is hovering over the toolbar area. While true, the
    /// toolbar stays visible regardless of the bottom-edge detector state.
    @State private var isHoveringToolbar: Bool = false
    
    /// Whether the user has scrolled up in the warp-up mini chat.
    /// When true, auto-scroll is suppressed to respect user intent.
    @State private var warpUserScrolledUp: Bool = false
    
    /// Track panel height for drag resizing.
    @State private var panelHeight: CGFloat = 400
    
    /// Minimum expanded panel height.
    private let minPanelHeight: CGFloat = 200
    
    /// Maximum expanded panel height ratio (relative to container).
    private let maxPanelRatio: CGFloat = 0.85
    
    /// Maximum height for the inline response area in collapsed mode.
    /// ~5 lines of caption-sized text (~14pt line height × 5 + padding).
    private let maxInlineResponseHeight: CGFloat = 90
    
    var body: some View {
        GeometryReader { geo in
            let maxHeight = geo.size.height * maxPanelRatio
            
            VStack(spacing: 0) {
                Spacer()
                
                if isVisible || isExpanded || isHoveringToolbar {
                    VStack(spacing: 0) {
                        if isExpanded {
                            // Drag handle
                            dragHandle
                            
                            // Full chat panel
                            ChatPanelView(
                                manager: chatManager,
                                isExpanded: $isExpanded
                            )
                            .frame(height: min(panelHeight, maxHeight))
                        } else {
                            // Collapsed toolbar bar with optional inline response
                            collapsedBar
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: isExpanded ? 16 : 12, style: .continuous)
                            .fill(.ultraThinMaterial)
                            .shadow(color: .black.opacity(0.15), radius: 12, y: -4)
                    )
                    .clipShape(RoundedRectangle(cornerRadius: isExpanded ? 16 : 12, style: .continuous))
                    .frame(maxWidth: geo.size.width * 0.6)
                    .frame(maxWidth: .infinity) // center within parent
                    .padding(.bottom, 8)
                    .onHover { hovering in
                        isHoveringToolbar = hovering
                        if hovering {
                            // Keep detector pinned while hovering over toolbar
                            detector.forceShow()
                        }
                    }
                    .transition(
                        .asymmetric(
                            insertion: .move(edge: .bottom).combined(with: .opacity),
                            removal: .move(edge: .bottom).combined(with: .opacity)
                        )
                    )
                    .animation(
                        .spring(response: 0.4, dampingFraction: 0.7),
                        value: isExpanded
                    )
                }
            }
            .animation(
                .spring(response: 0.4, dampingFraction: 0.7),
                value: isVisible
            )
            .animation(
                .spring(response: 0.3, dampingFraction: 0.8),
                value: isExpanded
            )
        }
    }
    
    // MARK: - Collapsed Bar
    
    /// Whether the inline chat history area should be visible.
    private var hasActiveChat: Bool {
        if showInlineResponse { return true }
        guard let session = chatManager.activeSession else { return false }
        return !session.messages.isEmpty
    }
    
    private var collapsedBar: some View {
        VStack(spacing: 0) {
            // Inline response area (shown once a chat has been started)
            if hasActiveChat, let session = chatManager.activeSession {
                inlineResponseArea(session: session)
                
                Divider()
                    .padding(.horizontal, 12)
            }
            
            // Input row
            HStack(spacing: 12) {
                // Text field placeholder / input
                HStack(spacing: 8) {
                    Image(systemName: "sparkles")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                    
                    TextField("Ask Dialogue AI...", text: $collapsedInput)
                        .textFieldStyle(.plain)
                        .font(.subheadline)
                        .focused($collapsedInputFocused)
                        .onSubmit {
                            sendFromCollapsedBar()
                        }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(Color(.controlBackgroundColor))
                )
                
                // Session indicator
                if let session = chatManager.activeSession {
                    HStack(spacing: 4) {
                        Circle()
                            .fill(session.status.isActive ? Color.green : Color.gray)
                            .frame(width: 6, height: 6)
                        Text(session.title)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                
                // Expand chat / open panel button
                Button {
                    expand()
                } label: {
                    Image(systemName: "bubble.left.and.bubble.right")
                        .font(.body)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .help("Open Chat Panel")
            }
            .padding(.horizontal, 16)
            .frame(height: 48)
        }
    }
    
    // MARK: - Inline Chat History Area
    
    /// Mini chat log shown in the collapsed warp-up bar. Displays the full
    /// scrollable message history (user messages, assistant markdown, thinking
    /// indicators, tool call indicators) in a compact format.
    /// Thinking and completed tool call messages are hidden once generation ends.
    /// Auto-scrolls to bottom unless the user has intentionally scrolled up.
    private func inlineResponseArea(session: ChatSession) -> some View {
        let visibleMessages = session.messages.filter { msg in
            // Hide thinking messages once the turn is done
            if msg.role == .thinking && !session.isGenerating { return false }
            // Hide completed/failed tool calls once the turn is done
            if msg.role == .toolCall && (msg.toolStatus == .completed || msg.toolStatus == .failed) && !session.isGenerating { return false }
            return true
        }
        
        return ScrollViewReader { proxy in
            ScrollView(.vertical, showsIndicators: true) {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(visibleMessages) { msg in
                        miniMessageRow(msg)
                    }
                    
                    // Live generation indicators
                    if session.isGenerating {
                        miniGeneratingIndicator(session: session)
                    }
                    
                    // Bottom anchor + scroll position detector
                    GeometryReader { geo in
                        Color.clear.preference(
                            key: WarpScrollBottomKey.self,
                            value: geo.frame(in: .named("warpScroll")).maxY
                        )
                    }
                    .frame(height: 1)
                    .id("warp_bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
            }
            .coordinateSpace(name: "warpScroll")
            .onPreferenceChange(WarpScrollBottomKey.self) { bottomY in
                warpUserScrolledUp = bottomY > 30
            }
            .frame(maxHeight: maxInlineResponseHeight)
            .onChange(of: session.messages.count) { _, _ in
                if !warpUserScrolledUp {
                    withAnimation(.easeOut(duration: 0.15)) {
                        proxy.scrollTo("warp_bottom", anchor: .bottom)
                    }
                }
            }
            .onChange(of: session.messages.last?.content ?? "") { _, _ in
                if !warpUserScrolledUp {
                    proxy.scrollTo("warp_bottom", anchor: .bottom)
                }
            }
            .onAppear {
                proxy.scrollTo("warp_bottom", anchor: .bottom)
            }
        }
        .contentShape(Rectangle())
        .onTapGesture {
            expand()
        }
    }
    
    /// A single message row in the mini chat log.
    @ViewBuilder
    private func miniMessageRow(_ msg: ChatMessage) -> some View {
        switch msg.role {
        case .user:
            // User messages — right-aligned, small accent bubble
            HStack {
                Spacer(minLength: 40)
                Text(msg.content)
                    .font(.caption2)
                    .foregroundStyle(.white)
                    .padding(.horizontal, 8)
                    .padding(.vertical, 4)
                    .background(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .fill(Color.accentColor)
                    )
                    .lineLimit(3)
            }
            
        case .assistant:
            // Assistant messages — left-aligned, markdown rendered small
            if !msg.content.isEmpty {
                HStack(alignment: .top) {
                    Markdown(msg.content)
                        .markdownTextStyle {
                            FontSize(11)
                        }
                    Spacer(minLength: 40)
                }
            }
            
        case .thinking:
            // Thinking — compact indicator
            HStack(spacing: 4) {
                ThinkingPulseView()
                Text("Thinking...")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            
        case .toolCall:
            // Tool calls — show spinner while running, nothing when done
            if msg.toolStatus == .running || msg.toolStatus == .idle {
                HStack(spacing: 4) {
                    ProgressView()
                        .controlSize(.mini)
                    Text("Calling tools...")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            // Completed tool calls render nothing — they disappear
            
        case .error:
            HStack(spacing: 4) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(.red)
                Text(msg.content)
                    .font(.caption2)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }
        }
    }
    
    /// Live generation indicator shown at the bottom while streaming.
    @ViewBuilder
    private func miniGeneratingIndicator(session: ChatSession) -> some View {
        // Only show streaming dots if there's no streaming assistant message yet
        // and no tool calls running (those have their own indicators above)
        let hasStreamingText = session.messages.contains(where: { $0.role == .assistant && $0.isStreaming && !$0.content.isEmpty })
        let hasRunningTools = session.messages.contains(where: { $0.role == .toolCall && ($0.toolStatus == .running || $0.toolStatus == .idle) })
        let hasThinking = session.messages.contains(where: { $0.role == .thinking && !$0.content.isEmpty })
        
        if !hasStreamingText && !hasRunningTools && !hasThinking {
            StreamingDotsView()
        }
    }
    
    // MARK: - Drag Handle
    
    private var dragHandle: some View {
        VStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 2)
                .fill(Color(.separatorColor))
                .frame(width: 36, height: 4)
                .padding(.vertical, 6)
                .gesture(
                    DragGesture()
                        .onChanged { value in
                            // Dragging up increases height
                            panelHeight = max(minPanelHeight, panelHeight - value.translation.height)
                        }
                )
                .cursor(.resizeUpDown)
        }
    }
    
    // MARK: - Actions
    
    private func expand() {
        withAnimation(.spring(response: 0.4, dampingFraction: 0.7)) {
            isExpanded = true
            showInlineResponse = false
        }
    }
    
    /// Send from the collapsed bar without expanding the panel.
    /// Shows the response inline in the warp-up area.
    private func sendFromCollapsedBar() {
        let text = collapsedInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        
        // Clear input immediately. The focus cycle forces the TextField to
        // re-read the binding, working around a macOS SwiftUI rendering bug
        // where the displayed text doesn't update when @State changes during
        // onSubmit.
        collapsedInput = ""
        collapsedInputFocused = false
        DispatchQueue.main.async {
            collapsedInputFocused = true
        }
        
        withAnimation(.easeOut(duration: 0.2)) {
            showInlineResponse = true
        }
        
        // Use the reliable queued-send path — no race conditions.
        chatManager.sendMessageWhenReady(text)
    }
    
    /// Called from external keyboard shortcut (Cmd+K).
    func toggle() {
        if isExpanded {
            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                isExpanded = false
            }
            // Brief delay before hiding entirely
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                detector.forceHide()
            }
        } else if isVisible {
            expand()
        } else {
            detector.forceShow()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) {
                expand()
            }
        }
    }
}

// MARK: - Cursor Extension

extension View {
    func cursor(_ cursor: NSCursor) -> some View {
        onHover { inside in
            if inside {
                cursor.push()
            } else {
                NSCursor.pop()
            }
        }
    }
}

/// Preference key for detecting scroll position in the warp-up mini chat.
private struct WarpScrollBottomKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = nextValue()
    }
}
