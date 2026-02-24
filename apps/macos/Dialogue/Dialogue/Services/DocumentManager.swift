import Foundation
import Combine

/// Manages the default documents folder and provides directory listing for the sidebar.
final class DocumentManager: ObservableObject {
    static let shared = DocumentManager()
    
    /// The root folder for Dialogue documents.
    @Published var rootFolder: URL
    
    /// Discovered .blocknote files, grouped by relative folder path.
    @Published var fileTree: [FileTreeNode] = []
    
    private var watcher: DispatchSourceFileSystemObject?
    private let fileManager = FileManager.default
    
    private init() {
        // Default root: ~/Documents/Dialogue
        let docs = fileManager.urls(for: .documentDirectory, in: .userDomainMask).first!
        let defaultRoot = docs.appendingPathComponent("Dialogue", isDirectory: true)
        
        // Ensure the folder exists
        try? fileManager.createDirectory(at: defaultRoot, withIntermediateDirectories: true)
        
        self.rootFolder = defaultRoot
        refresh()
        startWatching()
    }
    
    // MARK: - Public API
    
    /// Change the root folder (e.g., from an open panel).
    func setRootFolder(_ url: URL) {
        stopWatching()
        rootFolder = url
        refresh()
        startWatching()
    }
    
    /// Refresh the file tree by scanning the root folder.
    func refresh() {
        fileTree = scanDirectory(rootFolder)
    }
    
    /// Create a new empty .blocknote document in a given folder (defaults to root).
    func createNewDocument(title: String = "Untitled", in folder: URL? = nil) -> URL? {
        let targetFolder = folder ?? rootFolder
        let file = BlockNoteFile(title: title)
        guard let data = try? file.toJSON() else { return nil }
        
        let name = uniqueFileName(title, in: targetFolder)
        let url = targetFolder.appendingPathComponent(name).appendingPathExtension("blocknote")
        
        do {
            try data.write(to: url, options: .atomic)
            refresh()
            return url
        } catch {
            print("[Dialogue] Failed to create document: \(error)")
            return nil
        }
    }
    
    /// Create a subfolder inside a given parent folder (defaults to root).
    @discardableResult
    func createFolder(named name: String, in parent: URL? = nil) -> URL? {
        let targetParent = parent ?? rootFolder
        let url = targetParent.appendingPathComponent(name, isDirectory: true)
        do {
            try fileManager.createDirectory(at: url, withIntermediateDirectories: true)
            refresh()
            return url
        } catch {
            print("[Dialogue] Failed to create folder: \(error)")
            return nil
        }
    }
    
    /// Returns all folder URLs (flat list) for use in a folder picker.
    func allFolders() -> [(name: String, url: URL)] {
        var result: [(name: String, url: URL)] = [("Documents (root)", rootFolder)]
        collectFolders(in: rootFolder, relativeTo: rootFolder, into: &result)
        return result
    }
    
    private func collectFolders(in directory: URL, relativeTo root: URL, into result: inout [(name: String, url: URL)]) {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ) else { return }
        
