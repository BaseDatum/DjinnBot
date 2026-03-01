import Foundation
import Accelerate

// MARK: - VoiceProfile

/// A named speaker voice profile containing an embedding vector for identification.
/// Now stores multiple raw embeddings (up to `maxRawEmbeddings`) with FIFO management,
/// mirroring FluidAudio's Speaker type, so profiles improve over time.
struct VoiceProfile: Codable, Identifiable, Equatable {
    let id: String           // Unique identifier (UUID string or "primary-user")
    var displayName: String  // Human-readable name ("You", "Sarah Chen", etc.)
    var embedding: [Float]   // Current centroid embedding (L2-normalized)
    let createdAt: Date
    
    /// Raw embedding observations for this speaker (FIFO, max 50).
    /// Each observation refines the centroid when added.
    var rawEmbeddings: [RawEmbeddingObservation] = []
    
    /// Number of times the embedding has been updated via EMA.
    var updateCount: Int = 1
    
    /// Maximum raw embeddings to keep (FIFO eviction).
    static let maxRawEmbeddings = 50
    
    /// The reserved identifier for the primary user ("You").
    static let primaryUserID = "primary-user"
    
    var isPrimaryUser: Bool { id == Self.primaryUserID }
    
    /// A single raw embedding observation with timestamp.
    struct RawEmbeddingObservation: Codable, Equatable {
        let embedding: [Float]
        let timestamp: Date
    }
}

// MARK: - VoiceProfileManager

/// Manages voice profiles: enrollment, persistence (via Keychain), and speaker matching.
/// Thread-safe — all mutations go through the main actor.
///
/// Enhancements:
/// - Multi-embedding FIFO storage per profile (up to 50 raw embeddings)
/// - EMA (exponential moving average) embedding updates during sessions
/// - L2-normalized embeddings for numerically stable cosine similarity
/// - Speaker merge support
@MainActor
final class VoiceProfileManager: ObservableObject {
    static let shared = VoiceProfileManager()
    
    /// All loaded voice profiles (including "You").
    @Published private(set) var profiles: [VoiceProfile] = []
    
    /// Whether the primary user has been enrolled.
    var isPrimaryUserEnrolled: Bool {
        profiles.contains { $0.isPrimaryUser }
    }
    
    /// Cosine similarity threshold for a positive speaker match.
    /// Lowered from 0.75 to 0.65 for more robust cross-session and
    /// cross-audio-path matching (mic enrollment vs system audio playback
    /// produces different acoustic characteristics).
    private let matchThreshold: Float = 0.65
    
    /// EMA blending factor: higher = more weight on existing embedding.
    /// Matches FluidAudio's Speaker.updateMainEmbedding default alpha.
    private static let emaAlpha: Float = 0.9
    
    private let keychain = KeychainManager.shared
    
    private init() {
        loadAllProfiles()
    }
    
    // MARK: - Profile CRUD
    
    /// Enroll the primary user with a computed embedding.
    func enrollPrimaryUser(embedding: [Float]) throws {
        let normalized = Self.l2Normalize(embedding)
        var profile = VoiceProfile(
            id: VoiceProfile.primaryUserID,
            displayName: "You",
            embedding: normalized,
            createdAt: Date()
        )
        // Store the initial enrollment as the first raw embedding
        profile.rawEmbeddings = [
            VoiceProfile.RawEmbeddingObservation(embedding: normalized, timestamp: Date())
        ]
        try saveProfile(profile)
    }
    
    /// Create and save a new named speaker profile.
    @discardableResult
    func createProfile(displayName: String, embedding: [Float]) throws -> VoiceProfile {
        let normalized = Self.l2Normalize(embedding)
        var profile = VoiceProfile(
            id: UUID().uuidString,
            displayName: displayName,
            embedding: normalized,
            createdAt: Date()
        )
        profile.rawEmbeddings = [
            VoiceProfile.RawEmbeddingObservation(embedding: normalized, timestamp: Date())
        ]
        try saveProfile(profile)
        return profile
    }
    
    /// Rename an existing profile.
    func renameProfile(id: String, newName: String) throws {
        guard var profile = profiles.first(where: { $0.id == id }) else { return }
        profile.displayName = newName
        try saveProfile(profile)
    }
    
