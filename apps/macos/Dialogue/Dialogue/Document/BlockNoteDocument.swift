import SwiftUI
import UniformTypeIdentifiers

// MARK: - UTType for .blocknote files

extension UTType {
    static let blocknote = UTType(exportedAs: "bot.djinn.app.dialog.blocknote")
}

// MARK: - ReferenceFileDocument

/// A document that wraps a `BlockNoteFile` and participates in SwiftUI's `DocumentGroup`.
/// Uses `ReferenceFileDocument` (class-based) so we can mutate from the editor bridge
/// without triggering full SwiftUI redraws on every keystroke.
final class BlockNoteDocument: ReferenceFileDocument, ObservableObject {
    
    // The file content model
    @Published var file: BlockNoteFile
    
    // Track whether we have unsaved changes (for autosave triggering)
    @Published var hasUnsavedChanges = false

    // MARK: - Readable content types

    static var readableContentTypes: [UTType] { [.blocknote] }
    static var writableContentTypes: [UTType] { [.blocknote] }

    // MARK: - Init

    init(file: BlockNoteFile = .empty) {
        self.file = file
    }

    // MARK: - Read from disk

    required init(configuration: ReadConfiguration) throws {
        guard let data = configuration.file.regularFileContents else {
            throw CocoaError(.fileReadCorruptFile)
        }
        self.file = try BlockNoteFile.fromJSON(data)
    }

    // MARK: - Write to disk

    func snapshot(contentType: UTType) throws -> Data {
        try file.toJSON()
    }

    func fileWrapper(snapshot: Data, configuration: WriteConfiguration) throws -> FileWrapper {
        FileWrapper(regularFileWithContents: snapshot)
    }

    // MARK: - Update from editor bridge

    func updateBlocks(from jsonString: String) {
        guard let data = jsonString.data(using: .utf8),
              let blocks = try? JSONDecoder().decode([JSONValue].self, from: data) else {
            return
        }
        file.blocks = blocks
        hasUnsavedChanges = true
    }

    func updateTitle(_ title: String) {
        file.title = title
        hasUnsavedChanges = true
    }
}
