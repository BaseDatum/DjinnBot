import Foundation
import Combine
import FluidAudio

// MARK: - FirstLaunchManager

/// Orchestrates the first-app-open experience:
/// 1. Model download (FluidAudio ASR + diarization models)
/// 2. Primary voice enrollment
///
/// After both steps complete, the app is ready for meeting recording.
/// Tracks state via UserDefaults so it only runs once.
@MainActor
final class FirstLaunchManager: ObservableObject {
    static let shared = FirstLaunchManager()
    
    // MARK: - Published State
    
    /// Current phase of the first-launch flow.
    @Published var phase: FirstLaunchPhase = .idle
    
    /// Download progress (0.0 - 1.0).
    @Published var downloadProgress: Double = 0
    
    /// Human-readable status message for the footer.
    @Published var statusMessage: String = ""
    
    /// Whether any error occurred.
    @Published var errorMessage: String?
    
    /// Whether the first-launch flow is complete (models downloaded + user enrolled).
    @Published var isComplete: Bool = false
    
    /// Whether the enrollment prompt should be shown.
    @Published var showEnrollmentPrompt: Bool = false
    
    // MARK: - Private
    
    private let defaults = UserDefaults.standard
    private let modelsDownloadedKey = "dialogue.modelsDownloaded"
    private let userEnrolledKey = "dialogue.primaryUserEnrolled"
    private let hasMigratedToFluidAudioKey = "dialogue.hasMigratedToFluidAudio"
    
    private init() {
        // Check if already complete
        let modelsOK = defaults.bool(forKey: modelsDownloadedKey)
        let enrolled = defaults.bool(forKey: userEnrolledKey)
        
        if modelsOK && enrolled {
            isComplete = true
            phase = .done
        }
    }
    
    // MARK: - Public API
    
    /// Begin the first-launch flow if not already complete.
    /// Called from ContentView.onAppear.
    func beginIfNeeded() {
        guard !isComplete else {
            // Check if we need to run the FluidAudio migration for existing users
            runMigrationIfNeeded()
            return
        }
        
        let modelsOK = defaults.bool(forKey: modelsDownloadedKey)
        let enrolled = defaults.bool(forKey: userEnrolledKey)
        
        if !modelsOK {
            startModelDownload()
        } else if !enrolled {
            // Models exist but user not enrolled
            showEnrollmentPrompt = true
            phase = .enrolling
        } else {
            isComplete = true
            phase = .done
        }
    }
    
    /// Called after the user completes voice enrollment.
    func markEnrollmentComplete() {
        defaults.set(true, forKey: userEnrolledKey)
        showEnrollmentPrompt = false
        isComplete = true
        phase = .done
        statusMessage = ""
    }
    
    // MARK: - Migration
    
    /// For existing users who had WhisperKit: re-download FluidAudio ASR models
    /// and prompt for voice re-enrollment (embeddings may differ).
    private func runMigrationIfNeeded() {
        guard !defaults.bool(forKey: hasMigratedToFluidAudioKey) else { return }
        
        // Mark models as needing re-download (ASR models changed from WhisperKit to FluidAudio)
        defaults.set(false, forKey: modelsDownloadedKey)
        
        // Start re-download silently (doesn't block the user, just redownloads in background)
        startModelDownload(isMigration: true)
    }
    
    // MARK: - Model Download
    
    private func startModelDownload(isMigration: Bool = false) {
        phase = .downloading
        statusMessage = isMigration
            ? "Upgrading AI models to FluidAudio..."
            : "Downloading AI models (\u{2248}850 MB)..."
        downloadProgress = 0
        
        Task {
            do {
                // Download FluidAudio ASR models (Parakeet TDT v3)
                statusMessage = "Downloading speech recognition model..."
                let _ = try await AsrModels.download()
                downloadProgress = 0.5
                
                // Download FluidAudio diarization models (Sortformer/Pyannote)
                statusMessage = "Downloading speaker diarization model..."
                let _ = try await DiarizerModels.download()
                downloadProgress = 1.0
                
                statusMessage = "Models downloaded successfully"
                defaults.set(true, forKey: modelsDownloadedKey)
                defaults.set(true, forKey: hasMigratedToFluidAudioKey)
                
                if isMigration {
                    // Migration complete — prompt re-enrollment for better accuracy
                    // (FluidAudio WeSpeaker embeddings differ from old embeddings)
                    isComplete = true
                    phase = .done
                    statusMessage = ""
                    
                    // Check if existing profiles should be re-enrolled
                    if VoiceProfileManager.shared.isPrimaryUserEnrolled {
                        showEnrollmentPrompt = true
                        statusMessage = "Re-enroll your voice for improved accuracy"
                    }
                    return
                }
                
                // New user flow: check if enrollment is needed
                if !defaults.bool(forKey: userEnrolledKey) {
                    // Brief pause before showing enrollment
                    try? await Task.sleep(for: .seconds(0.5))
                    showEnrollmentPrompt = true
                    phase = .enrolling
                    statusMessage = "Voice enrollment required"
                } else {
                    isComplete = true
                    phase = .done
                }
                
            } catch {
                errorMessage = "Download failed: \(error.localizedDescription)"
                statusMessage = "Download failed. Will retry on next launch."
                phase = .error
                print("[Dialogue] Model download error: \(error)")
            }
        }
    }
}

// MARK: - FirstLaunchPhase

enum FirstLaunchPhase: Equatable {
    case idle
    case downloading
    case enrolling
    case done
    case error
}

// MARK: - Errors

enum FirstLaunchError: LocalizedError {
    case asrDownloadFailed(String)
    case diarizationDownloadFailed(String)
    
    var errorDescription: String? {
        switch self {
        case .asrDownloadFailed(let msg):          return "ASR model download failed: \(msg)"
        case .diarizationDownloadFailed(let msg):  return "Diarization model download failed: \(msg)"
        }
    }
}
