import SwiftUI

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
    
    /// Whether the inline response area is showing in collapsed mode.
    @State private var showInlineResponse: Bool = false
    
    /// Track panel height for drag resizing.
    @State private var panelHeight: CGFloat = 400
    
    /// Minimum expanded panel height.
    private let minPanelHeight: CGFloat = 200
    
    /// Maximum expanded panel height ratio (relative to container).
    private let maxPanelRatio: CGFloat = 0.85
    
    /// Maximum height for the inline response area in collapsed mode.
    private let maxInlineResponseHeight: CGFloat = 200
    
    var body: some View {
        GeometryReader { geo in
            let maxHeight = geo.size.height * maxPanelRatio
            
            VStack(spacing: 0) {
                Spacer()
                
                if isVisible || isExpanded {
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
                    .padding(.horizontal, isExpanded ? 8 : 16)
                    .padding(.bottom, 8)
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
    
    private var collapsedBar: some View {
        VStack(spacing: 0) {
            // Inline response area (shown after sending a message)
            if showInlineResponse, let session = chatManager.activeSession {
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
                    
                    TextField("Ask Dialogue AI...", text: $collapsedInput, onCommit: {
                        let trimmed = collapsedInput.trimmingCharacters(in: .whitespacesAndNewlines)
                        if !trimmed.isEmpty {
                            sendFromCollapsedBar()
                        }
                    })
                    .textFieldStyle(.plain)
                    .font(.subheadline)
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
    
    // MARK: - Inline Response Area
    
    /// Compact response area shown in the collapsed bar after sending a message.
    /// Shows streaming dots while generating, then the assistant's response text.
    private func inlineResponseArea(session: ChatSession) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            // Show the latest assistant response or streaming state
            if session.isGenerating {
                // Check if there's a thinking message for this turn
                if let thinkingMsg = session.messages.last(where: { $0.role == .thinking }),
                   !thinkingMsg.content.isEmpty {
                    HStack(spacing: 6) {
                        ThinkingPulseView()
                        Text("Thinking...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                
                // Show streaming assistant text if any
                if let assistantMsg = session.messages.last(where: { $0.role == .assistant && $0.isStreaming }),
                   !assistantMsg.content.isEmpty {
                    Text(assistantMsg.content)
                        .font(.caption)
                        .foregroundStyle(.primary)
                        .lineLimit(6)
                        .textSelection(.enabled)
                } else {
                    // No text yet — show streaming dots
                    StreamingDotsView()
                }
            } else if let lastAssistant = session.messages.last(where: { $0.role == .assistant }) {
                // Completed response
                Text(lastAssistant.content)
                    .font(.caption)
                    .foregroundStyle(.primary)
                    .lineLimit(6)
                    .textSelection(.enabled)
            }
            
            // "Open full chat" link
            HStack {
                Spacer()
                Button {
                    expand()
                } label: {
                    Text("Open full chat")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .frame(maxHeight: maxInlineResponseHeight)
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
        collapsedInput = ""
        guard !text.isEmpty else { return }
        
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
