import Combine
import Foundation
import OSLog

/// Merges ASR transcript segments and diarization speaker segments from
/// both mic and meeting streams onto a single shared audio timeline.
///
/// ## Merge Strategy
///
/// **Diarization** produces segments with speaker labels and time ranges (no text).
/// **ASR** produces segments with text and time ranges (no speaker).
///
/// Progressive transcription emits many **partial** results (broad time range,
/// text still being refined) before a **final** result (precise time range).
///
/// - Partials: update a single "live" slot per stream for immediate UI feedback.
/// - Finals:  matched to the best-overlapping diarization segment by time,
///            giving us speaker-attributed text.
///
/// The output `mergedSegments` is sorted by start time for the UI.
@MainActor
final class MergeEngine: ObservableObject {

    static let shared = MergeEngine()

    // MARK: - Published Output

    /// The merged transcript: diarized + transcribed segments sorted by time.
    @Published var mergedSegments: [TaggedSegment] = []

    // MARK: - Internal State

    /// Committed diarization segments (speaker labels, may have text from finals).
    private var diarizationSegments: [TaggedSegment] = []

    /// Finalized ASR segments waiting to be merged with diarization.
    private var finalASRBuffer: [ASRSegment] = []

    /// One "live partial" per stream for immediate display while ASR refines.
    /// Replaced on every partial update, cleared when the final arrives.
    private var livePartials: [StreamType: ASRSegment] = [:]

    /// Debounce timer for batch merge operations.
    private var mergeTimer: Timer?
    private let mergeInterval: TimeInterval = 0.25

    private let logger = Logger(subsystem: "bot.djinn.app.dialog", category: "MergeEngine")

    private init() {}

    // MARK: - Ingestion

    /// Add a diarization segment (from RealtimeDiarizationManager).
    func add(_ segment: TaggedSegment) {
        diarizationSegments.append(segment)
        scheduleMerge()
    }

    /// Add an ASR result (from RealtimeTranscriptionManager).
    ///
    /// Partials update the live slot for that stream.
    /// Finals are buffered for merge with diarization.
    func addASR(_ segment: ASRSegment) {
        if segment.isFinal {
            // Final result: precise timestamps, ready to merge with diarization.
            finalASRBuffer.append(segment)
            // Clear the live partial for this stream since it's been finalized.
            livePartials.removeValue(forKey: segment.stream)
        } else {
            // Partial: replace the live slot (only the latest partial matters).
            livePartials[segment.stream] = segment
        }
        scheduleMerge()
    }

    // MARK: - Merge Logic