    /// Delete a profile by ID (cannot delete primary user).
    func deleteProfile(id: String) throws {
        guard id != VoiceProfile.primaryUserID else { return }
        try keychain.deleteVoiceEmbedding(identifier: id)
        profiles.removeAll { $0.id == id }
    }
    
    // MARK: - EMA Embedding Updates
    
    /// Update a profile's embedding using exponential moving average.
    /// Called by RealTimeDiarizationService when a known speaker is re-identified.
    ///
    /// New centroid = alpha * old_centroid + (1 - alpha) * new_embedding
    /// Then re-normalized to unit length.
    func updateEmbeddingEMA(profileID: String, newEmbedding: [Float]) {
        guard var profile = profiles.first(where: { $0.id == profileID }) else { return }
        guard newEmbedding.count == profile.embedding.count else { return }
        
        let normalized = Self.l2Normalize(newEmbedding)
        let alpha = Self.emaAlpha
        
        // EMA blend
        var updated = [Float](repeating: 0, count: profile.embedding.count)
        for i in 0..<updated.count {
            updated[i] = alpha * profile.embedding[i] + (1 - alpha) * normalized[i]
        }
        profile.embedding = Self.l2Normalize(updated)
        profile.updateCount += 1
        
        // Add to raw embeddings with FIFO eviction
        let observation = VoiceProfile.RawEmbeddingObservation(embedding: normalized, timestamp: Date())
        profile.rawEmbeddings.append(observation)
        if profile.rawEmbeddings.count > VoiceProfile.maxRawEmbeddings {
            profile.rawEmbeddings.removeFirst(profile.rawEmbeddings.count - VoiceProfile.maxRawEmbeddings)
        }
        
        // Save (throttled: only persist every 10 updates to avoid excessive Keychain writes)
        if profile.updateCount % 10 == 0 {
            try? saveProfile(profile)
        } else {
            // Update in-memory only
            if let idx = profiles.firstIndex(where: { $0.id == profile.id }) {
                profiles[idx] = profile
            }
        }
    }
    
    /// Recalculate a profile's centroid from all stored raw embeddings.
    /// Useful after merging profiles or correcting drift.
    func recalculateCentroid(profileID: String) throws {
        guard var profile = profiles.first(where: { $0.id == profileID }) else { return }
        guard !profile.rawEmbeddings.isEmpty else { return }
        
        let size = profile.embedding.count
        var average = [Float](repeating: 0, count: size)
        var validCount = 0
        
        for raw in profile.rawEmbeddings {
            guard raw.embedding.count == size else { continue }
            for i in 0..<size {
                average[i] += raw.embedding[i]
            }
            validCount += 1
        }
        
        guard validCount > 0 else { return }
        let divisor = Float(validCount)
        for i in 0..<size {
            average[i] /= divisor
        }
        
        profile.embedding = Self.l2Normalize(average)
        try saveProfile(profile)
    }
    
    /// Merge another profile's embeddings into a destination profile.
    /// The source profile is deleted after merge.
    func mergeProfile(sourceID: String, into destinationID: String) throws {
        guard sourceID != destinationID else { return }
        guard let source = profiles.first(where: { $0.id == sourceID }),
              var destination = profiles.first(where: { $0.id == destinationID }) else { return }
        
        // Combine raw embeddings, keeping the most recent up to the max
        var combined = destination.rawEmbeddings + source.rawEmbeddings
        combined.sort { $0.timestamp > $1.timestamp }
        if combined.count > VoiceProfile.maxRawEmbeddings {
            combined = Array(combined.prefix(VoiceProfile.maxRawEmbeddings))
        }
        destination.rawEmbeddings = combined
        destination.updateCount += source.updateCount
        
        // Recalculate centroid from combined embeddings
        let size = destination.embedding.count
        var average = [Float](repeating: 0, count: size)
        var validCount = 0
        for raw in combined {
            guard raw.embedding.count == size else { continue }
            for i in 0..<size {
                average[i] += raw.embedding[i]
            }
            validCount += 1
        }
        if validCount > 0 {
            let divisor = Float(validCount)
            for i in 0..<size { average[i] /= divisor }
            destination.embedding = Self.l2Normalize(average)
        }
        
        try saveProfile(destination)
        try deleteProfile(id: sourceID)
    }
    
