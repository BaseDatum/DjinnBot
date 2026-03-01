import SwiftUI

// MARK: - StatusFooterView

/// A persistent footer bar at the bottom of the main window.
/// Shows model download progress during startup and other app-wide status.
struct StatusFooterView: View {
    var body: some View {
        if #available(macOS 26.0, *) {
            StatusFooterContent()
        } else {
            EmptyView()
        }
    }
}

@available(macOS 26.0, *)
private struct StatusFooterContent: View {
    @ObservedObject private var preloader = ModelPreloader.shared

    var body: some View {
        // Only show the footer when there is something to display
        if !preloader.state.isReady {
            VStack(spacing: 0) {
                Divider()
                HStack(spacing: 8) {
                    statusContent
                    Spacer()
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 6)
                .background(Color(nsColor: .windowBackgroundColor))
            }
            .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }

    @ViewBuilder
    private var statusContent: some View {
        switch preloader.state {
        case .idle:
            ProgressView()
                .controlSize(.small)
            Text("Preparing models...")
                .font(.caption)
                .foregroundStyle(.secondary)

        case .downloading(let description, let fraction):
            ProgressView()
                .controlSize(.small)
            Text(description)
                .font(.caption)
                .foregroundStyle(.secondary)
            if let fraction {
                ProgressView(value: fraction)
                    .progressViewStyle(.linear)
                    .frame(maxWidth: 120)
            }

        case .failed(let message):
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.yellow)
                .font(.caption)
            Text(message)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Button("Retry") {
                preloader.preload()
            }
            .buttonStyle(.borderless)
            .font(.caption)

        case .ready:
            EmptyView()
        }
    }
}
