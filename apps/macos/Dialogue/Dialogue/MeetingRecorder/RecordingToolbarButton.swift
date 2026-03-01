import SwiftUI

/// A toolbar button for the title bar: red circle when idle, red square when recording.
/// Tapping toggles recording on/off via the shared MeetingRecorderController.
@available(macOS 26.0, *)
struct RecordingToolbarButton: View {
    @ObservedObject var recorder: MeetingRecorderController
    @ObservedObject private var preloader = ModelPreloader.shared

    var body: some View {
        Button {
            Task {
                if recorder.isRecording {
                    await recorder.stop()
                } else {
                    await recorder.start()
                }
            }
        } label: {
            ZStack {
                if recorder.isRecording {
                    // Pulsing glow behind the stop square
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.red.opacity(0.3))
                        .frame(width: 16, height: 16)
                        .scaleEffect(1.5)
                        .opacity(0.6)
                        .animation(
                            .easeInOut(duration: 0.8).repeatForever(autoreverses: true),
                            value: recorder.isRecording
                        )

                    // Stop square
                    RoundedRectangle(cornerRadius: 3)
                        .fill(Color.red)
                        .frame(width: 12, height: 12)
                } else {
                    // Record circle
                    Circle()
                        .fill(Color.red)
                        .frame(width: 14, height: 14)
                }
            }
            .frame(width: 20, height: 20)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(recorder.isStarting || !preloader.state.isReady)
        .opacity((recorder.isStarting || !preloader.state.isReady) ? 0.4 : 1.0)
        .help(recorder.isRecording ? "Stop Recording" : "Start Recording")
    }
}
