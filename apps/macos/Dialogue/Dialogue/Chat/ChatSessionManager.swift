import Foundation
import Combine

/// Manages chat sessions locally: create, switch, send messages, handle SSE events.
/// This is the central coordinator between the UI and the StreamingChatService.
@MainActor
final class ChatSessionManager: ObservableObject {
    static let shared = ChatSessionManager()
    
    // MARK: - Published State
    
    /// All local sessions (most recent first).
    @Published var sessions: [ChatSession] = []
    
    /// The currently active session.
    @Published var activeSession: ChatSession?
    
    /// Global error message (shown briefly, then cleared).
    @Published var errorMessage: String?
    
    /// Whether we're currently creating/starting a new session.
    @Published var isStartingSession: Bool = false
    
    // MARK: - Configuration
    
    /// Default agent ID — stored in UserDefaults, configurable in Settings.
    var defaultAgentId: String {
        get { UserDefaults.standard.string(forKey: "chatAgentId") ?? "chieko" }
        set { UserDefaults.standard.set(newValue, forKey: "chatAgentId") }
    }
    
    /// Available models for the model picker.
    let availableModels: [String] = [
        "anthropic/claude-sonnet-4",
        "anthropic/claude-opus-4",
        "openrouter/moonshotai/kimi-k2.5",
        "openrouter/google/gemini-2.5-pro",
        "openrouter/openai/gpt-4o",
    ]
    
    private let service = StreamingChatService.shared
    private var sseTask: Task<Void, Never>?
    private var statusPollTask: Task<Void, Never>?
    
    private init() {}
    
    // MARK: - Session Lifecycle
    
    /// Create a new chat session with the Djinn backend.
    func createNewSession(model: String? = nil) {
        guard !isStartingSession else { return }
        guard KeychainManager.shared.hasAPIKey else {
            errorMessage = "No API key configured. Open Settings to add one."
            return
        }
        
        isStartingSession = true
        errorMessage = nil
        
        Task {
            do {
                let response = try await service.startSession(
                    agentId: defaultAgentId,
                    model: model ?? availableModels.first
                )
                
                let session = ChatSession(
                    id: response.sessionId,
                    agentId: defaultAgentId,
                    title: "Chat \(sessions.count + 1)",
                    model: model ?? availableModels.first ?? "anthropic/claude-sonnet-4",
                    status: SessionStatus(rawValue: response.status) ?? .starting
                )
                
                sessions.insert(session, at: 0)
                activeSession = session
                isStartingSession = false
                
                // Start polling for session to become ready, then connect SSE
                startStatusPolling(for: session)
                
            } catch {
                isStartingSession = false
                errorMessage = "Failed to start session: \(error.localizedDescription)"
                print("[Chat] Start session error: \(error)")
            }
        }
    }
    
    /// Switch to an existing session.
    func switchToSession(_ session: ChatSession) {
        guard session.id != activeSession?.id else { return }
        
        // Disconnect SSE from old session
        disconnectSSE()
        
        activeSession = session
        
        // Reconnect SSE for the new session
        if session.status.isActive {
            connectSSE(for: session)
        }
    }
    
    /// Send a user message in the active session.
    func sendMessage(_ text: String) {
        guard let session = activeSession else {
            errorMessage = "No active session"
            return
        }
        
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        
        // Add user message locally
        let userMsg = ChatMessage(role: .user, content: trimmed)
        session.messages.append(userMsg)
        session.isGenerating = true
        
        // Add a placeholder streaming assistant message
        let assistantMsg = ChatMessage(role: .assistant, content: "", isStreaming: true)
        session.messages.append(assistantMsg)
        
        Task {
            do {
                // If session is not active, try to restart it
                if !session.status.isActive {
                    let restartResponse = try await service.restartSession(
                        agentId: session.agentId,
                        sessionId: session.id
                    )
                    session.status = SessionStatus(rawValue: restartResponse.status) ?? .starting
                    startStatusPolling(for: session)
                    // Wait a moment for session to start
                    try await Task.sleep(nanoseconds: 1_000_000_000)
                }
                
                let response = try await service.sendMessage(
                    agentId: session.agentId,
                    sessionId: session.id,
                    message: trimmed
                )
                
                session.pendingAssistantMessageId = response.assistantMessageId
                
                // Ensure SSE is connected for streaming response
                if sseTask == nil {
                    connectSSE(for: session)
                }
                
            } catch {
                session.isGenerating = false
                assistantMsg.isStreaming = false
                assistantMsg.content = ""
                
                // Add error message
                let errorMsg = ChatMessage(role: .error, content: error.localizedDescription)
                session.messages.append(errorMsg)
                
                // Remove empty assistant placeholder
                if assistantMsg.content.isEmpty {
                    session.messages.removeAll { $0.id == assistantMsg.id }
                }
                
                print("[Chat] Send message error: \(error)")
            }
        }
    }
    
