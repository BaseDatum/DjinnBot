import Foundation

// MARK: - Chat Message

/// A single message in a chat conversation.
/// Supports user, assistant, thinking, tool call, and error message types.
final class ChatMessage: ObservableObject, Identifiable {
    let id: String
    let role: MessageRole
    let createdAt: Date
    
    /// The text content — mutated during streaming for assistant messages.
    @Published var content: String
    
    /// Whether the assistant is still streaming this message.
    @Published var isStreaming: Bool
    
    /// Tool call metadata (only for .toolCall role).
    @Published var toolName: String?
    @Published var toolStatus: ToolCallStatus
    @Published var toolResult: String?
    
    /// Thinking content (for extended thinking / reasoning tokens).
    @Published var thinkingContent: String?
    
    /// Error message (only for .error role).
    var errorMessage: String? {
        role == .error ? content : nil
    }
    
    init(
        id: String = UUID().uuidString,
        role: MessageRole,
        content: String = "",
        isStreaming: Bool = false,
        toolName: String? = nil,
        toolStatus: ToolCallStatus = .idle,
        toolResult: String? = nil,
        thinkingContent: String? = nil,
        createdAt: Date = Date()
    ) {
        self.id = id
        self.role = role
        self.content = content
        self.isStreaming = isStreaming
        self.toolName = toolName
        self.toolStatus = toolStatus
        self.toolResult = toolResult
        self.thinkingContent = thinkingContent
        self.createdAt = createdAt
    }
}

// MARK: - Message Role

enum MessageRole: String, Codable {
    case user
    case assistant
    case thinking
    case toolCall = "tool_call"
    case error
}

// MARK: - Tool Call Status

enum ToolCallStatus: String {
    case idle
    case running
    case completed
    case failed
}

// MARK: - Chat Session

/// A local chat session, tracking conversation state and backend session ID.
final class ChatSession: ObservableObject, Identifiable {
    let id: String
    let agentId: String
    let createdAt: Date
    
    @Published var title: String
    @Published var model: String
    @Published var status: SessionStatus
    @Published var messages: [ChatMessage]
    
    /// Whether the assistant is currently generating a response.
    @Published var isGenerating: Bool = false
    
    /// The assistant message ID returned by the backend (for completion tracking).
    var pendingAssistantMessageId: String?
    
    init(
        id: String,
        agentId: String,
        title: String = "New Chat",
        model: String = "anthropic/claude-sonnet-4",
        status: SessionStatus = .starting,
        messages: [ChatMessage] = [],
        createdAt: Date = Date()
    ) {
        self.id = id
        self.agentId = agentId
        self.title = title
        self.model = model
        self.status = status
        self.messages = messages
        self.createdAt = createdAt
    }
}

// MARK: - Session Status

enum SessionStatus: String, Codable {
    case starting
    case running
    case ready
    case completed
    case failed
    case idle
    
    var isActive: Bool {
        switch self {
        case .starting, .running, .ready:
            return true
        default:
            return false
        }
    }
}

// MARK: - SSE Event Types

/// Parsed SSE event from the Djinn backend session stream.
enum DjinnSSEEvent {
    case connected(sessionId: String)
    case textDelta(text: String)
    case thinkingDelta(text: String)
    case toolStart(toolName: String, toolCallId: String?)
    case toolEnd(toolCallId: String?, result: String?)
    case stepEnd(result: String?, success: Bool)
    case turnEnd
    case responseAborted
    case sessionComplete
    case statusChanged(newStatus: String)
    case heartbeat
    case error(message: String)
    case unknown(type: String, data: [String: Any])
    
