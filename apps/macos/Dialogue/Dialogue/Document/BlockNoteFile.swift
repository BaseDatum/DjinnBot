import Foundation

/// The on-disk representation of a `.blocknote` document.
/// JSON format: `{ "version": 1, "title": "...", "blocks": [...] }`
struct BlockNoteFile: Codable, Equatable {
    static let currentVersion = 1

    var version: Int
    var title: String
    var blocks: [JSONValue]

    init(version: Int = Self.currentVersion, title: String = "Untitled", blocks: [JSONValue] = []) {
        self.version = version
        self.title = title
        self.blocks = blocks
    }

    // MARK: - Default empty document

    static var empty: BlockNoteFile {
        BlockNoteFile(
            title: "Untitled",
            blocks: [
                .object([
                    "type": .string("paragraph"),
                    "content": .array([]),
                ])
            ]
        )
    }

    // MARK: - Serialization

    func toJSON() throws -> Data {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        return try encoder.encode(self)
    }

    static func fromJSON(_ data: Data) throws -> BlockNoteFile {
        let decoder = JSONDecoder()
        return try decoder.decode(BlockNoteFile.self, from: data)
    }

    /// Returns the blocks array as a JSON string for injection into JS.
    func blocksJSONString() -> String? {
        guard let data = try? JSONEncoder().encode(blocks) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

// MARK: - JSONValue (type-erased JSON for BlockNote blocks)

/// A type-erased JSON value that faithfully round-trips any BlockNote block structure.
enum JSONValue: Codable, Equatable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case object([String: JSONValue])
    case array([JSONValue])
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()

        if container.decodeNil() {
            self = .null
        } else if let bool = try? container.decode(Bool.self) {
            self = .bool(bool)
        } else if let num = try? container.decode(Double.self) {
            self = .number(num)
        } else if let str = try? container.decode(String.self) {
            self = .string(str)
        } else if let arr = try? container.decode([JSONValue].self) {
            self = .array(arr)
        } else if let obj = try? container.decode([String: JSONValue].self) {
            self = .object(obj)
        } else {
            throw DecodingError.typeMismatch(
                JSONValue.self,
                DecodingError.Context(codingPath: decoder.codingPath, debugDescription: "Unsupported JSON type")
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .string(let s): try container.encode(s)
        case .number(let n): try container.encode(n)
        case .bool(let b):   try container.encode(b)
        case .object(let o): try container.encode(o)
        case .array(let a):  try container.encode(a)
        case .null:          try container.encodeNil()
        }
    }
}
