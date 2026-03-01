import SwiftUI

/// Catppuccin Mocha palette colors for speaker differentiation.
/// Each color is used as a subtle row background tint for transcript entries.
enum CatppuccinSpeaker {

    // MARK: - Mocha Accent Colors

    static let rosewater = Color(red: 245/255, green: 224/255, blue: 220/255)
    static let flamingo  = Color(red: 242/255, green: 205/255, blue: 205/255)
    static let pink      = Color(red: 245/255, green: 194/255, blue: 231/255)
    static let mauve     = Color(red: 203/255, green: 166/255, blue: 247/255)
    static let red       = Color(red: 243/255, green: 139/255, blue: 168/255)
    static let maroon    = Color(red: 235/255, green: 160/255, blue: 172/255)
    static let peach     = Color(red: 250/255, green: 179/255, blue: 135/255)
    static let yellow    = Color(red: 249/255, green: 226/255, blue: 175/255)
    static let green     = Color(red: 166/255, green: 227/255, blue: 161/255)
    static let teal      = Color(red: 148/255, green: 226/255, blue: 213/255)
    static let sky       = Color(red: 137/255, green: 220/255, blue: 235/255)
    static let sapphire  = Color(red: 116/255, green: 199/255, blue: 236/255)
    static let blue      = Color(red: 137/255, green: 180/255, blue: 250/255)
    static let lavender  = Color(red: 180/255, green: 190/255, blue: 254/255)

    // MARK: - Speaker Text Colors (darker variants for label text)

    static let subtext0  = Color(red: 166/255, green: 173/255, blue: 200/255)
    static let overlay0  = Color(red: 108/255, green: 112/255, blue: 134/255)

    /// Ordered palette for assigning colors to speakers.
    /// Chosen for maximum visual distinction between adjacent entries.
    private static let palette: [Color] = [
        mauve, peach, teal, pink, sapphire, yellow,
        green, flamingo, blue, maroon, sky, lavender,
        rosewater, red,
    ]

    /// Returns a consistent Catppuccin color for a speaker label.
    static func color(for speaker: String) -> Color {
        let hash = abs(speaker.hashValue)
        return palette[hash % palette.count]
    }

    /// Row background opacity for light/dark appearance.
    /// Subtle enough to read text over, strong enough to differentiate speakers.
    static let rowBackgroundOpacity: Double = 0.12

    /// Speaker label text color — uses the full-strength accent.
    static func labelColor(for speaker: String) -> Color {
        color(for: speaker)
    }
}
