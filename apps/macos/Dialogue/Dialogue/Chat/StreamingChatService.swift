import Foundation

/// Handles all communication with the Djinn backend for chat:
/// - Starting sessions
/// - Sending messages
/// - SSE streaming (session events)
/// - Model updates
/// - Session status polling
///
/// Uses the same API key stored in KeychainManager (shared with BlockNote AI).
final class StreamingChatService: @unchecked Sendable {
    static let shared = StreamingChatService()
    
    /// Base URL for the Djinn API (stored in UserDefaults, configurable in Settings).
    /// Should be set to the server base ending in /v1, e.g. "https://your-server.example.com/v1".
    var baseURL: String {
        let stored = UserDefaults.standard.string(forKey: "aiEndpoint") ?? "https://localhost:8000/v1"
        // Strip any trailing slash for consistent URL construction
        return stored.hasSuffix("/") ? String(stored.dropLast()) : stored
    }
    
    private let session: URLSession
    private var activeSSETask: URLSessionDataTask?
    private var sseDelegate: SSEStreamDelegate?
    
    private init() {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = 300 // 5 min for long streams
        config.timeoutIntervalForResource = 600
        self.session = URLSession(configuration: config)
    }
    
    // MARK: - API Key
    
    private func apiKey() -> String? {
        try? KeychainManager.shared.getAPIKey()
    }
    
    private func authHeaders() -> [String: String] {
        var headers: [String: String] = [
            "Content-Type": "application/json",
            "Accept": "application/json",
        ]
        if let key = apiKey() {
            headers["Authorization"] = "Bearer \(key)"
        }
        return headers
    }
    
    // MARK: - Start Chat Session
    
    /// POST /v1/agents/{agent_id}/chat/start
    func startSession(
        agentId: String,
        model: String? = nil,
        thinkingLevel: String? = nil
    ) async throws -> StartChatResponse {
        let url = URL(string: "\(baseURL)/agents/\(agentId)/chat/start")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        var body: [String: Any] = [:]
        if let model = model { body["model"] = model }
        if let thinkingLevel = thinkingLevel { body["thinking_level"] = thinkingLevel }
        
        if !body.isEmpty {
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
        return try JSONDecoder().decode(StartChatResponse.self, from: data)
    }
    
    // MARK: - Send Message
    
    /// POST /v1/agents/{agent_id}/chat/{session_id}/message
    func sendMessage(
        agentId: String,
        sessionId: String,
        message: String,
        model: String? = nil
    ) async throws -> SendMessageResponse {
        let url = URL(string: "\(baseURL)/agents/\(agentId)/chat/\(sessionId)/message")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        var body: [String: Any] = ["message": message]
        if let model = model { body["model"] = model }
        
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
        return try JSONDecoder().decode(SendMessageResponse.self, from: data)
    }
    
    // MARK: - Stop Response
    
    /// POST /v1/agents/{agent_id}/chat/{session_id}/stop
    func stopResponse(agentId: String, sessionId: String) async throws {
        let url = URL(string: "\(baseURL)/agents/\(agentId)/chat/\(sessionId)/stop")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
    }
    
    // MARK: - Session Status
    
    /// GET /v1/agents/{agent_id}/chat/{session_id}/status
    func getSessionStatus(agentId: String, sessionId: String) async throws -> SessionStatusResponse {
        let url = URL(string: "\(baseURL)/agents/\(agentId)/chat/\(sessionId)/status")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
        return try JSONDecoder().decode(SessionStatusResponse.self, from: data)
    }
    
    // MARK: - List Sessions
    
    /// GET /v1/agents/{agent_id}/chat/sessions
    func listSessions(agentId: String, limit: Int = 20) async throws -> ChatSessionListResponse {
        var components = URLComponents(string: "\(baseURL)/agents/\(agentId)/chat/sessions")!
        components.queryItems = [URLQueryItem(name: "limit", value: "\(limit)")]
        
        var request = URLRequest(url: components.url!)
        request.httpMethod = "GET"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
        return try JSONDecoder().decode(ChatSessionListResponse.self, from: data)
    }
    
    // MARK: - Update Model
    
    /// PATCH /v1/agents/{agent_id}/chat/{session_id}/model?model=...
    func updateModel(agentId: String, sessionId: String, model: String) async throws {
        var components = URLComponents(string: "\(baseURL)/agents/\(agentId)/chat/\(sessionId)/model")!
        components.queryItems = [URLQueryItem(name: "model", value: model)]
        
        var request = URLRequest(url: components.url!)
        request.httpMethod = "PATCH"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
    }
    
    // MARK: - Restart Session
    
    /// POST /v1/agents/{agent_id}/chat/{session_id}/restart
    func restartSession(agentId: String, sessionId: String) async throws -> StartChatResponse {
        let url = URL(string: "\(baseURL)/agents/\(agentId)/chat/\(sessionId)/restart")!
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
        return try JSONDecoder().decode(StartChatResponse.self, from: data)
    }
    
    // MARK: - Model Providers
    
    /// GET /v1/settings/providers — fetch all configured model providers
    func fetchModelProviders() async throws -> [ModelProvider] {
        let url = URL(string: "\(baseURL)/settings/providers")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
        return try JSONDecoder().decode([ModelProvider].self, from: data)
    }
    
    /// GET /v1/settings/providers/{providerId}/models — fetch models for a specific provider
    func fetchProviderModels(providerId: String) async throws -> [ProviderModel] {
        let url = URL(string: "\(baseURL)/settings/providers/\(providerId)/models")!
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        authHeaders().forEach { request.setValue($1, forHTTPHeaderField: $0) }
        
        let (data, response) = try await session.data(for: request)
        try validateHTTPResponse(response, data: data)
        let result = try JSONDecoder().decode(ProviderModelsResponse.self, from: data)
        return result.models
    }
    
    // MARK: - SSE Event Stream
    
    /// Connect to the session SSE stream and call the handler for each event.
    /// Returns an AsyncStream of parsed SSE events.
    ///
    /// GET /v1/events/sessions/{session_id}/events
    func connectSSE(sessionId: String) -> AsyncStream<DjinnSSEEvent> {
        AsyncStream { continuation in
            let urlString = "\(baseURL)/events/sessions/\(sessionId)/events"
            guard let url = URL(string: urlString) else {
                continuation.yield(.error(message: "Invalid SSE URL: \(urlString)"))
                continuation.finish()
                return
            }
            
            var request = URLRequest(url: url)
            request.httpMethod = "GET"
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            request.setValue("no-cache", forHTTPHeaderField: "Cache-Control")
            // Auth via query param for SSE (some proxies strip headers on streaming)
            if let key = self.apiKey() {
                request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
            }
            request.timeoutInterval = 0 // No timeout for SSE
            
            let delegate = SSEStreamDelegate { event in
                continuation.yield(event)
            }
            
            let sseSession = URLSession(
                configuration: .default,
                delegate: delegate,
                delegateQueue: nil
            )
            
            let task = sseSession.dataTask(with: request)
            
            self.sseDelegate = delegate
            self.activeSSETask = task
            
            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
            
            task.resume()
        }
    }
    
    /// Disconnect the active SSE stream.
    func disconnectSSE() {
        activeSSETask?.cancel()
        activeSSETask = nil
        sseDelegate = nil
    }
    
    // MARK: - Helpers
    
    private func validateHTTPResponse(_ response: URLResponse, data: Data) throws {
        guard let http = response as? HTTPURLResponse else {
            throw ChatServiceError.invalidResponse
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? ""
            throw ChatServiceError.httpError(statusCode: http.statusCode, body: body)
        }
    }
}

// MARK: - SSE Stream Delegate

/// URLSession delegate that parses raw SSE bytes into DjinnSSEEvent values.
private final class SSEStreamDelegate: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let onEvent: (DjinnSSEEvent) -> Void
    private var buffer = ""
    