    private func scheduleMerge() {
        mergeTimer?.invalidate()
        mergeTimer = Timer.scheduledTimer(withTimeInterval: mergeInterval, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.performMerge()
            }
        }
    }

    /// Match finalized ASR text to diarization segments by temporal overlap,
    /// then append live partials at the end.
    private func performMerge() {
        // 1. Merge finalized ASR results into diarization segments
        for asr in finalASRBuffer {
            // Find all diarization segments that overlap this ASR result
            let candidates = diarizationSegments.enumerated().filter {
                overlapDuration($0.element, asr) > 0 && $0.element.stream == asr.stream
            }

            let bestMatch = candidates.max { a, b in
                overlapDuration(a.element, asr) < overlapDuration(b.element, asr)
            }

            let asrStart = String(format: "%.1f", asr.start)
            let asrEnd = String(format: "%.1f", asr.end)
            let streamName = asr.stream.rawValue

            if let (index, matched) = bestMatch {
                let overlap = String(format: "%.2f", overlapDuration(matched, asr))
                let ms = String(format: "%.1f", matched.start)
                let me = String(format: "%.1f", matched.end)
                let msg = "[MERGE] \(streamName) [\(asrStart)s-\(asrEnd)s] → \(matched.speaker) [\(ms)s-\(me)s] overlap=\(overlap)s: \"\(asr.text)\""
                logger.info("\(msg)")
                diarizationSegments[index].text = asr.text
                diarizationSegments[index].isFinal = true
            } else {
                let sameStreamDiar = diarizationSegments.filter { $0.stream == asr.stream }
                let diarCount = sameStreamDiar.count
                let asrStartTime = asr.start
                let nearestDiar = sameStreamDiar.min { (a: TaggedSegment, b: TaggedSegment) -> Bool in
                    abs(a.start - asrStartTime) < abs(b.start - asrStartTime)
                }
                if let nearest = nearestDiar {
                    let ns = String(format: "%.1f", nearest.start)
                    let ne = String(format: "%.1f", nearest.end)
                    logger.warning("[MERGE] \(streamName) [\(asrStart)s-\(asrEnd)s] NO OVERLAP (\(diarCount) diar segs, nearest: [\(ns)s-\(ne)s]): \"\(asr.text)\"")
                } else {
                    logger.warning("[MERGE] \(streamName) [\(asrStart)s-\(asrEnd)s] NO DIAR SEGS: \"\(asr.text)\"")
                }
                let fallback = TaggedSegment(
                    stream: asr.stream,
                    speaker: "\(asr.stream.rawValue)-Unknown",
                    start: asr.start,
                    end: asr.end,
                    text: asr.text,
                    isFinal: true
                )
                diarizationSegments.append(fallback)
            }
        }
        finalASRBuffer.removeAll()

        // 2. Build the output: collapsed diarization segments + live partials
        var output = collapseAdjacentSegments(diarizationSegments)

        // 3. Append live partials as tentative rows at the end of the transcript.
        //    These show what the recognizer is currently hearing, attributed to
        //    the best-matching diarization speaker if possible.
        for (partialStream, partial) in livePartials {
            // Try to find a recent diarization segment to attribute the partial to
            let streamDiarSegs = diarizationSegments.filter { $0.stream == partialStream }
            let recentDiar = streamDiarSegs.max { $0.end < $1.end }

            let speaker = recentDiar?.speaker ?? "\(partialStream.rawValue)-..."
            let partialSegment = TaggedSegment(
                stream: partialStream,
                speaker: speaker,
                start: partial.start,
                end: partial.end,
                text: partial.text,
                isFinal: false
            )
            output.append(partialSegment)
        }

        // 4. Sort by start time and publish
        mergedSegments = output.sorted { $0.start < $1.start }
    }

    /// Collapse adjacent segments from the same speaker within a gap threshold.
    private func collapseAdjacentSegments(_ segments: [TaggedSegment]) -> [TaggedSegment] {
        let sorted = segments.sorted { $0.start < $1.start }
        var result: [TaggedSegment] = []
        let maxGap: TimeInterval = 1.5 // seconds

        for segment in sorted {
            if var last = result.last,
               last.speaker == segment.speaker,
               last.stream == segment.stream,
               segment.start - last.end < maxGap {
                // Merge into the previous segment
                last.end = max(last.end, segment.end)
                if !segment.text.isEmpty {
                    if last.text.isEmpty {
                        last.text = segment.text
                    } else {
                        last.text += " " + segment.text
                    }
                }
                last.isFinal = segment.isFinal
                result[result.count - 1] = last
            } else {
                result.append(segment)
            }
        }

        return result
    }

    // MARK: - Helpers

    /// Compute the temporal overlap between a diarization segment and an ASR segment.
    private func overlapDuration(_ diar: TaggedSegment, _ asr: ASRSegment) -> TimeInterval {
        let overlapStart = max(diar.start, asr.start)
        let overlapEnd = min(diar.end, asr.end)
        return max(0, overlapEnd - overlapStart)
    }

    /// Reset all state (call when starting a new recording).
    func reset() {
        mergeTimer?.invalidate()
        mergeTimer = nil
        diarizationSegments.removeAll()
        finalASRBuffer.removeAll()
        livePartials.removeAll()
        mergedSegments.removeAll()
    }
}
