import SwiftUI

/// The Home screen shown in the main detail area when no document is open.
/// Displays a centered title, subtitle, and wireframe update cards.
struct HomeView: View {
    /// Number of placeholder wireframe cards to show.
    private let cardCount = 5

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Title
            Text("Dialogue Home")
                .font(.largeTitle)
                .fontWeight(.semibold)
                .foregroundStyle(.primary)

            // Subtitle
            Text("Updates from Dialogue will appear here")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            // Wireframe cards
            VStack(spacing: 8) {
                ForEach(0..<cardCount, id: \.self) { _ in
                    WireframeCardView()
                }
            }
            .padding(.top, 32)
            .frame(maxWidth: 480)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(nsColor: .windowBackgroundColor))
    }
}

// MARK: - WireframeCardView

/// A narrow placeholder card representing a future update entry.
private struct WireframeCardView: View {
    var body: some View {
        RoundedRectangle(cornerRadius: 8)
            .fill(Color(nsColor: .controlBackgroundColor))
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1)
            )
            .frame(height: 48)
    }
}

#Preview {
    HomeView()
        .frame(width: 600, height: 500)
}