    /// Parse a raw SSE JSON data payload into a typed event.
    static func parse(from jsonString: String) -> DjinnSSEEvent? {
        guard let data = jsonString.data(using: .utf8),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = json["type"] as? String else {
            return nil
        }
        
        let eventData = json["data"] as? [String: Any] ?? [:]
        
        switch type {
        case "connected":
            let sessionId = json["session_id"] as? String ?? ""
            return .connected(sessionId: sessionId)
            
        case "text_delta", "delta", "output":
            // The engine sends "output" events with data.content or data.stream
            if let text = eventData["content"] as? String ?? eventData["stream"] as? String ?? eventData["text"] as? String ?? json["text"] as? String {
                return .textDelta(text: text)
            }
            // Fallback: check top-level content field
            if let content = json["content"] as? String {
                return .textDelta(text: content)
            }
            return nil
            
        case "thinking_delta", "thinking":
            // The engine sends "thinking" events with data.thinking or data.text
            if let text = eventData["thinking"] as? String ?? eventData["text"] as? String ?? json["thinking"] as? String {
                return .thinkingDelta(text: text)
            }
            return nil
            
        case "tool_start":
            let name = eventData["name"] as? String ?? eventData["tool_name"] as? String ?? "unknown"
            let callId = eventData["tool_call_id"] as? String ?? eventData["id"] as? String
            return .toolStart(toolName: name, toolCallId: callId)
            
        case "tool_end", "tool_result":
            let callId = eventData["tool_call_id"] as? String ?? eventData["id"] as? String
            let result = eventData["result"] as? String ?? eventData["output"] as? String
            return .toolEnd(toolCallId: callId, result: result)
            
        case "step_end":
            let result = eventData["result"] as? String
            let success = eventData["success"] as? Bool ?? true
            return .stepEnd(result: result, success: success)
            
        case "turn_end", "completed":
            return .turnEnd
            
        case "response_aborted":
            return .responseAborted
            
        case "session_complete":
            return .sessionComplete
            
        case "status_changed":
            let newStatus = eventData["newStatus"] as? String ?? json["status"] as? String ?? ""
            return .statusChanged(newStatus: newStatus)
            
        case "heartbeat", "ping":
            return .heartbeat
            
        case "error":
            let msg = eventData["message"] as? String ?? json["error"] as? String ?? "Unknown error"
            return .error(message: msg)
            
        default:
            return .unknown(type: type, data: eventData)
        }
    }
}

// MARK: - API Response Models

/// Response from POST /v1/agents/{agent_id}/chat/start
struct StartChatResponse: Codable {
    let sessionId: String
    let status: String
    let message: String?
}

/// Response from POST /v1/agents/{agent_id}/chat/{session_id}/message
struct SendMessageResponse: Codable {
    let status: String
    let sessionId: String
    let userMessageId: String?
    let assistantMessageId: String?
}

/// Response from GET /v1/agents/{agent_id}/chat/{session_id}/status
struct SessionStatusResponse: Codable {
    let sessionId: String
    let status: String
    let exists: Bool?
    let messageCount: Int?
    let model: String?
    let containerId: String?
    let createdAt: Int?
    let lastActivityAt: Int?
}

/// Response from GET /v1/agents/{agent_id}/chat/sessions
struct ChatSessionListResponse: Codable {
    let sessions: [ChatSessionInfo]
    let total: Int
    let has_more: Bool
}

struct ChatSessionInfo: Codable {
    let id: String
    let agent_id: String
    let status: String
    let model: String
    let created_at: Int
    let last_activity_at: Int
    let message_count: Int?
}

// MARK: - Model Provider Types

/// A configured model provider from GET /v1/settings/providers
struct ModelProvider: Codable, Identifiable, Equatable {
    let providerId: String
    let name: String
    let description: String
    let configured: Bool
    let enabled: Bool
    let models: [ProviderModel]
    
    var id: String { providerId }
}

/// A model available from a provider
struct ProviderModel: Codable, Identifiable, Equatable {
    let id: String
    let name: String
    let description: String?
    let reasoning: Bool?
}

/// Response from GET /v1/settings/providers/{providerId}/models
struct ProviderModelsResponse: Codable {
    let models: [ProviderModel]
    let source: String // "live" or "static"
}
