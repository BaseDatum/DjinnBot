import Foundation
import Accelerate

// MARK: - VoiceProfile

/// A named speaker voice profile containing an embedding vector for identification.
struct VoiceProfile: Codable, Identifiable, Equatable {
    let id: String           // Unique identifier (UUID string or "primary-user")
    var displayName: String  // Human-readable name ("You", "Sarah Chen", etc.)
    var embedding: [Float]   // Speaker embedding vector
    let createdAt: Date
    
    /// The reserved identifier for the primary user ("You").
    static let primaryUserID = "primary-user"
    
    var isPrimaryUser: Bool { id == Self.primaryUserID }
}

// MARK: - VoiceProfileManager

/// Manages voice profiles: enrollment, persistence (via Keychain), and speaker matching.
/// Thread-safe — all mutations go through the main actor.
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
    private let matchThreshold: Float = 0.75
    
    private let keychain = KeychainManager.shared
    
    private init() {
        loadAllProfiles()
    }
    
    // MARK: - Profile CRUD
    
    /// Enroll the primary user with a computed embedding.
    func enrollPrimaryUser(embedding: [Float]) throws {
        let profile = VoiceProfile(
            id: VoiceProfile.primaryUserID,
            displayName: "You",
            embedding: embedding,
            createdAt: Date()
        )
        try saveProfile(profile)
    }
    
    /// Create and save a new named speaker profile.
    @discardableResult
    func createProfile(displayName: String, embedding: [Float]) throws -> VoiceProfile {
        let profile = VoiceProfile(
            id: UUID().uuidString,
            displayName: displayName,
            embedding: embedding,
            createdAt: Date()
        )
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
    
    // MARK: - Speaker Matching
    
    /// Find the best matching profile for a given embedding vector.
    /// Returns nil if no profile exceeds the similarity threshold.
    func matchSpeaker(embedding: [Float]) -> VoiceProfile? {
        guard !profiles.isEmpty else { return nil }
        
        var bestProfile: VoiceProfile?
        var bestScore: Float = -1
        
        for profile in profiles {
            let score = cosineSimilarity(embedding, profile.embedding)
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
}
