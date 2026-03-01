import Foundation
import SwiftData

// MARK: - Persistent Speaker Profile (SwiftData)

/// Cross-session speaker profile stored via SwiftData.
///
/// Embeddings are averaged over multiple meetings so the system
/// can recognise recurring speakers (e.g. "Alice" in every standup).
@Model
final class SpeakerProfile {
    @Attribute(.unique) var speakerID: String
    var displayName: String
    var embedding: [Float]
    var sampleCount: Int
    var lastSeenDate: Date
    var createdDate: Date

    init(
        speakerID: String,
        displayName: String = "",
        embedding: [Float],
        sampleCount: Int = 1,
        lastSeenDate: Date = .now,
        createdDate: Date = .now
    ) {
        self.speakerID = speakerID
        self.displayName = displayName.isEmpty ? speakerID : displayName
        self.embedding = embedding
        self.sampleCount = sampleCount
        self.lastSeenDate = lastSeenDate
        self.createdDate = createdDate
    }

    /// Incrementally update the running-average embedding with a new observation.
    func updateEmbedding(with newEmbedding: [Float]) {
        guard newEmbedding.count == embedding.count else { return }
        let n = Float(sampleCount)
        let n1 = Float(sampleCount + 1)
        for i in embedding.indices {
            embedding[i] = (embedding[i] * n + newEmbedding[i]) / n1
        }
        sampleCount += 1
        lastSeenDate = .now
    }

    /// Cosine similarity between this profile and a candidate embedding.
    func cosineSimilarity(with other: [Float]) -> Float {
        guard other.count == embedding.count, !embedding.isEmpty else { return 0 }
        var dot: Float = 0
        var magA: Float = 0
        var magB: Float = 0
        for i in embedding.indices {
            dot += embedding[i] * other[i]
            magA += embedding[i] * embedding[i]
            magB += other[i] * other[i]
        }
        let denom = sqrt(magA) * sqrt(magB)
        return denom > 0 ? dot / denom : 0
    }
}

// MARK: - Speaker Profile Store

/// Manages cross-session speaker lookup and persistence via SwiftData.
actor SpeakerProfileStore {
    private let modelContainer: ModelContainer
    private let matchThreshold: Float = 0.75

    init() throws {
        let schema = Schema([SpeakerProfile.self])
        let config = ModelConfiguration(schema: schema, isStoredInMemoryOnly: false)
        self.modelContainer = try ModelContainer(for: schema, configurations: [config])
    }

    /// Find or create a speaker profile matching the given embedding.
    @MainActor
    func resolveProfile(for embedding: [Float], streamPrefix: String) throws -> SpeakerProfile {
        let context = modelContainer.mainContext
        let descriptor = FetchDescriptor<SpeakerProfile>(
            sortBy: [SortDescriptor(\.lastSeenDate, order: .reverse)]
        )
        let existing = try context.fetch(descriptor)

        // Find best match above threshold
        var bestMatch: SpeakerProfile?
        var bestScore: Float = matchThreshold
        for profile in existing {
            let score = profile.cosineSimilarity(with: embedding)
            if score > bestScore {
                bestScore = score
                bestMatch = profile
            }
        }

        if let match = bestMatch {
            match.updateEmbedding(with: embedding)
            try context.save()
            return match
        }

        // Create new profile
        let newID = "\(streamPrefix)-Speaker\(existing.count + 1)"
        let profile = SpeakerProfile(speakerID: newID, embedding: embedding)
        context.insert(profile)
        try context.save()
        return profile
    }
}
