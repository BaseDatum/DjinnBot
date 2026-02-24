import SwiftUI
import AppKit
import UniformTypeIdentifiers

// MARK: - SidebarView (SwiftUI wrapper)

/// The sidebar wraps an AppKit NSOutlineView for reliable click handling.
/// The header bar, alerts, and sheets remain SwiftUI.
struct SidebarView: View {
    @ObservedObject var documentManager: DocumentManager
    var onSelectDocument: (URL) -> Void

    @State private var showNewFolderAlert = false
    @State private var newFolderName = ""
    @State private var newFolderParent: URL?

    @State private var showNewDocFolderPicker = false

    @State private var renameURL: URL?
    @State private var renameText = ""
    @State private var showRenameAlert = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            headerView
            Divider()

            FileTreeOutlineView(
                documentManager: documentManager,
                onOpenFile: { url in onSelectDocument(url) },
                onNewDocumentInFolder: { folder in createDocumentInFolder(folder) },
                onNewSubfolder: { parent in
                    newFolderParent = parent
                    newFolderName = ""
                    showNewFolderAlert = true
                },
                onRenameItem: { url, name in
                    renameURL = url
                    renameText = name
                    showRenameAlert = true
                },
                onDeleteItem: { url in documentManager.deleteItem(at: url) }
            )
        }
        .frame(minWidth: 200, idealWidth: 240, maxWidth: 320)
        .alert("New Folder", isPresented: $showNewFolderAlert) {
            TextField("Folder name", text: $newFolderName)
            Button("Create") {
                let name = newFolderName.trimmingCharacters(in: .whitespaces)
                if !name.isEmpty {
                    documentManager.createFolder(named: name, in: newFolderParent)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            if let parent = newFolderParent {
                Text("Create a new folder inside \"\(parent.lastPathComponent)\".")
            } else {
                Text("Enter a name for the new folder.")
            }
        }
        .alert("Rename", isPresented: $showRenameAlert) {
            TextField("New name", text: $renameText)
            Button("Rename") {
                let name = renameText.trimmingCharacters(in: .whitespaces)
                if !name.isEmpty, let url = renameURL {
                    documentManager.renameItem(at: url, to: name)
                }
            }
            Button("Cancel", role: .cancel) {}
        }
        .sheet(isPresented: $showNewDocFolderPicker) {
            FolderPickerSheet(
                documentManager: documentManager,
                onSelect: { folderURL in
                    showNewDocFolderPicker = false
                    createDocumentInFolder(folderURL)
                },
                onCancel: { showNewDocFolderPicker = false }
            )
        }
    }

    private var headerView: some View {
        HStack {
            Text("Documents")
                .font(.headline)
                .foregroundStyle(.secondary)
            Spacer()
            Menu {
                Button("New Document...") { showNewDocFolderPicker = true }
                Button("New Folder...") {
                    newFolderParent = nil
                    newFolderName = ""
                    showNewFolderAlert = true
                }
                Divider()
                Button("Open in Finder") { NSWorkspace.shared.open(documentManager.rootFolder) }
                Button("Choose Folder...") { chooseRootFolder() }
            } label: {
                Image(systemName: "plus").font(.body)
            }
            .menuStyle(.borderlessButton)
            .frame(width: 24)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    private func createDocumentInFolder(_ folder: URL) {
        if let url = documentManager.createNewDocument(in: folder) {
            onSelectDocument(url)
        }
    }

    private func chooseRootFolder() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.message = "Choose a folder for your Dialogue documents"
        if panel.runModal() == .OK, let url = panel.url {
            documentManager.setRootFolder(url)
        }
    }
}

// MARK: - OutlineItem (reference-type wrapper for NSOutlineView)

/// NSOutlineView requires reference-type items. This wraps FileTreeNode.
class OutlineItem: NSObject {
    let url: URL
    let name: String
    let isFolder: Bool
    var children: [OutlineItem]

    init(url: URL, name: String, isFolder: Bool, children: [OutlineItem] = []) {
        self.url = url
        self.name = name
        self.isFolder = isFolder
        self.children = children
    }

    /// Build from a FileTreeNode tree.
    static func from(_ node: FileTreeNode) -> OutlineItem {
        OutlineItem(
            url: node.url,
            name: node.name,
            isFolder: node.isFolder,
            children: node.children.map { OutlineItem.from($0) }
        )
    }

    /// Build array from FileTreeNode array.
    static func from(_ nodes: [FileTreeNode]) -> [OutlineItem] {
        nodes.map { OutlineItem.from($0) }
    }
}

// MARK: - FileTreeOutlineView (NSViewControllerRepresentable)

struct FileTreeOutlineView: NSViewControllerRepresentable {
    @ObservedObject var documentManager: DocumentManager
    var onOpenFile: (URL) -> Void
    var onNewDocumentInFolder: (URL) -> Void
    var onNewSubfolder: (URL) -> Void
    var onRenameItem: (URL, String) -> Void
    var onDeleteItem: (URL) -> Void

    func makeNSViewController(context: Context) -> FileTreeViewController {
        let vc = FileTreeViewController()
        vc.rootItems = OutlineItem.from(documentManager.fileTree)
        vc.onOpenFile = onOpenFile
        vc.onNewDocumentInFolder = onNewDocumentInFolder
        vc.onNewSubfolder = onNewSubfolder
        vc.onRenameItem = onRenameItem
        vc.onDeleteItem = onDeleteItem
        return vc
    }

    func updateNSViewController(_ vc: FileTreeViewController, context: Context) {
        vc.onOpenFile = onOpenFile
        vc.onNewDocumentInFolder = onNewDocumentInFolder
        vc.onNewSubfolder = onNewSubfolder
        vc.onRenameItem = onRenameItem
        vc.onDeleteItem = onDeleteItem

        // Rebuild items from the latest file tree
        let newItems = OutlineItem.from(documentManager.fileTree)
        vc.rootItems = newItems
        vc.outlineView.reloadData()
        vc.restoreExpandedState()
    }
}

// MARK: - FileTreeViewController

class FileTreeViewController: NSViewController, NSOutlineViewDataSource, NSOutlineViewDelegate {
    var outlineView: NSOutlineView!
    var scrollView: NSScrollView!

    var rootItems: [OutlineItem] = []
    var expandedURLs: Set<URL> = []

    // Callbacks to SwiftUI
    var onOpenFile: ((URL) -> Void)?
    var onNewDocumentInFolder: ((URL) -> Void)?
    var onNewSubfolder: ((URL) -> Void)?
    var onRenameItem: ((URL, String) -> Void)?
    var onDeleteItem: ((URL) -> Void)?

    override func loadView() {
        // Create the outline view
        outlineView = NSOutlineView()
        outlineView.style = .sourceList
        outlineView.allowsMultipleSelection = false
        outlineView.headerView = nil
        outlineView.rowHeight = 24

        // Single column
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("Name"))
        column.isEditable = false
        outlineView.addTableColumn(column)
        outlineView.outlineTableColumn = column

        outlineView.dataSource = self
        outlineView.delegate = self

        // Single click = select + toggle folder
        outlineView.target = self
        outlineView.action = #selector(outlineViewSingleClick(_:))

        // Double click = open file
        outlineView.doubleAction = #selector(outlineViewDoubleClick(_:))

        // Drag and drop
        outlineView.registerForDraggedTypes([.fileURL])
        outlineView.setDraggingSourceOperationMask(.move, forLocal: true)

        // Wrap in scroll view
        scrollView = NSScrollView()
        scrollView.documentView = outlineView
        scrollView.hasVerticalScroller = true
        scrollView.autohidesScrollers = true
        scrollView.drawsBackground = false

        self.view = scrollView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
    }

    // MARK: - Click handlers

    @objc private func outlineViewSingleClick(_ sender: NSOutlineView) {
        let row = sender.clickedRow
        guard row >= 0, let item = sender.item(atRow: row) as? OutlineItem else { return }

        if item.isFolder {
            if sender.isItemExpanded(item) {
                sender.animator().collapseItem(item)
                expandedURLs.remove(item.url)
            } else {
                sender.animator().expandItem(item)
                expandedURLs.insert(item.url)
            }
        }
        // Selection highlight happens automatically via NSOutlineView
    }

    @objc private func outlineViewDoubleClick(_ sender: NSOutlineView) {
        let row = sender.clickedRow
        guard row >= 0, let item = sender.item(atRow: row) as? OutlineItem else { return }

        if !item.isFolder {
            onOpenFile?(item.url)
        }
    }

    // MARK: - Expand state tracking

    func restoreExpandedState() {
        restoreExpanded(items: rootItems)
    }

    private func restoreExpanded(items: [OutlineItem]) {
        for item in items {
            if item.isFolder && expandedURLs.contains(item.url) {
                outlineView.expandItem(item)
                restoreExpanded(items: item.children)
            }
        }
    }

    // Track expand/collapse from user interaction
    func outlineViewItemDidExpand(_ notification: Notification) {
        if let item = notification.userInfo?["NSObject"] as? OutlineItem {
            expandedURLs.insert(item.url)
        }
    }

    func outlineViewItemDidCollapse(_ notification: Notification) {
        if let item = notification.userInfo?["NSObject"] as? OutlineItem {
            expandedURLs.remove(item.url)
        }
    }

    // MARK: - Data Source

    func outlineView(_ outlineView: NSOutlineView, numberOfChildrenOfItem item: Any?) -> Int {
        if let outlineItem = item as? OutlineItem {
            return outlineItem.children.count
        }
        return rootItems.count
    }

    func outlineView(_ outlineView: NSOutlineView, child index: Int, ofItem item: Any?) -> Any {
        if let outlineItem = item as? OutlineItem {
            return outlineItem.children[index]
        }
        return rootItems[index]
    }

    func outlineView(_ outlineView: NSOutlineView, isItemExpandable item: Any) -> Bool {
        return (item as? OutlineItem)?.isFolder ?? false
    }

    // MARK: - Delegate (cell views)

    func outlineView(_ outlineView: NSOutlineView, viewFor tableColumn: NSTableColumn?, item: Any) -> NSView? {
        guard let outlineItem = item as? OutlineItem else { return nil }

        let cellID = NSUserInterfaceItemIdentifier("FileCell")
        let cell: NSTableCellView

        if let existing = outlineView.makeView(withIdentifier: cellID, owner: self) as? NSTableCellView {
            cell = existing
        } else {
            cell = NSTableCellView()
            cell.identifier = cellID

            let imageView = NSImageView()
            imageView.translatesAutoresizingMaskIntoConstraints = false
            cell.addSubview(imageView)
            cell.imageView = imageView

            let textField = NSTextField(labelWithString: "")
            textField.translatesAutoresizingMaskIntoConstraints = false
            textField.lineBreakMode = .byTruncatingTail
            textField.cell?.truncatesLastVisibleLine = true
            cell.addSubview(textField)
            cell.textField = textField

            NSLayoutConstraint.activate([
                imageView.leadingAnchor.constraint(equalTo: cell.leadingAnchor, constant: 2),
                imageView.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
                imageView.widthAnchor.constraint(equalToConstant: 16),
                imageView.heightAnchor.constraint(equalToConstant: 16),
                textField.leadingAnchor.constraint(equalTo: imageView.trailingAnchor, constant: 4),
                textField.trailingAnchor.constraint(equalTo: cell.trailingAnchor, constant: -2),
                textField.centerYAnchor.constraint(equalTo: cell.centerYAnchor),
            ])
        }

        cell.textField?.stringValue = outlineItem.name

        if outlineItem.isFolder {
            cell.imageView?.image = NSImage(systemSymbolName: "folder", accessibilityDescription: "Folder")
            cell.imageView?.contentTintColor = .secondaryLabelColor
        } else {
            cell.imageView?.image = NSImage(systemSymbolName: "doc.text", accessibilityDescription: "Document")
            cell.imageView?.contentTintColor = .secondaryLabelColor
        }

        return cell
    }

    // MARK: - Context menu

    func outlineView(_ outlineView: NSOutlineView, menuForItem item: Any?) -> NSMenu? {
        // This delegate method doesn't exist by default — we use a custom approach
        return nil
    }

    // Override right-click via the outline view's menu
    override func viewDidAppear() {
        super.viewDidAppear()
        outlineView.menu = contextMenu()
    }

    private func contextMenu() -> NSMenu {
        let menu = NSMenu()
        menu.delegate = self
        return menu
    }

    // MARK: - Drag and Drop

    func outlineView(_ outlineView: NSOutlineView, pasteboardWriterForItem item: Any) -> NSPasteboardWriting? {
        guard let outlineItem = item as? OutlineItem else { return nil }
        return outlineItem.url as NSURL
    }

    func outlineView(_ outlineView: NSOutlineView, validateDrop info: NSDraggingInfo, proposedItem item: Any?, proposedChildIndex index: Int) -> NSDragOperation {
        // Only allow drops onto folders
        guard let target = item as? OutlineItem, target.isFolder else {
            return []
        }
        return .move
    }

    func outlineView(_ outlineView: NSOutlineView, acceptDrop info: NSDraggingInfo, item: Any?, childIndex index: Int) -> Bool {
        guard let target = item as? OutlineItem, target.isFolder else { return false }
        guard let items = info.draggingPasteboard.readObjects(forClasses: [NSURL.self], options: nil) as? [URL] else { return false }

        for sourceURL in items {
            DocumentManager.shared.moveItem(at: sourceURL, toFolder: target.url)
        }
        return true
    }
}

