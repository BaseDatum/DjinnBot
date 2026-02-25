import SwiftUI

/// The expanded chat panel showing the full conversation, input field, and header.
/// This is the main view inside the floating toolbar when expanded.
struct ChatPanelView: View {
    @ObservedObject var manager: ChatSessionManager
    @Binding var isExpanded: Bool
    @State private var inputText: String = ""
    @FocusState private var isInputFocused: Bool
    
    var body: some View {
        VStack(spacing: 0) {
            // Header
            chatHeader
            
            Divider()
            
            // Messages
            if let session = manager.activeSession {
                messageList(session: session)
            } else {
                emptyState
            }
            
            Divider()
            
            // Input area
            inputArea
        }
        .background(.ultraThinMaterial)
    }
    
    // MARK: - Header
    
    private var chatHeader: some View {
        HStack(spacing: 12) {
            // Session switcher
            if let session = manager.activeSession {
                Menu {
                    ForEach(manager.sessions) { s in
                        Button(s.title) {
                            manager.switchToSession(s)
                        }
                    }
                    
                    Divider()
                    
                    Button("New Chat") {
                        manager.createNewSession()
                    }
                } label: {
                    HStack(spacing: 4) {
                        Text(session.title)
                            .font(.subheadline)
                            .fontWeight(.medium)
                        Image(systemName: "chevron.down")
                            .font(.caption2)
                    }
                }
                .menuStyle(.borderlessButton)
                .fixedSize()
                
                // Status badge
                sessionStatusBadge(session.status)
            } else {
                Text("Dialogue AI")
                    .font(.subheadline)
                    .fontWeight(.medium)
            }
            
            Spacer()
            
            // Model picker
            if let session = manager.activeSession {
                modelPicker(session: session)
            }
            
            // New session button
            Button {
                manager.createNewSession()
            } label: {
                Image(systemName: "plus")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
            .disabled(manager.isStartingSession)
            
            // Close button
            Button {
                withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                    isExpanded = false
                }
            } label: {
                Image(systemName: "chevron.down")
                    .font(.caption)
            }
            .buttonStyle(.borderless)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }
    
    // MARK: - Model Picker
    
    private func modelPicker(session: ChatSession) -> some View {
        Menu {
            if manager.providers.isEmpty {
                Button("Loading providers...") {}
                    .disabled(true)
            } else {
                ForEach(manager.providers) { provider in
                    Menu(provider.name) {
                        if let models = manager.providerModels[provider.providerId] {
                            ForEach(models) { model in
                                Button {
                                    manager.updateModel(model.id)
                                } label: {
                                    HStack {
                                        Text(model.name)
                                        if model.id == session.model {
                                            Image(systemName: "checkmark")
                                        }
                                    }
                                }
                            }
                        } else {
                            Button("Loading...") {}
                                .disabled(true)
                        }
                    }
                }
            }
            
            Divider()
            
            // Show current model as label
            Button("Current: \(displayModelName(session.model))") {}
                .disabled(true)
        } label: {
            HStack(spacing: 3) {
                Image(systemName: "cpu")
                    .font(.caption2)
                Text(displayModelName(session.model))
                    .font(.caption2)
            }
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: 6, style: .continuous)
                    .fill(Color(.controlBackgroundColor))
            )
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .onAppear {
            // Load providers when the picker appears
            if manager.providers.isEmpty {
                manager.loadProviders()
            }
        }
        .onChange(of: manager.providers) { _, providers in
            // Auto-load models for each configured provider
            for provider in providers {
                manager.loadModelsForProvider(provider.providerId)
            }
        }
    }
    
    // MARK: - Message List
    
    private func messageList(session: ChatSession) -> some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(session.messages) { message in
                        ChatMessageView(message: message)
                            .id(message.id)
                    }
                    