    init(onEvent: @escaping (DjinnSSEEvent) -> Void) {
        self.onEvent = onEvent
    }
    
    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let text = String(data: data, encoding: .utf8) else { return }
        buffer += text
        
        // SSE messages are separated by double newlines
        while let range = buffer.range(of: "\n\n") {
            let message = String(buffer[buffer.startIndex..<range.lowerBound])
            buffer = String(buffer[range.upperBound...])
            processSSEMessage(message)
        }
    }
    
    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error = error {
            // Don't report cancellation as an error
            if (error as NSError).code == NSURLErrorCancelled { return }
            onEvent(.error(message: "SSE connection lost: \(error.localizedDescription)"))
        }
    }
    
    private func processSSEMessage(_ message: String) {
        var eventType = "message"
        var dataLines: [String] = []
        
        for line in message.components(separatedBy: "\n") {
            if line.hasPrefix("event:") {
                eventType = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
            } else if line.hasPrefix("data:") {
                dataLines.append(String(line.dropFirst(5)).trimmingCharacters(in: .init(charactersIn: " ")))
            } else if line.hasPrefix(":") {
                // Comment/heartbeat line — ignore
                return
            }
        }
        
        guard !dataLines.isEmpty else { return }
        let dataString = dataLines.joined(separator: "\n")
        
        if let event = DjinnSSEEvent.parse(from: dataString) {
            onEvent(event)
        }
    }
}

// MARK: - Errors

enum ChatServiceError: LocalizedError {
    case noAPIKey
    case invalidResponse
    case httpError(statusCode: Int, body: String)
    
    var errorDescription: String? {
        switch self {
        case .noAPIKey:
            return "No API key configured. Set one in Settings."
        case .invalidResponse:
            return "Invalid response from server"
        case .httpError(let code, let body):
            if code == 401 { return "Unauthorized (401) — check your API key" }
            if code == 404 { return "Not found (404) — check agent ID and endpoint" }
            return "HTTP \(code): \(body.prefix(200))"
        }
    }
}