    /// Stop the current response generation.
    func stopResponse() {
        guard let session = activeSession else { return }
        
        Task {
            do {
                try await service.stopResponse(
                    agentId: session.agentId,
                    sessionId: session.id
                )
            } catch {
                print("[Chat] Stop response error: \(error)")
            }
        }
        
        // Immediately update local state
        session.isGenerating = false
        if let lastAssistant = session.messages.last(where: { $0.role == .assistant }) {
            lastAssistant.isStreaming = false
        }
    }
    
    /// Change the model for the active session.
    func updateModel(_ model: String) {
        guard let session = activeSession else { return }
        session.model = model
        
        Task {
            do {
                try await service.updateModel(
                    agentId: session.agentId,
                    sessionId: session.id,
                    model: model
                )
            } catch {
                print("[Chat] Update model error: \(error)")
            }
        }
    }
    
    // MARK: - SSE Connection
    
    private func connectSSE(for session: ChatSession) {
        disconnectSSE()
        
        sseTask = Task {
            let stream = service.connectSSE(sessionId: session.id)
            
            for await event in stream {
                guard !Task.isCancelled else { break }
                await handleSSEEvent(event, session: session)
            }
        }
    }
    
    private func disconnectSSE() {
        sseTask?.cancel()
        sseTask = nil
        service.disconnectSSE()
    }
    
    /// Handle a single SSE event, updating the session/message state.
    private func handleSSEEvent(_ event: DjinnSSEEvent, session: ChatSession) async {
        switch event {
        case .connected:
            print("[Chat] SSE connected for session \(session.id)")
            
        case .textDelta(let text):
            appendToStreamingMessage(text, in: session)
            
        case .thinkingDelta(let text):
            appendThinking(text, in: session)
            
        case .toolStart(let toolName, let toolCallId):
            let toolMsg = ChatMessage(
                id: toolCallId ?? UUID().uuidString,
                role: .toolCall,
                content: "",
                toolName: toolName,
                toolStatus: .running
            )
            session.messages.append(toolMsg)
            
        case .toolEnd(let toolCallId, let result):
            if let toolCallId = toolCallId,
               let toolMsg = session.messages.first(where: { $0.id == toolCallId }) {
                toolMsg.toolStatus = .completed
                toolMsg.toolResult = result
            } else if let lastTool = session.messages.last(where: { $0.role == .toolCall && $0.toolStatus == .running }) {
                lastTool.toolStatus = .completed
                lastTool.toolResult = result
            }
            
        case .turnEnd:
            finalizeStreaming(in: session)
            
        case .responseAborted:
            finalizeStreaming(in: session)
            
        case .sessionComplete:
            session.status = .completed
            finalizeStreaming(in: session)
            
        case .statusChanged(let newStatus):
            if let status = SessionStatus(rawValue: newStatus) {
                session.status = status
            }
            
        case .heartbeat:
            break // No-op
            
        case .error(let message):
            let errorMsg = ChatMessage(role: .error, content: message)
            session.messages.append(errorMsg)
            finalizeStreaming(in: session)
            
        case .unknown(let type, _):
            print("[Chat] Unknown SSE event type: \(type)")
        }
    }
    
    /// Append streaming text to the last assistant message.
    private func appendToStreamingMessage(_ text: String, in session: ChatSession) {
        if let msg = session.messages.last(where: { $0.role == .assistant && $0.isStreaming }) {
            msg.content += text
        }
    }
    
    /// Append thinking text to the last assistant message.
    private func appendThinking(_ text: String, in session: ChatSession) {
        // Find or create a thinking message before the current streaming assistant message
        if let msg = session.messages.last(where: { $0.role == .assistant && $0.isStreaming }) {
            msg.thinkingContent = (msg.thinkingContent ?? "") + text
        }
    }
    
    /// Mark streaming as complete.
    private func finalizeStreaming(in session: ChatSession) {
        session.isGenerating = false
        for msg in session.messages where msg.isStreaming {
            msg.isStreaming = false
        }
    }
    
    // MARK: - Status Polling
    
    /// Poll session status until it's running, then connect SSE.
    private func startStatusPolling(for session: ChatSession) {
        statusPollTask?.cancel()
        statusPollTask = Task {
            var attempts = 0
            let maxAttempts = 30 // 30 seconds max wait
            
            while !Task.isCancelled && attempts < maxAttempts {
                attempts += 1
                try? await Task.sleep(nanoseconds: 1_000_000_000) // 1 second
                
                do {
                    let status = try await service.getSessionStatus(
                        agentId: session.agentId,
                        sessionId: session.id
                    )
                    
                    if let newStatus = SessionStatus(rawValue: status.status) {
                        session.status = newStatus
                    }
                    
                    if status.status == "running" || status.status == "ready" {
                        // Session is ready — connect SSE
                        connectSSE(for: session)
                        return
                    }
                    
                    if status.status == "failed" {
                        errorMessage = "Session failed to start"
                        return
                    }
                } catch {
                    print("[Chat] Status poll error: \(error)")
                }
            }
            
            if attempts >= maxAttempts {
                errorMessage = "Session startup timed out"
                session.status = .failed
            }
        }
    }
    
    // MARK: - Cleanup
    
    func cleanup() {
        disconnectSSE()
        statusPollTask?.cancel()
        statusPollTask = nil
    }
}
