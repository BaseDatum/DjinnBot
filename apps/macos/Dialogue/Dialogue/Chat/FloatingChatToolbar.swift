import SwiftUI

/// The floating chat toolbar that warps up from the bottom edge of the window.
/// - Collapsed: thin 48px bar with placeholder text, new session button, session switcher
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
    
    /// Track panel height for drag resizing.
    @State private var panelHeight: CGFloat = 400
    
    /// Minimum expanded panel height.
    private let minPanelHeight: CGFloat = 200
    
    /// Maximum expanded panel height ratio (relative to container).
    private let maxPanelRatio: CGFloat = 0.85
    
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
                            // Collapsed toolbar bar
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
        HStack(spacing: 12) {
            // Text field placeholder / input
            HStack(spacing: 8) {
                Image(systemName: "sparkles")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                
                TextField("Ask Dialogue AI...", text: $collapsedInput, onCommit: {
                    if !collapsedInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        expandAndSend()
                    }
                })
                .textFieldStyle(.plain)
                .font(.subheadline)
                .onTapGesture {
                    expand()
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
            
            // New session button
            Button {
                chatManager.createNewSession()
                expand()
            } label: {
                Image(systemName: "plus.circle")
                    .font(.body)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.borderless)
            .help("New Chat Session")
        }
        .padding(.horizontal, 16)
        .frame(height: 48)
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
        }
    }
    
    private func expandAndSend() {
        let text = collapsedInput
        collapsedInput = ""
        expand()
        
        // Auto-create session if needed
        if chatManager.activeSession == nil {
            chatManager.createNewSession()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                chatManager.sendMessage(text)
            }
        } else {
            chatManager.sendMessage(text)
        }
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