    // MARK: - Speaker Matching
    
    /// Find the best matching profile for a given embedding vector.
    /// Returns nil if no profile exceeds the similarity threshold.
    func matchSpeaker(embedding: [Float]) -> VoiceProfile? {
        guard !profiles.isEmpty else { return nil }
        
        let normalized = Self.l2Normalize(embedding)
        var bestProfile: VoiceProfile?
        var bestScore: Float = -1
        
        for profile in profiles {
            let score = cosineSimilarity(normalized, profile.embedding)
            if score > bestScore {
                bestScore = score
                bestProfile = profile
            }
        }
        
        guard bestScore >= matchThreshold, let match = bestProfile else {
            return nil
        }
        return match
    }
    
    /// Compute the display label for a speaker embedding.
    /// Returns the matched profile's displayName, or nil if unknown.
    func identifySpeaker(embedding: [Float]) -> String? {
        matchSpeaker(embedding: embedding)?.displayName
    }
    
    // MARK: - Persistence
    
    private func saveProfile(_ profile: VoiceProfile) throws {
        let data = try JSONEncoder().encode(profile)
        try keychain.saveVoiceEmbedding(data, identifier: profile.id)
        
        // Update in-memory cache
        if let idx = profiles.firstIndex(where: { $0.id == profile.id }) {
            profiles[idx] = profile
        } else {
            profiles.append(profile)
        }
    }
    
    private func loadAllProfiles() {
        let identifiers = keychain.allVoiceEmbeddingIdentifiers()
        var loaded: [VoiceProfile] = []
        
        for id in identifiers {
            guard let data = try? keychain.getVoiceEmbedding(identifier: id),
                  let profile = try? JSONDecoder().decode(VoiceProfile.self, from: data) else {
                continue
            }
            loaded.append(profile)
        }
        
        // Sort: primary user first, then alphabetically
        loaded.sort { lhs, rhs in
            if lhs.isPrimaryUser { return true }
            if rhs.isPrimaryUser { return false }
            return lhs.displayName.localizedStandardCompare(rhs.displayName) == .orderedAscending
        }
        
        profiles = loaded
    }
    
    /// Force-reload profiles from Keychain.
    func reload() {
        loadAllProfiles()
    }
    
    /// Flush any in-memory embedding changes to Keychain for all profiles.
    /// Call at app termination or session end to persist EMA updates.
    func persistPendingUpdates() {
        for profile in profiles {
            try? saveProfile(profile)
        }
    }
    
    // MARK: - Vector Math
    
    /// Cosine similarity between two Float vectors using Accelerate.
    private func cosineSimilarity(_ a: [Float], _ b: [Float]) -> Float {
        guard a.count == b.count, !a.isEmpty else { return 0 }
        
        var dotProduct: Float = 0
        var normA: Float = 0
        var normB: Float = 0
        
        vDSP_dotpr(a, 1, b, 1, &dotProduct, vDSP_Length(a.count))
        vDSP_dotpr(a, 1, a, 1, &normA, vDSP_Length(a.count))
        vDSP_dotpr(b, 1, b, 1, &normB, vDSP_Length(b.count))
        
        let denom = sqrt(normA) * sqrt(normB)
        guard denom > 0 else { return 0 }
        return dotProduct / denom
    }
    
    /// L2-normalize a vector using Accelerate.
    /// Returns a unit-length vector (or zero vector if input is zero).
    static func l2Normalize(_ v: [Float]) -> [Float] {
        guard !v.isEmpty else { return v }
        var sumSquares: Float = 0
        vDSP_svesq(v, 1, &sumSquares, vDSP_Length(v.count))
        let norm = sqrt(sumSquares)
        guard norm > 1e-10 else { return v }
        var result = [Float](repeating: 0, count: v.count)
        var divisor = norm
        vDSP_vsdiv(v, 1, &divisor, &result, 1, vDSP_Length(v.count))
        return result
    }
}