                    // Streaming indicator when generating but no assistant message exists yet.
                    // This covers the gap between sending a message and the first token arriving.
                    if session.isGenerating,
                       !session.messages.contains(where: { ($0.role == .assistant && $0.isStreaming) || $0.role == .thinking }) {
                        HStack(spacing: 8) {
                            StreamingDotsView()
                            Text("Waiting for response...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 8)
                        .id("streaming-indicator")
                    }
                    
                    // Error message from manager
                    if let error = manager.errorMessage {
                        HStack(spacing: 8) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(.orange)
                            Text(error)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                        }
                        .padding(.horizontal, 14)
                        .padding(.vertical, 6)
                    }
                    
                    // Bottom spacer for scroll anchor
                    Color.clear
                        .frame(height: 1)
                        .id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
            }
            .onChange(of: session.messages.count) { _, _ in
                withAnimation(.easeOut(duration: 0.2)) {
                    proxy.scrollTo("bottom", anchor: .bottom)
                }
            }
            // Also scroll when streaming content updates
            .onChange(of: session.messages.last?.content ?? "") { _, _ in
                proxy.scrollTo("bottom", anchor: .bottom)
            }
        }
    }
    
    // MARK: - Empty State
    
    private var emptyState: some View {
        VStack(spacing: 16) {
            Spacer()
            
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 32))
                .foregroundStyle(.tertiary)
            
            Text("Start a conversation")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            
            if !KeychainManager.shared.hasAPIKey {
                Text("Set your API key in Settings first")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            } else {
                Button("New Chat") {
                    manager.createNewSession()
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
            
            Spacer()
        }
    }
    
    // MARK: - Input Area
    
    private var inputArea: some View {
        HStack(alignment: .bottom, spacing: 8) {
            // Multi-line text input
            TextEditor(text: $inputText)
                .font(.body)
                .scrollContentBackground(.hidden)
                .frame(minHeight: 24, maxHeight: 120)
                .fixedSize(horizontal: false, vertical: true)
                .focused($isInputFocused)
                .onSubmit {
                    // Cmd+Enter handled via keyboard shortcut
                }
            
            VStack(spacing: 4) {
                if manager.activeSession?.isGenerating == true {
                    // Stop button
                    Button {
                        manager.stopResponse()
                    } label: {
                        Image(systemName: "stop.circle.fill")
                            .font(.title3)
                            .foregroundStyle(.red)
                    }
                    .buttonStyle(.borderless)
                    .help("Stop generating")
                } else {
                    // Send button
                    Button {
                        send()
                    } label: {
                        Image(systemName: "arrow.up.circle.fill")
                            .font(.title3)
                            .foregroundStyle(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Color.secondary : Color.accentColor)
                    }
                    .buttonStyle(.borderless)
                    .disabled(inputText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .keyboardShortcut(.return, modifiers: .command)
                    .help("Send (Cmd+Return)")
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .onAppear {
            isInputFocused = true
        }
    }
    
    // MARK: - Helpers
    
    private func send() {
        let text = inputText
        inputText = ""
        sendText(text)
    }
    
    /// Send a text message using the reliable queued-send path.
    private func sendText(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        manager.sendMessageWhenReady(trimmed)
    }
    
    private func displayModelName(_ model: String) -> String {
        // "anthropic/claude-sonnet-4" -> "Claude Sonnet 4"
        let parts = model.split(separator: "/")
        let name = parts.last.map(String.init) ?? model
        return name
            .replacingOccurrences(of: "-", with: " ")
            .split(separator: " ")
            .map { $0.prefix(1).uppercased() + $0.dropFirst() }
            .joined(separator: " ")
    }
    
    private func sessionStatusBadge(_ status: SessionStatus) -> some View {
        HStack(spacing: 3) {
            Circle()
                .fill(statusColor(status))
                .frame(width: 6, height: 6)
            
            Text(status.rawValue)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
    
    private func statusColor(_ status: SessionStatus) -> Color {
        switch status {
        case .starting:
            return .orange
        case .running, .ready:
            return .green
        case .completed:
            return .blue
        case .failed:
            return .red
        case .idle:
            return .gray
        }
    }
}