        for item in contents.sorted(by: { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }) {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir {
                // Build a display path relative to root
                let relative = item.path.replacingOccurrences(of: root.path, with: "")
                let display = relative.hasPrefix("/") ? String(relative.dropFirst()) : relative
                result.append((display, item))
                collectFolders(in: item, relativeTo: root, into: &result)
            }
        }
    }
    
    /// Rename a file or folder.
    @discardableResult
    func renameItem(at url: URL, to newName: String) -> URL? {
        let isDir = (try? url.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
        let ext = url.pathExtension
        let newFileName: String
        if isDir {
            newFileName = newName
        } else {
            newFileName = ext.isEmpty ? newName : "\(newName).\(ext)"
        }
        let newURL = url.deletingLastPathComponent().appendingPathComponent(newFileName)
        guard newURL != url else { return url }
        do {
            try fileManager.moveItem(at: url, to: newURL)
            refresh()
            return newURL
        } catch {
            print("[Dialogue] Failed to rename: \(error)")
            return nil
        }
    }

    /// Move a file or folder into a destination folder.
    @discardableResult
    func moveItem(at sourceURL: URL, toFolder destinationFolder: URL) -> URL? {
        let destURL = destinationFolder.appendingPathComponent(sourceURL.lastPathComponent)
        // Don't move into itself or same location
        guard destURL != sourceURL,
              !destURL.path.hasPrefix(sourceURL.path + "/") else { return nil }
        // Don't move if already in that folder
        guard sourceURL.deletingLastPathComponent().standardizedFileURL != destinationFolder.standardizedFileURL else { return nil }
        do {
            // If a file with the same name exists, generate a unique name
            var finalURL = destURL
            if fileManager.fileExists(atPath: destURL.path) {
                let baseName = destURL.deletingPathExtension().lastPathComponent
                let ext = destURL.pathExtension
                var counter = 1
                repeat {
                    let newName = ext.isEmpty ? "\(baseName) \(counter)" : "\(baseName) \(counter).\(ext)"
                    finalURL = destinationFolder.appendingPathComponent(newName)
                    counter += 1
                } while fileManager.fileExists(atPath: finalURL.path)
            }
            try fileManager.moveItem(at: sourceURL, to: finalURL)
            refresh()
            return finalURL
        } catch {
            print("[Dialogue] Failed to move item: \(error)")
            return nil
        }
    }

    /// Returns the most recently modified .blocknote file across all folders.
    func mostRecentDocument() -> URL? {
        var best: (url: URL, date: Date)?
        findMostRecent(in: rootFolder, best: &best)
        return best?.url
    }

    private func findMostRecent(in directory: URL, best: inout (url: URL, date: Date)?) {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: directory,
            includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else { return }

        for item in contents {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            if isDir {
                findMostRecent(in: item, best: &best)
            } else if item.pathExtension == "blocknote" {
                let modDate = (try? item.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate ?? .distantPast
                if best == nil || modDate > best!.date {
                    best = (item, modDate)
                }
            }
        }
    }

    /// Delete a file or folder (moves to Trash).
    func deleteItem(at url: URL) {
        do {
            try fileManager.trashItem(at: url, resultingItemURL: nil)
            refresh()
        } catch {
            print("[Dialogue] Failed to delete: \(error)")
        }
    }

    // MARK: - Directory scanning
    
    private func scanDirectory(_ url: URL) -> [FileTreeNode] {
        guard let contents = try? fileManager.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey],
            options: [.skipsHiddenFiles]
        ) else {
            return []
        }
        
        var folders: [FileTreeNode] = []
        var files: [FileTreeNode] = []
        
        for item in contents.sorted(by: { $0.lastPathComponent.localizedStandardCompare($1.lastPathComponent) == .orderedAscending }) {
            let isDir = (try? item.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            
            if isDir {
                let children = scanDirectory(item)
                folders.append(FileTreeNode(url: item, name: item.lastPathComponent, isFolder: true, children: children))
            } else if item.pathExtension == "blocknote" {
                let name = item.deletingPathExtension().lastPathComponent
                files.append(FileTreeNode(url: item, name: name, isFolder: false, children: []))
            }
        }
        
        // Folders always come first
        return folders + files
    }
    
    // MARK: - File system watching
    
    private func startWatching() {
        let fd = open(rootFolder.path, O_EVTONLY)
        guard fd >= 0 else { return }
        
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        
        source.setEventHandler { [weak self] in
            self?.refresh()
        }
        
        source.setCancelHandler {
            close(fd)
        }
        
        source.resume()
        self.watcher = source
    }
    
    private func stopWatching() {
        watcher?.cancel()
        watcher = nil
    }
    
    // MARK: - Helpers
    
    private func uniqueFileName(_ base: String, in folder: URL) -> String {
        var name = base
        var counter = 1
        
        while fileManager.fileExists(atPath: folder.appendingPathComponent("\(name).blocknote").path) {
            name = "\(base) \(counter)"
            counter += 1
        }
        
        return name
    }
}

// MARK: - FileTreeNode

struct FileTreeNode: Identifiable, Hashable {
    let id = UUID()
    let url: URL
    let name: String
    let isFolder: Bool
    var children: [FileTreeNode]
    
    func hash(into hasher: inout Hasher) {
        hasher.combine(url)
    }
    
    static func == (lhs: FileTreeNode, rhs: FileTreeNode) -> Bool {
        lhs.url == rhs.url
    }
}
