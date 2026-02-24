import Foundation
import Security

/// Manages secure storage of API keys in the macOS Keychain.
/// Uses raw Security framework APIs (no third-party dependencies).
final class KeychainManager {
    static let shared = KeychainManager()
    
    private let service = "bot.djinn.app.dialog.ai"
    private let account = "api-key"
    
    private init() {}
    
    // MARK: - Save
    
    func saveAPIKey(_ key: String) throws {
        guard let data = key.data(using: .utf8) else {
            throw KeychainError.encodingFailed
        }
        
        // Delete existing item first (update = delete + add)
        try? deleteAPIKey()
        
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecValueData as String:   data,
            kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlocked,
        ]
        
        let status = SecItemAdd(query as CFDictionary, nil)
        guard status == errSecSuccess else {
            throw KeychainError.saveFailed(status)
        }
    }
    
    // MARK: - Read
    
    func getAPIKey() throws -> String? {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String:  true,
            kSecMatchLimit as String:  kSecMatchLimitOne,
        ]
        
        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        
        switch status {
        case errSecSuccess:
            guard let data = result as? Data,
                  let key = String(data: data, encoding: .utf8) else {
                throw KeychainError.decodingFailed
            }
            return key
        case errSecItemNotFound:
            return nil
        default:
            throw KeychainError.readFailed(status)
        }
    }
    
    // MARK: - Delete
    
    func deleteAPIKey() throws {
        let query: [String: Any] = [
            kSecClass as String:       kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.deleteFailed(status)
        }
    }
    
    // MARK: - Convenience
    
    var hasAPIKey: Bool {
        (try? getAPIKey()) != nil
    }
}

// MARK: - Errors

enum KeychainError: LocalizedError {
    case encodingFailed
    case decodingFailed
    case saveFailed(OSStatus)
    case readFailed(OSStatus)
    case deleteFailed(OSStatus)
    
    var errorDescription: String? {
        switch self {
        case .encodingFailed:      return "Failed to encode API key"
        case .decodingFailed:      return "Failed to decode API key from Keychain"
        case .saveFailed(let s):   return "Keychain save failed (status: \(s))"
        case .readFailed(let s):   return "Keychain read failed (status: \(s))"
        case .deleteFailed(let s): return "Keychain delete failed (status: \(s))"
        }
    }
}
