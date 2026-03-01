import Combine
import Foundation
import OSLog
import SwiftUI

/// Top-level controller for the MeetingRecorder module.
///
/// Coordinates all sub-systems:
/// - `MeetingAppDetector` — discovers running Zoom/Teams/Chrome/etc.
/// - `DualAudioEngine` — captures mic + per-app meeting audio
/// - `MergeEngine` — merges ASR + diarization into a single transcript
///
/// Bind to this object from your SwiftUI view to display recording state
/// and the live interleaved transcript.
@available(macOS 26.0, *)
@MainActor
final class MeetingRecorderController: ObservableObject {

    // MARK: - Published State

    @Published var isRecording = false
    @Published var mergedSegments: [TaggedSegment] = []
    @Published var detectedMeetingApps: String = "None"
    @Published var recordingDuration: TimeInterval = 0
    @Published var errorMessage: String?

    /// Guards against duplicate start calls while awaiting pipeline setup.
    @Published var isStarting = false

    // MARK: - Private

    private let dualEngine = DualAudioEngine()
    private let mergeEngine = MergeEngine.shared
    private var cancellables = Set<AnyCancellable>()
    private var durationTimer: Timer?
    private var recordingStartDate: Date?

    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "MeetingRecorder")

    // MARK: - Start Recording

    /// Start recording the meeting.
    ///
    /// 1. Detects running meeting apps
    /// 2. Starts mic + per-app audio capture
    /// 3. Begins ASR + diarization on both streams
    /// 4. Starts mixed WAV recording
    func start() async {
        guard !isRecording, !isStarting else { return }
        isStarting = true
        errorMessage = nil

        do {
            // Detect meeting apps
            let meetingApps = await MeetingAppDetector.shared.runningMeetingApplications()
            let appNames = meetingApps.map(\.applicationName)
            detectedMeetingApps = appNames.isEmpty ? "None (mic only)" : appNames.joined(separator: ", ")

            logger.info("Starting recording. Detected apps: \(self.detectedMeetingApps)")

            // Reset merge engine for fresh recording
            mergeEngine.reset()

            // Start dual audio capture
            try await dualEngine.start(
                micEnabled: true,
                meetingEnabled: !meetingApps.isEmpty
            )

            // Bind merge engine output to our published property
            mergeEngine.$mergedSegments
                .receive(on: RunLoop.main)
                .assign(to: &$mergedSegments)

            // Start duration timer
            recordingStartDate = Date()
            durationTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
                Task { @MainActor in
                    guard let self, let start = self.recordingStartDate else { return }
                    self.recordingDuration = Date().timeIntervalSince(start)
                }
            }

            isRecording = true
            isStarting = false
            logger.info("Recording started")

        } catch {
            isStarting = false
            logger.error("Failed to start recording: \(error.localizedDescription)")
            errorMessage = error.localizedDescription
        }
    }

    // MARK: - Stop Recording

    /// Stop recording and return metadata about the session.
    ///
    /// Returns the WAV file URL and recording metadata, or nil if
    /// recording was not active.
    @discardableResult
    func stop() async -> RecordingMetadata? {
        guard isRecording else { return nil }

        logger.info("Stopping recording")

        // Stop duration timer
        durationTimer?.invalidate()
        durationTimer = nil

        // Stop audio capture
        let wavURL = await dualEngine.stop()
        isRecording = false

        // Build metadata
        let startDate = recordingStartDate ?? Date()
        let uniqueSpeakers = Set(mergedSegments.map(\.speaker))
        let metadata = RecordingMetadata(
            startDate: startDate,
            durationSeconds: recordingDuration,
            wavFileURL: wavURL,
            detectedApps: detectedMeetingApps.components(separatedBy: ", "),
            speakerCount: uniqueSpeakers.count,
            segmentCount: mergedSegments.count
        )

        // Save metadata sidecar
        do {
            try metadata.writeSidecar()
            logger.info("Recording metadata saved")
        } catch {
            logger.warning("Failed to save metadata: \(error.localizedDescription)")
        }

        recordingStartDate = nil
        logger.info("Recording stopped. Duration: \(String(format: "%.1f", self.recordingDuration))s, Speakers: \(uniqueSpeakers.count)")

        return metadata
    }

    // MARK: - Helpers

    /// Formatted duration string for display (MM:SS).
    var formattedDuration: String {
        let minutes = Int(recordingDuration) / 60
        let seconds = Int(recordingDuration) % 60
        return String(format: "%02d:%02d", minutes, seconds)
    }
}