// MARK: - NSMenuDelegate for context menus

extension FileTreeViewController: NSMenuDelegate {
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()

        let clickedRow = outlineView.clickedRow
        guard clickedRow >= 0, let item = outlineView.item(atRow: clickedRow) as? OutlineItem else {
            return
        }

        // Select the clicked row so context looks right
        outlineView.selectRowIndexes(IndexSet(integer: clickedRow), byExtendingSelection: false)

        if item.isFolder {
            menu.addItem(withTitle: "New Document Here", action: #selector(contextNewDocument(_:)), keyEquivalent: "").target = self
            menu.addItem(withTitle: "New Subfolder...", action: #selector(contextNewSubfolder(_:)), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Rename...", action: #selector(contextRename(_:)), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Show in Finder", action: #selector(contextShowInFinder(_:)), keyEquivalent: "").target = self
            menu.addItem(.separator())
            let deleteItem = menu.addItem(withTitle: "Delete", action: #selector(contextDelete(_:)), keyEquivalent: "")
            deleteItem.target = self
        } else {
            menu.addItem(withTitle: "Open", action: #selector(contextOpenFile(_:)), keyEquivalent: "").target = self
            menu.addItem(.separator())
            menu.addItem(withTitle: "Rename...", action: #selector(contextRename(_:)), keyEquivalent: "").target = self
            menu.addItem(withTitle: "Show in Finder", action: #selector(contextShowInFinder(_:)), keyEquivalent: "").target = self
            menu.addItem(.separator())
            let deleteItem = menu.addItem(withTitle: "Delete", action: #selector(contextDelete(_:)), keyEquivalent: "")
            deleteItem.target = self
        }
    }

    private var clickedItem: OutlineItem? {
        let row = outlineView.clickedRow >= 0 ? outlineView.clickedRow : outlineView.selectedRow
        guard row >= 0 else { return nil }
        return outlineView.item(atRow: row) as? OutlineItem
    }

    @objc private func contextOpenFile(_ sender: Any) {
        guard let item = clickedItem else { return }
        onOpenFile?(item.url)
    }

    @objc private func contextNewDocument(_ sender: Any) {
        guard let item = clickedItem, item.isFolder else { return }
        onNewDocumentInFolder?(item.url)
    }

    @objc private func contextNewSubfolder(_ sender: Any) {
        guard let item = clickedItem, item.isFolder else { return }
        onNewSubfolder?(item.url)
    }

    @objc private func contextRename(_ sender: Any) {
        guard let item = clickedItem else { return }
        onRenameItem?(item.url, item.name)
    }

    @objc private func contextShowInFinder(_ sender: Any) {
        guard let item = clickedItem else { return }
        NSWorkspace.shared.activateFileViewerSelecting([item.url])
    }

    @objc private func contextDelete(_ sender: Any) {
        guard let item = clickedItem else { return }
        onDeleteItem?(item.url)
    }
}

// MARK: - FolderPickerSheet

struct FolderPickerSheet: View {
    @ObservedObject var documentManager: DocumentManager
    var onSelect: (URL) -> Void
    var onCancel: () -> Void

    @State private var selectedFolder: URL?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Choose a folder for the new document")
                .font(.headline)

            List(selection: $selectedFolder) {
                let folders = documentManager.allFolders()
                ForEach(folders, id: \.url) { item in
                    Label(item.name, systemImage: item.url == documentManager.rootFolder ? "folder.badge.gearshape" : "folder")
                        .tag(item.url)
                }
            }
            .listStyle(.bordered)
            .frame(height: 200)

            HStack {
                Spacer()
                Button("Cancel") { onCancel() }
                    .keyboardShortcut(.cancelAction)
                Button("Create") { onSelect(selectedFolder ?? documentManager.rootFolder) }
                    .keyboardShortcut(.defaultAction)
                    .buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .frame(width: 400)
        .onAppear { selectedFolder = documentManager.rootFolder }
    }
}

// MARK: - SelectAllTextField

struct SelectAllTextField: NSViewRepresentable {
    @Binding var text: String
    var onCommit: () -> Void
    var onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }

    func makeNSView(context: Context) -> NSTextField {
        let field = NSTextField()
        field.isBordered = true
        field.isBezeled = true
        field.bezelStyle = .roundedBezel
        field.font = .systemFont(ofSize: NSFont.systemFontSize)
        field.focusRingType = .exterior
        field.delegate = context.coordinator
        field.stringValue = text
        DispatchQueue.main.async {
            field.window?.makeFirstResponder(field)
            field.currentEditor()?.selectAll(nil)
        }
        return field
    }

    func updateNSView(_ nsView: NSTextField, context: Context) {
        if nsView.currentEditor() == nil {
            nsView.stringValue = text
        }
    }

    class Coordinator: NSObject, NSTextFieldDelegate {
        let parent: SelectAllTextField
        init(parent: SelectAllTextField) { self.parent = parent }

        func controlTextDidChange(_ obj: Notification) {
            guard let field = obj.object as? NSTextField else { return }
            parent.text = field.stringValue
        }

        func controlTextDidEndEditing(_ obj: Notification) {
            let trimmed = parent.text.trimmingCharacters(in: .whitespaces)
            if trimmed.isEmpty { parent.onCancel() }
            else { parent.onCommit() }
        }

        func control(_ control: NSControl, textView: NSTextView, doCommandBy commandSelector: Selector) -> Bool {
            if commandSelector == #selector(NSResponder.cancelOperation(_:)) {
                parent.onCancel()
                return true
            }
            return false
        }
    }
}
