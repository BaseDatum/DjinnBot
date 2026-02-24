import SwiftUI

// MARK: - StatusFooterView

/// A persistent footer bar at the bottom of the main window that shows:
/// - Model download progress during first launch
/// - Model warm-up progress after download
/// - "Start Recording" button when ready
struct StatusFooterView: View {
    @ObservedObject var launchManager: FirstLaunchManager
    @ObservedObject var coordinator: RecordingCoordinator
    var onStartRecording: () -> Void
    
    var body: some View {
        Group {
            switch launchManager.phase {
            case .idle:
                EmptyView()
                
            case .downloading:
                downloadingFooter
                
            case .enrolling:
                enrollingFooter
                
            case .done:
                if coordinator.modelsReady {
                    readyFooter
                } else {
                    warmingUpFooter
                }
                
            case .error:
                errorFooter
            }
        }
    }
    
    // MARK: - Download Footer
    
    private var downloadingFooter: some View {
        HStack(spacing: 12) {
            ProgressView(value: launchManager.downloadProgress)
                .progressViewStyle(.linear)
                .frame(maxWidth: 200)
            
            Text(launchManager.statusMessage)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
    
    // MARK: - Enrolling Footer
    
    private var enrollingFooter: some View {
        HStack(spacing: 12) {
             Image(systemName: "waveform.circle")
                .foregroundStyle(.tint)
            
            Text("Voice enrollment required for speaker recognition")
                .font(.caption)
                .foregroundStyle(.secondary)
            
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
    
    // MARK: - Warming Up Footer
    
    private var warmingUpFooter: some View {
        HStack(spacing: 12) {
            ProgressView()
                .controlSize(.small)
            
            Text(coordinator.modelLoadingStatus.isEmpty ? "Loading AI models..." : coordinator.modelLoadingStatus)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
    
    // MARK: - Ready Footer
    
    private var readyFooter: some View {
        HStack(spacing: 12) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(.green)
            
            Text("Ready for meetings")
                .font(.caption)
                .foregroundStyle(.secondary)
            
            Spacer()
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
    
    // MARK: - Error Footer
    
    private var errorFooter: some View {
        HStack(spacing: 12) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
            
            Text(launchManager.errorMessage ?? "An error occurred")
                .font(.caption)
                .foregroundStyle(.secondary)
            
            Spacer()
            
            Button("Retry") {
                launchManager.beginIfNeeded()
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(.ultraThinMaterial)
    }
}
