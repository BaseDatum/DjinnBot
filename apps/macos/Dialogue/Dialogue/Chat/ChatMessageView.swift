import SwiftUI

/// Renders a single chat message with role-appropriate styling.
struct ChatMessageView: View {
    @ObservedObject var message: ChatMessage
    
    var body: some View {
        switch message.role {
        case .user:
            userBubble
        case .assistant:
            assistantBubble
        case .thinking:
            thinkingIndicator
        case .toolCall:
            toolCallCard
        case .error:
            errorBanner
        }
    }
    
    // MARK: - User Message
    
    private var userBubble: some View {
        HStack {
            Spacer(minLength: 60)
            Text(message.content)
                .font(.body)
                .foregroundStyle(.white)
                .padding(.horizontal, 14)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .fill(Color.accentColor)
                )
                .textSelection(.enabled)
        }
        .padding(.trailing, 4)
    }
    
    // MARK: - Assistant Message
    
    private var assistantBubble: some View {
        HStack(alignment: .top) {
            VStack(alignment: .leading, spacing: 6) {
                // Show thinking content if present (collapsible)
                if let thinking = message.thinkingContent, !thinking.isEmpty {
                    ThinkingDisclosure(content: thinking)
                }
                
                if !message.content.isEmpty {
                    Text(message.content)
                        .font(.body)
                        .textSelection(.enabled)
                }
                
                // Streaming indicator
                if message.isStreaming {
                    StreamingDotsView()
                        .padding(.top, 2)
                }
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(Color(.controlBackgroundColor))
            )
            
            Spacer(minLength: 60)
        }
        .padding(.leading, 4)
    }
    
    // MARK: - Thinking Indicator
    
    /// Shows a collapsible thinking block with the actual reasoning content.
    /// Falls back to a simple "thinking..." pulse when no content is available yet.
    private var thinkingIndicator: some View {
        HStack(alignment: .top) {
            if message.content.isEmpty {
                // No thinking text yet — show pulse indicator
                HStack(spacing: 8) {
                    ThinkingPulseView()
                    Text("Thinking...")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer()
                }
            } else {
                // Show actual thinking content in a collapsible disclosure
                ThinkingDisclosure(content: message.content)
            }
            
            Spacer(minLength: 40)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
    }
    
    // MARK: - Tool Call Card
    
    private var toolCallCard: some View {
        HStack(alignment: .top) {
            DisclosureGroup {
                if let result = message.toolResult {
                    Text(result)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .padding(.top, 4)
                }
            } label: {
                HStack(spacing: 8) {
                    // Status icon
                    switch message.toolStatus {
                    case .idle, .running:
                        ProgressView()
                            .controlSize(.small)
                    case .completed:
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.caption)
                    case .failed:
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }
                    
                    Text("Tool: \(message.toolName ?? "unknown")")
                        .font(.caption)
                        .fontWeight(.medium)
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(Color(.windowBackgroundColor).opacity(0.6))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .strokeBorder(Color(.separatorColor), lineWidth: 0.5)
                    )
            )
            
            Spacer(minLength: 40)
        }
        .padding(.leading, 4)
    }
    
    // MARK: - Error Banner
    
    private var errorBanner: some View {
        HStack(spacing: 8) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.red)
            
            Text(message.content)
                .font(.caption)
                .foregroundStyle(.red)
            
            Spacer()
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.red.opacity(0.1))
        )
    }
}

// MARK: - Streaming Dots Animation

/// Three animated dots shown while waiting for/streaming assistant response.
struct StreamingDotsView: View {
    @State private var activeDot = 0
    
    let timer = Timer.publish(every: 0.4, on: .main, in: .common).autoconnect()
    
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { index in
                Circle()
                    .fill(Color.secondary)
                    .frame(width: 5, height: 5)
                    .opacity(activeDot == index ? 1.0 : 0.3)
            }
        }
        .onReceive(timer) { _ in
            activeDot = (activeDot + 1) % 3
        }
    }
}

// MARK: - Thinking Pulse Animation

/// A subtle pulsing circle for the "Dialogue is thinking" state.
struct ThinkingPulseView: View {
    @State private var isPulsing = false
    
    var body: some View {
        Circle()
            .fill(Color.secondary.opacity(0.6))
            .frame(width: 8, height: 8)
            .scaleEffect(isPulsing ? 1.3 : 0.8)
            .opacity(isPulsing ? 0.4 : 1.0)
            .animation(
                .easeInOut(duration: 0.8)
                .repeatForever(autoreverses: true),
                value: isPulsing
            )
            .onAppear { isPulsing = true }
    }
}

// MARK: - Thinking Disclosure

/// Collapsible thinking content block.
struct ThinkingDisclosure: View {
    let content: String
    @State private var isExpanded = false
    
    var body: some View {
        DisclosureGroup(isExpanded: $isExpanded) {
            Text(content)
                .font(.caption)
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
                .padding(.top, 4)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: "brain")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                Text("Thinking")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.bottom, 4)
    }
}
