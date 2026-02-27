import SwiftUI

/// Settings view for managing API key and app preferences.
struct SettingsView: View {
    @State private var apiKey: String = ""
    @State private var hasExistingKey: Bool = false
    @State private var showKey: Bool = false
    @State private var saveStatus: SaveStatus = .idle
    @State private var testStatus: TestStatus = .idle
    @State private var endpointURL: String = UserDefaults.standard.string(forKey: "aiEndpoint") ?? "https://localhost:8000/v1"
    @State private var agentId: String = UserDefaults.standard.string(forKey: "chatAgentId") ?? "chieko"
    @State private var selectedASREngine: ASREngine = ASREngine.current
    @State private var isReloadingASR: Bool = false

    @Environment(\.dismiss) private var dismiss

    enum SaveStatus: Equatable {
        case idle, saving, saved, error(String)
    }

    enum TestStatus: Equatable {
        case idle, testing, success, error(String)
    }

    var body: some View {
        Form {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Text("AI Configuration")
                        .font(.headline)

                    Text("Enter your API key for AI-powered features. The key is securely stored in the macOS Keychain and never leaves this device except when making API requests.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // Endpoint URL (above API key)
                HStack {
                    TextField("Endpoint URL", text: $endpointURL, prompt: Text("https://your-server.example.com/v1"))
                        .textFieldStyle(.roundedBorder)
                    Text("Base URL ending in /v1")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                // Agent ID for chat (Phase 3)
                HStack {
                    TextField("Chat Agent ID", text: $agentId)
                        .textFieldStyle(.roundedBorder)
                    Text("Used for AI Chat sessions")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }

                // API Key field
                HStack {
                    if showKey {
                        TextField("API Key", text: $apiKey)
                            .textFieldStyle(.roundedBorder)
                    } else {
                        SecureField("API Key", text: $apiKey)
                            .textFieldStyle(.roundedBorder)
                    }

                    Button {
                        showKey.toggle()
                    } label: {
                        Image(systemName: showKey ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.borderless)
                }

                // Actions — right-aligned
                HStack {
                    // Status indicator on the left
                    switch saveStatus {
                    case .idle:
                        EmptyView()
                    case .saving:
                        ProgressView()
                            .scaleEffect(0.7)
                    case .saved:
                        Label("Saved", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.caption)
                    case .error(let msg):
                        Label(msg, systemImage: "exclamationmark.triangle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }

                    if case .success = testStatus {
                        Label("Connected", systemImage: "checkmark.circle.fill")
                            .foregroundStyle(.green)
                            .font(.caption)
                    } else if case .error(let msg) = testStatus {
                        Label(msg, systemImage: "xmark.circle.fill")
                            .foregroundStyle(.red)
                            .font(.caption)
                    }

                    Spacer()

                    if hasExistingKey {
                        Button("Delete Key", role: .destructive) {
                            deleteAPIKey()
                        }
                    }

                    Button("Test Connection") {
                        testConnection()
                    }
                    .disabled(apiKey.isEmpty || endpointURL.isEmpty)
                    .buttonStyle(.bordered)

                    Button("Save") {
                        saveAPIKey()
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(apiKey.isEmpty)
                }
            }

            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Speech Recognition Engine")
                        .font(.headline)

                    Text("Choose the ASR model used for meeting transcription. Diarization (speaker identification) always uses FluidAudio regardless of this setting.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Picker("Engine", selection: $selectedASREngine) {
                        ForEach(availableASREngines) { engine in
                            VStack(alignment: .leading) {
                                Text(engine.displayName)
                                Text(engine.subtitle)
                                    .font(.caption2)
                                    .foregroundStyle(.tertiary)
                            }
                            .tag(engine)
                        }
                    }
                    .pickerStyle(.radioGroup)
                    .onChange(of: selectedASREngine) { _, newEngine in
                        applyASREngineChange(newEngine)
                    }

                    if isReloadingASR {
                        HStack(spacing: 6) {
                            ProgressView()
                                .scaleEffect(0.7)
                            Text("Loading speech recognition model...")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Documents Folder")
                        .font(.headline)

                    HStack {
                        Text(DocumentManager.shared.rootFolder.path)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)

                        Spacer()

                        Button("Open in Finder") {
                            NSWorkspace.shared.open(DocumentManager.shared.rootFolder)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }

            Section {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Voice Profiles")
                        .font(.headline)

                    Text("Rebuild voice profiles if speaker recognition accuracy has degraded after a model update.")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    HStack {
                        Text("\(VoiceProfileManager.shared.profiles.count) profile(s) enrolled")
                            .font(.caption)
                            .foregroundStyle(.secondary)

                        Spacer()

                        Button("Re-enroll Voice...") {
                            NotificationCenter.default.post(name: .reenrollVoice, object: nil)
                        }
                        .buttonStyle(.bordered)
                    }
                }
            }
        }
        .formStyle(.grouped)
        .frame(width: 520, height: 580)
        .onAppear(perform: loadExistingKey)
    }

    // MARK: - ASR Engine

    /// Only show engines that are available on this system.
    private var availableASREngines: [ASREngine] {
        ASREngine.allCases.filter { engine in
            switch engine {
            case .fluidAudio: return true
            case .appleSpeech: return ASREngine.isAppleSpeechAvailable
            }
        }
    }

    private func applyASREngineChange(_ engine: ASREngine) {
        ASREngine.current = engine
        isReloadingASR = true

        // Notify the coordinator to swap transcription services
        Task { @MainActor in
            await RecordingCoordinator.shared.switchASREngine(to: engine)
            isReloadingASR = false
        }
    }

    // MARK: - Actions

    private func loadExistingKey() {
        if let existing = try? KeychainManager.shared.getAPIKey() {
            apiKey = existing
            hasExistingKey = true
        }
    }

    private func saveAPIKey() {
        saveStatus = .saving
        do {
            try KeychainManager.shared.saveAPIKey(apiKey)
            UserDefaults.standard.set(endpointURL, forKey: "aiEndpoint")
            UserDefaults.standard.set(agentId, forKey: "chatAgentId")
            hasExistingKey = true
            saveStatus = .saved

            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                if saveStatus == .saved {
                    saveStatus = .idle
                }
            }
        } catch {
            saveStatus = .error(error.localizedDescription)
        }
    }

    private func deleteAPIKey() {
        do {
            try KeychainManager.shared.deleteAPIKey()
            apiKey = ""
            hasExistingKey = false
            saveStatus = .idle
        } catch {
            saveStatus = .error(error.localizedDescription)
        }
    }

    private func testConnection() {
        testStatus = .testing

        // Test against the Djinn /v1/status endpoint
        let base = endpointURL.hasSuffix("/") ? String(endpointURL.dropLast()) : endpointURL
        guard let url = URL(string: "\(base)/status") else {
            testStatus = .error("Invalid URL")
            return
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("Bearer \(apiKey)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.timeoutInterval = 10

        URLSession.shared.dataTask(with: request) { _, response, error in
            DispatchQueue.main.async {
                if let error = error {
                    testStatus = .error(error.localizedDescription)
                    return
                }
                if let http = response as? HTTPURLResponse {
                    if (200..<300).contains(http.statusCode) {
                        testStatus = .success
                    } else if http.statusCode == 401 {
                        testStatus = .error("Unauthorized (401)")
                    } else {
                        testStatus = .error("HTTP \(http.statusCode)")
                    }
                } else {
                    testStatus = .error("No response")
                }

                DispatchQueue.main.asyncAfter(deadline: .now() + 4) {
                    if testStatus == .success || testStatus != .idle {
                        testStatus = .idle
                    }
                }
            }
        }.resume()
    }
}
