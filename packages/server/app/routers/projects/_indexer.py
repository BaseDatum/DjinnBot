"""Python-native code knowledge graph indexer.

Replaces the Node.js subprocess approach. Uses tree-sitter Python bindings
for AST parsing and kuzu for graph storage. Runs in-process in the API server.
"""

import os
import re
import subprocess
from pathlib import Path
from collections import defaultdict
from typing import Optional

from app.logging_config import get_logger

logger = get_logger(__name__)

# ── Language support ───────────────────────────────────────────────────────

EXTENSION_MAP: dict[str, str] = {
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".cc": "cpp",
    ".cxx": "cpp",
    ".hpp": "cpp",
    ".hh": "cpp",
    ".cs": "c_sharp",
    ".rb": "ruby",
}

IGNORE_DIRS = {
    "node_modules",
    ".git",
    ".svn",
    ".hg",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    ".output",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    "target",
    "vendor",
    ".cargo",
    ".gradle",
    ".idea",
    ".vscode",
    "coverage",
    ".turbo",
    ".cache",
    "tmp",
    "temp",
    ".code-graph",
}

MAX_FILE_SIZE = 1_024_000  # 1MB


# ── File scanning ──────────────────────────────────────────────────────────


def scan_files(repo_path: str) -> list[str]:
    """Return relative paths of parseable source files."""
    root = Path(repo_path)
    is_git = (root / ".git").exists()

    if is_git:
        try:
            result = subprocess.run(
                ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
                cwd=repo_path,
                capture_output=True,
                text=True,
                check=True,
            )
            paths = [
                l.strip()
                for l in result.stdout.split("\n")
                if l.strip() and _is_parseable(root, l.strip())
            ]
            return paths
        except Exception:
            pass

    # Fallback: recursive walk
    paths = []
    for dirpath, dirnames, filenames in os.walk(repo_path):
        dirnames[:] = [
            d for d in dirnames if d not in IGNORE_DIRS and not d.startswith(".")
        ]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            rel = os.path.relpath(fp, repo_path)
            if _is_parseable(root, rel):
                paths.append(rel)
    return paths


def _is_parseable(root: Path, rel_path: str) -> bool:
    ext = os.path.splitext(rel_path)[1].lower()
    if ext not in EXTENSION_MAP:
        return False
    try:
        size = (root / rel_path).stat().st_size
        return size <= MAX_FILE_SIZE
    except OSError:
        return False


# ── AST parsing ────────────────────────────────────────────────────────────


def _get_parser(language: str):
    """Get a tree-sitter parser for a language."""
    try:
        from tree_sitter_language_pack import get_parser

        return get_parser(language)
    except Exception as e:
        logger.debug(f"No parser for {language}: {e}")
        return None


class Symbol:
    __slots__ = (
        "name",
        "label",
        "file_path",
        "start_line",
        "end_line",
        "is_exported",
        "language",
        "content",
    )

    def __init__(
        self,
        name: str,
        label: str,
        file_path: str,
        start_line: int,
        end_line: int,
        is_exported: bool,
        language: str,
        content: str = "",
    ):
        self.name = name
        self.label = label
        self.file_path = file_path
        self.start_line = start_line
        self.end_line = end_line
        self.is_exported = is_exported
        self.language = language
        self.content = content[:500]


class ImportRef:
    __slots__ = ("file_path", "imported_name", "imported_from")

    def __init__(self, file_path: str, imported_name: str, imported_from: str):
        self.file_path = file_path
        self.imported_name = imported_name
        self.imported_from = imported_from


class CallRef:
    __slots__ = ("caller_file", "caller_name", "callee_name", "line")

    def __init__(self, caller_file: str, caller_name: str, callee_name: str, line: int):
        self.caller_file = caller_file
        self.caller_name = caller_name
        self.callee_name = callee_name
        self.line = line


class HeritageRef:
    __slots__ = ("file_path", "child_name", "parent_name", "type")

    def __init__(self, file_path: str, child_name: str, parent_name: str, type_: str):
        self.file_path = file_path
        self.child_name = child_name
        self.parent_name = parent_name
        self.type = type_


def parse_file(
    file_path: str, content: str, language: str
) -> tuple[list[Symbol], list[ImportRef], list[CallRef], list[HeritageRef]]:
    """Parse a source file and extract symbols, imports, calls, heritage."""
    parser = _get_parser(language)
    if not parser:
        return [], [], [], []

    try:
        tree = parser.parse(content.encode("utf-8"))
    except Exception as e:
        logger.debug(f"Parse failed for {file_path}: {e}")
        return [], [], [], []

    symbols: list[Symbol] = []
    imports: list[ImportRef] = []
    calls: list[CallRef] = []
    heritage: list[HeritageRef] = []

    root = tree.root_node

    if language in ("typescript", "tsx", "javascript"):
        _extract_js(
            root, file_path, content, language, symbols, imports, calls, heritage
        )
    elif language == "python":
        _extract_python(
            root, file_path, content, language, symbols, imports, calls, heritage
        )
    elif language == "go":
        _extract_go(
            root, file_path, content, language, symbols, imports, calls, heritage
        )
    elif language == "rust":
        _extract_rust(
            root, file_path, content, language, symbols, imports, calls, heritage
        )
    elif language == "java":
        _extract_java(
            root, file_path, content, language, symbols, imports, calls, heritage
        )
    elif language in ("c", "cpp"):
        _extract_c(
            root, file_path, content, language, symbols, imports, calls, heritage
        )
    else:
        # Generic: extract via regex fallback
        _extract_regex(file_path, content, language, symbols)

    return symbols, imports, calls, heritage


def _find_enclosing_function(node) -> Optional[str]:
    """Walk up the AST to find the enclosing function/method name."""
    cur = node.parent
    func_types = {
        "function_declaration",
        "function_definition",
        "method_declaration",
        "method_definition",
        "function_item",
        "arrow_function",
    }
    while cur:
        if cur.type in func_types:
            name_node = cur.child_by_field_name("name")
            if name_node:
                return name_node.text.decode("utf-8")
        cur = cur.parent
    return None


# ── JS/TS extractor ───────────────────────────────────────────────────────


def _is_js_exported(node) -> bool:
    p = node.parent
    return p is not None and p.type in (
        "export_statement",
        "export_default_declaration",
    )


def _extract_js(root, fp, content, lang, symbols, imports, calls, heritage):
    """Extract from TypeScript/JavaScript AST."""
    _walk_js(root, fp, lang, symbols, imports, calls, heritage, None)


def _walk_js(node, fp, lang, symbols, imports, calls, heritage, parent_class):
    t = node.type

    if t == "function_declaration":
        name_node = node.child_by_field_name("name")
        if name_node:
            symbols.append(
                Symbol(
                    name_node.text.decode(),
                    "Function",
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    _is_js_exported(node),
                    lang,
                    node.text.decode()[:500],
                )
            )

    if t in ("lexical_declaration", "variable_declaration"):
        for child in node.named_children:
            if child.type == "variable_declarator":
                nn = child.child_by_field_name("name")
                val = child.child_by_field_name("value")
                if nn and val and val.type in ("arrow_function", "function_expression"):
                    symbols.append(
                        Symbol(
                            nn.text.decode(),
                            "Function",
                            fp,
                            node.start_point[0] + 1,
                            node.end_point[0] + 1,
                            _is_js_exported(node),
                            lang,
                            node.text.decode()[:500],
                        )
                    )

    if t == "class_declaration":
        name_node = node.child_by_field_name("name")
        if name_node:
            cls_name = name_node.text.decode()
            exported = _is_js_exported(node)
            symbols.append(
                Symbol(
                    cls_name,
                    "Class",
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    exported,
                    lang,
                    node.text.decode()[:500],
                )
            )
            # Heritage
            sc = node.child_by_field_name("superclass")
            if not sc:
                for c in node.children:
                    if c.type == "extends_clause" and c.named_children:
                        heritage.append(
                            HeritageRef(
                                fp,
                                cls_name,
                                c.named_children[0].text.decode(),
                                "extends",
                            )
                        )
                        break
            elif sc:
                heritage.append(HeritageRef(fp, cls_name, sc.text.decode(), "extends"))

            # Methods
            body = node.child_by_field_name("body")
            if body:
                for member in body.named_children:
                    if member.type == "method_definition":
                        mn = member.child_by_field_name("name")
                        if mn and mn.text.decode() != "constructor":
                            symbols.append(
                                Symbol(
                                    f"{cls_name}.{mn.text.decode()}",
                                    "Method",
                                    fp,
                                    member.start_point[0] + 1,
                                    member.end_point[0] + 1,
                                    exported,
                                    lang,
                                    member.text.decode()[:500],
                                )
                            )

    if t == "interface_declaration":
        nn = node.child_by_field_name("name")
        if nn:
            symbols.append(
                Symbol(
                    nn.text.decode(),
                    "Interface",
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    _is_js_exported(node),
                    lang,
                )
            )

    if t == "import_statement":
        source = node.child_by_field_name("source")
        if source:
            from_str = source.text.decode().strip("'\"")
            for child in node.named_children:
                if child.type == "import_clause":
                    for spec in child.named_children:
                        if spec.type == "identifier":
                            imports.append(ImportRef(fp, spec.text.decode(), from_str))
                        elif spec.type == "named_imports":
                            for named in spec.named_children:
                                if named.type == "import_specifier":
                                    nn = named.child_by_field_name("name") or (
                                        named.named_children[0]
                                        if named.named_children
                                        else None
                                    )
                                    if nn:
                                        imports.append(
                                            ImportRef(fp, nn.text.decode(), from_str)
                                        )

    if t == "call_expression":
        func_node = node.child_by_field_name("function")
        if func_node:
            enc = _find_enclosing_function(node)
            calls.append(
                CallRef(
                    fp,
                    enc or "<module>",
                    func_node.text.decode(),
                    node.start_point[0] + 1,
                )
            )

    if t == "export_statement":
        decl = node.child_by_field_name("declaration")
        if decl:
            _walk_js(decl, fp, lang, symbols, imports, calls, heritage, parent_class)
            return

    for child in node.named_children:
        _walk_js(child, fp, lang, symbols, imports, calls, heritage, parent_class)


# ── Python extractor ──────────────────────────────────────────────────────


def _extract_python(root, fp, content, lang, symbols, imports, calls, heritage):
    _walk_python(root, fp, lang, symbols, imports, calls, heritage, None)


def _walk_python(node, fp, lang, symbols, imports, calls, heritage, parent_class):
    t = node.type

    if t == "function_definition":
        nn = node.child_by_field_name("name")
        if nn:
            name = nn.text.decode()
            is_method = parent_class is not None
            full = f"{parent_class}.{name}" if is_method else name
            symbols.append(
                Symbol(
                    full,
                    "Method" if is_method else "Function",
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    not name.startswith("_"),
                    lang,
                    node.text.decode()[:500],
                )
            )

    if t == "class_definition":
        nn = node.child_by_field_name("name")
        if nn:
            cls_name = nn.text.decode()
            symbols.append(
                Symbol(
                    cls_name,
                    "Class",
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    not cls_name.startswith("_"),
                    lang,
                    node.text.decode()[:500],
                )
            )
            sc = node.child_by_field_name("superclasses")
            if sc:
                for arg in sc.named_children:
                    heritage.append(
                        HeritageRef(fp, cls_name, arg.text.decode(), "extends")
                    )
            body = node.child_by_field_name("body")
            if body:
                for child in body.named_children:
                    _walk_python(
                        child, fp, lang, symbols, imports, calls, heritage, cls_name
                    )
                return

    if t in ("import_statement", "import_from_statement"):
        if t == "import_from_statement":
            mod = node.child_by_field_name("module_name")
            from_str = mod.text.decode() if mod else ""
            for child in node.named_children:
                if child.type == "dotted_name" and child != mod:
                    imports.append(ImportRef(fp, child.text.decode(), from_str))
                elif child.type == "aliased_import":
                    nn = child.child_by_field_name("name")
                    if nn:
                        imports.append(ImportRef(fp, nn.text.decode(), from_str))

    if t == "call":
        func_node = node.child_by_field_name("function")
        if func_node:
            enc = _find_enclosing_function(node)
            calls.append(
                CallRef(
                    fp,
                    enc or "<module>",
                    func_node.text.decode(),
                    node.start_point[0] + 1,
                )
            )

    for child in node.named_children:
        if not (t == "class_definition" and child.type == "block"):
            _walk_python(
                child, fp, lang, symbols, imports, calls, heritage, parent_class
            )


# ── Go extractor ──────────────────────────────────────────────────────────


def _extract_go(root, fp, content, lang, symbols, imports, calls, heritage):
    for child in root.named_children:
        _walk_go(child, fp, lang, symbols, calls)


def _walk_go(node, fp, lang, symbols, calls):
    t = node.type

    if t == "function_declaration":
        nn = node.child_by_field_name("name")
        if nn:
            name = nn.text.decode()
            symbols.append(
                Symbol(
                    name,
                    "Function",
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    name[0].isupper() if name else False,
                    lang,
                    node.text.decode()[:500],
                )
            )

    if t == "method_declaration":
        nn = node.child_by_field_name("name")
        if nn:
            recv = node.child_by_field_name("receiver")
            recv_type = ""
            if recv and recv.named_children:
                type_node = recv.named_children[0].child_by_field_name("type")
                if type_node:
                    recv_type = type_node.text.decode().lstrip("*")
            name = nn.text.decode()
            full = f"{recv_type}.{name}" if recv_type else name
            symbols.append(
                Symbol(
                    full,
                    "Method",
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    name[0].isupper() if name else False,
                    lang,
                )
            )

    if t == "type_declaration":
        for spec in node.named_children:
            if spec.type == "type_spec":
                nn = spec.child_by_field_name("name")
                type_node = spec.child_by_field_name("type")
                if nn:
                    label = (
                        "Interface"
                        if type_node and type_node.type == "interface_type"
                        else "Class"
                    )
                    name = nn.text.decode()
                    symbols.append(
                        Symbol(
                            name,
                            label,
                            fp,
                            node.start_point[0] + 1,
                            node.end_point[0] + 1,
                            name[0].isupper() if name else False,
                            lang,
                        )
                    )

    if t == "call_expression":
        func_node = node.child_by_field_name("function")
        if func_node:
            enc = _find_enclosing_function(node)
            calls.append(
                CallRef(
                    fp,
                    enc or "<module>",
                    func_node.text.decode(),
                    node.start_point[0] + 1,
                )
            )

    for child in node.named_children:
        _walk_go(child, fp, lang, symbols, calls)


# ── Rust/Java/C extractors (simplified) ──────────────────────────────────


def _extract_rust(root, fp, content, lang, symbols, imports, calls, heritage):
    _walk_generic(
        root,
        fp,
        lang,
        symbols,
        calls,
        {
            "function_item": "Function",
            "struct_item": "Class",
            "enum_item": "Class",
            "trait_item": "Interface",
            "impl_item": "Class",
        },
    )


def _extract_java(root, fp, content, lang, symbols, imports, calls, heritage):
    _walk_generic(
        root,
        fp,
        lang,
        symbols,
        calls,
        {
            "method_declaration": "Method",
            "class_declaration": "Class",
            "interface_declaration": "Interface",
            "constructor_declaration": "Method",
        },
    )


def _extract_c(root, fp, content, lang, symbols, imports, calls, heritage):
    _walk_generic(
        root,
        fp,
        lang,
        symbols,
        calls,
        {
            "function_definition": "Function",
            "struct_specifier": "Class",
            "class_specifier": "Class",
            "enum_specifier": "Class",
        },
    )


def _walk_generic(node, fp, lang, symbols, calls, type_map: dict):
    t = node.type
    if t in type_map:
        nn = node.child_by_field_name("name")
        if nn:
            name = nn.text.decode()
            symbols.append(
                Symbol(
                    name,
                    type_map[t],
                    fp,
                    node.start_point[0] + 1,
                    node.end_point[0] + 1,
                    True,
                    lang,
                    node.text.decode()[:500],
                )
            )

    if t == "call_expression":
        func_node = node.child_by_field_name("function")
        if func_node:
            enc = _find_enclosing_function(node)
            calls.append(
                CallRef(
                    fp,
                    enc or "<module>",
                    func_node.text.decode(),
                    node.start_point[0] + 1,
                )
            )

    for child in node.named_children:
        _walk_generic(child, fp, lang, symbols, calls, type_map)


# ── Regex fallback ────────────────────────────────────────────────────────


def _extract_regex(fp, content, lang, symbols):
    """Fallback: extract basic function/class signatures via regex."""
    for i, line in enumerate(content.split("\n"), 1):
        m = re.match(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)", line)
        if m:
            symbols.append(Symbol(m.group(1), "Function", fp, i, i, True, lang))
            continue
        m = re.match(r"^\s*(?:export\s+)?class\s+(\w+)", line)
        if m:
            symbols.append(Symbol(m.group(1), "Class", fp, i, i, True, lang))
            continue
        m = re.match(r"^\s*def\s+(\w+)", line)
        if m:
            symbols.append(Symbol(m.group(1), "Function", fp, i, i, True, lang))


# ── Graph building ─────────────────────────────────────────────────────────


def _esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")


def build_graph(
    repo_path: str,
    db_path: str,
    on_progress=None,
) -> dict:
    """Full indexing pipeline: scan → parse → resolve → store.

    Returns stats dict with nodeCount, relationshipCount, etc.
    """
    import kuzu

    if on_progress:
        on_progress("scanning", 0, "Scanning repository...")

    files = scan_files(repo_path)
    total = len(files)

    if on_progress:
        on_progress("scanning", 10, f"Found {total} source files")

    # Parse all files
    all_symbols: list[Symbol] = []
    all_imports: list[ImportRef] = []
    all_calls: list[CallRef] = []
    all_heritage: list[HeritageRef] = []

    for i, rel_path in enumerate(files):
        if on_progress and i % 50 == 0:
            pct = 10 + int((i / max(total, 1)) * 50)
            on_progress("parsing", pct, f"Parsing {rel_path}")

        ext = os.path.splitext(rel_path)[1].lower()
        lang = EXTENSION_MAP.get(ext)
        if not lang:
            continue

        try:
            full = os.path.join(repo_path, rel_path)
            content = Path(full).read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue

        syms, imps, cls, hrt = parse_file(rel_path, content, lang)
        all_symbols.extend(syms)
        all_imports.extend(imps)
        all_calls.extend(cls)
        all_heritage.extend(hrt)

    if on_progress:
        on_progress(
            "parsing", 60, f"Parsed {total} files, {len(all_symbols)} symbols found"
        )

    # ── Build symbol lookup ─────────────────────────────────────────────
    sym_by_name: dict[str, list[Symbol]] = defaultdict(list)
    sym_by_file: dict[str, list[Symbol]] = defaultdict(list)
    for s in all_symbols:
        sym_by_name[s.name].append(s)
        sym_by_file[s.file_path].append(s)

    # ── Write to KuzuDB ────────────────────────────────────────────────
    if on_progress:
        on_progress("storing", 65, "Initializing KuzuDB...")

    os.makedirs(db_path, exist_ok=True)
    # Remove old DB if exists
    import shutil

    if os.path.exists(db_path):
        shutil.rmtree(db_path, ignore_errors=True)
        os.makedirs(db_path, exist_ok=True)

    db = kuzu.Database(db_path)
    conn = kuzu.Connection(db)

    # Create schema
    for label in [
        "File",
        "Folder",
        "Function",
        "Class",
        "Method",
        "Interface",
        "CodeElement",
        "Community",
        "Process",
    ]:
        if label in ("File", "Folder"):
            conn.execute(
                f"CREATE NODE TABLE `{label}` (id STRING, name STRING, filePath STRING, PRIMARY KEY (id))"
            )
        elif label == "Community":
            conn.execute(
                "CREATE NODE TABLE Community (id STRING, name STRING, heuristicLabel STRING, "
                "cohesion DOUBLE, symbolCount INT32, PRIMARY KEY (id))"
            )
        elif label == "Process":
            conn.execute(
                "CREATE NODE TABLE Process (id STRING, name STRING, heuristicLabel STRING, "
                "processType STRING, stepCount INT32, entryPointId STRING, terminalId STRING, "
                "PRIMARY KEY (id))"
            )
        else:
            conn.execute(
                f"CREATE NODE TABLE `{label}` (id STRING, name STRING, filePath STRING, "
                f"startLine INT64, endLine INT64, isExported BOOLEAN, content STRING, "
                f"language STRING, PRIMARY KEY (id))"
            )

    # Build FROM/TO pairs for CodeRelation
    all_labels = [
        "File",
        "Folder",
        "Function",
        "Class",
        "Method",
        "Interface",
        "CodeElement",
        "Community",
        "Process",
    ]
    pairs = ", ".join(f"FROM `{a}` TO `{b}`" for a in all_labels for b in all_labels)
    conn.execute(
        f"CREATE REL TABLE CodeRelation ({pairs}, type STRING, confidence DOUBLE, "
        f"reason STRING, step INT32)"
    )

    if on_progress:
        on_progress("storing", 70, "Inserting file nodes...")

    # Insert File nodes
    folder_set = set()
    for fp in files:
        name = fp.split("/")[-1]
        try:
            conn.execute(
                f"CREATE (:File {{id: 'File:{_esc(fp)}', name: '{_esc(name)}', filePath: '{_esc(fp)}'}})"
            )
        except Exception:
            pass
        parts = fp.split("/")
        for i in range(1, len(parts)):
            folder = "/".join(parts[:i])
            folder_set.add(folder)

    for folder in folder_set:
        name = folder.split("/")[-1]
        try:
            conn.execute(
                f"CREATE (:Folder {{id: 'Folder:{_esc(folder)}', name: '{_esc(name)}', filePath: '{_esc(folder)}'}})"
            )
        except Exception:
            pass

    if on_progress:
        on_progress("storing", 75, f"Inserting {len(all_symbols)} symbol nodes...")

    # Insert symbol nodes
    node_labels: dict[str, str] = {}  # node_id → label
    for sym in all_symbols:
        node_id = f"{sym.label}:{sym.name}:{sym.file_path}"
        label = sym.label
        if label not in all_labels:
            label = "CodeElement"
        node_labels[node_id] = label
        try:
            conn.execute(
                f"CREATE (:`{label}` {{id: '{_esc(node_id)}', name: '{_esc(sym.name)}', "
                f"filePath: '{_esc(sym.file_path)}', startLine: {sym.start_line}, "
                f"endLine: {sym.end_line}, isExported: {str(sym.is_exported).lower()}, "
                f"content: '{_esc(sym.content)}', language: '{_esc(sym.language)}'}})"
            )
        except Exception:
            pass

        # DEFINES edge
        try:
            conn.execute(
                f"MATCH (a:File {{id: 'File:{_esc(sym.file_path)}'}}), "
                f"(b:`{label}` {{id: '{_esc(node_id)}'}}) "
                f"CREATE (a)-[:CodeRelation {{type: 'DEFINES', confidence: 1.0, reason: 'ast', step: 0}}]->(b)"
            )
        except Exception:
            pass

    if on_progress:
        on_progress("resolving", 80, "Resolving imports and calls...")

    # Resolve calls (simple: same-name matching)
    call_edges = 0
    for call in all_calls:
        callee = (
            call.callee_name.split(".")[-1]
            if "." in call.callee_name
            else call.callee_name
        )
        targets = sym_by_name.get(callee, [])
        if not targets:
            continue
        # Prefer same file, then exported
        best = next((t for t in targets if t.file_path == call.caller_file), None)
        if not best:
            best = next((t for t in targets if t.is_exported), None)
        if not best:
            best = targets[0]
        # Find caller
        callers = sym_by_name.get(call.caller_name, [])
        caller = next((c for c in callers if c.file_path == call.caller_file), None)
        if not caller:
            continue
        src_id = f"{caller.label}:{caller.name}:{caller.file_path}"
        tgt_id = f"{best.label}:{best.name}:{best.file_path}"
        src_label = node_labels.get(src_id)
        tgt_label = node_labels.get(tgt_id)
        if not src_label or not tgt_label:
            continue
        conf = 0.95 if best.file_path == call.caller_file else 0.7
        try:
            conn.execute(
                f"MATCH (a:`{src_label}` {{id: '{_esc(src_id)}'}}), "
                f"(b:`{tgt_label}` {{id: '{_esc(tgt_id)}'}}) "
                f"CREATE (a)-[:CodeRelation {{type: 'CALLS', confidence: {conf}, "
                f"reason: 'call-resolve', step: 0}}]->(b)"
            )
            call_edges += 1
        except Exception:
            pass

    # Heritage edges
    for h in all_heritage:
        child_syms = [
            s for s in sym_by_name.get(h.child_name, []) if s.file_path == h.file_path
        ]
        parent_syms = sym_by_name.get(h.parent_name, [])
        if not child_syms or not parent_syms:
            continue
        child = child_syms[0]
        parent = (
            next((p for p in parent_syms if p.file_path == h.file_path), None)
            or parent_syms[0]
        )
        src_id = f"{child.label}:{child.name}:{child.file_path}"
        tgt_id = f"{parent.label}:{parent.name}:{parent.file_path}"
        src_l = node_labels.get(src_id)
        tgt_l = node_labels.get(tgt_id)
        if not src_l or not tgt_l:
            continue
        edge_type = "EXTENDS" if h.type == "extends" else "IMPLEMENTS"
        try:
            conn.execute(
                f"MATCH (a:`{src_l}` {{id: '{_esc(src_id)}'}}), "
                f"(b:`{tgt_l}` {{id: '{_esc(tgt_id)}'}}) "
                f"CREATE (a)-[:CodeRelation {{type: '{edge_type}', confidence: 0.9, "
                f"reason: 'heritage', step: 0}}]->(b)"
            )
        except Exception:
            pass

    if on_progress:
        on_progress("communities", 85, "Detecting communities...")

    # ── Simple community detection (connected components via calls) ─────
    # Build adjacency from calls
    adj: dict[str, set[str]] = defaultdict(set)
    for call in all_calls:
        callee = (
            call.callee_name.split(".")[-1]
            if "." in call.callee_name
            else call.callee_name
        )
        targets = sym_by_name.get(callee, [])
        callers = [
            c
            for c in sym_by_name.get(call.caller_name, [])
            if c.file_path == call.caller_file
        ]
        if targets and callers:
            src = f"{callers[0].label}:{callers[0].name}:{callers[0].file_path}"
            tgt = f"{targets[0].label}:{targets[0].name}:{targets[0].file_path}"
            adj[src].add(tgt)
            adj[tgt].add(src)

    visited: set[str] = set()
    communities: list[list[str]] = []
    for node_id in node_labels:
        if node_id in visited:
            continue
        component: list[str] = []
        queue = [node_id]
        visited.add(node_id)
        while queue:
            cur = queue.pop(0)
            component.append(cur)
            for nb in adj.get(cur, set()):
                if nb not in visited and nb in node_labels:
                    visited.add(nb)
                    queue.append(nb)
        if len(component) >= 2:
            communities.append(component)

    # Insert community nodes
    for i, members in enumerate(communities):
        cid = f"community_{i}"
        # Heuristic label from common directory
        dir_counts: dict[str, int] = defaultdict(int)
        for m in members:
            parts = m.split(":")
            if len(parts) >= 3:
                fp = parts[2]
                dirs = fp.split("/")
                for d in dirs[:-1]:
                    if d and d not in ("src", "lib", "app", "pkg", "internal"):
                        dir_counts[d] += 1
        label = (
            max(dir_counts, key=dir_counts.get, default=f"Group {i}")
            if dir_counts
            else f"Group {i}"
        )
        label = label[0].upper() + label[1:] if label else f"Group {i}"
        try:
            conn.execute(
                f"CREATE (:Community {{id: '{cid}', name: 'Community {i}', "
                f"heuristicLabel: '{_esc(label)}', cohesion: 0.0, symbolCount: {len(members)}}})"
            )
        except Exception:
            pass

        for m in members:
            m_label = node_labels.get(m)
            if not m_label:
                continue
            try:
                conn.execute(
                    f"MATCH (a:`{m_label}` {{id: '{_esc(m)}'}}), (c:Community {{id: '{cid}'}}) "
                    f"CREATE (a)-[:CodeRelation {{type: 'MEMBER_OF', confidence: 1.0, reason: 'community', step: 0}}]->(c)"
                )
            except Exception:
                pass

    if on_progress:
        on_progress("processes", 90, "Detecting execution flows...")

    # ── Simple process detection ────────────────────────────────────────
    # Find entry points: symbols with no callers but with callees
    callers_map: dict[str, set[str]] = defaultdict(set)
    callees_map: dict[str, set[str]] = defaultdict(set)
    for call in all_calls:
        callee = (
            call.callee_name.split(".")[-1]
            if "." in call.callee_name
            else call.callee_name
        )
        targets = sym_by_name.get(callee, [])
        callers_list = [
            c
            for c in sym_by_name.get(call.caller_name, [])
            if c.file_path == call.caller_file
        ]
        if targets and callers_list:
            src_id = f"{callers_list[0].label}:{callers_list[0].name}:{callers_list[0].file_path}"
            tgt_id = f"{targets[0].label}:{targets[0].name}:{targets[0].file_path}"
            callees_map[src_id].add(tgt_id)
            callers_map[tgt_id].add(src_id)

    entry_points = []
    for nid in node_labels:
        if nid not in callers_map and nid in callees_map:
            entry_points.append(nid)
    # Also name-based
    for nid in node_labels:
        name_part = nid.split(":")[1] if ":" in nid else ""
        if re.match(
            r"^(main|handler|route|middleware|serve|listen|app|init|bootstrap)$",
            name_part,
            re.I,
        ):
            if nid not in entry_points:
                entry_points.append(nid)

    processes_created = 0
    used_in_process: set[str] = set()
    for ep in entry_points[:50]:
        chain = []
        seen: set[str] = set()
        cur = ep
        while cur and cur not in seen and len(chain) < 20:
            seen.add(cur)
            chain.append(cur)
            nxt = callees_map.get(cur, set()) - used_in_process - seen
            cur = next(iter(nxt), None) if nxt else None

        if len(chain) < 3:
            continue

        pid = f"process_{processes_created}"
        entry_name = chain[0].split(":")[1] if ":" in chain[0] else "unknown"
        end_name = chain[-1].split(":")[1] if ":" in chain[-1] else ""
        hlabel = (
            f"{entry_name} -> {end_name}"
            if end_name and end_name != entry_name
            else f"{entry_name} Flow"
        )
        try:
            conn.execute(
                f"CREATE (:Process {{id: '{pid}', name: 'Process {processes_created}', "
                f"heuristicLabel: '{_esc(hlabel)}', processType: 'trace', "
                f"stepCount: {len(chain)}, entryPointId: '{_esc(chain[0])}', "
                f"terminalId: '{_esc(chain[-1])}'}})"
            )
        except Exception:
            pass

        for step_i, nid in enumerate(chain, 1):
            used_in_process.add(nid)
            nl = node_labels.get(nid)
            if not nl:
                continue
            try:
                conn.execute(
                    f"MATCH (a:`{nl}` {{id: '{_esc(nid)}'}}), (p:Process {{id: '{pid}'}}) "
                    f"CREATE (a)-[:CodeRelation {{type: 'STEP_IN_PROCESS', confidence: 1.0, "
                    f"reason: 'trace', step: {step_i}}}]->(p)"
                )
            except Exception:
                pass

        processes_created += 1

    conn.close()
    db.close()

    if on_progress:
        on_progress("complete", 100, "Done!")

    return {
        "nodeCount": len(all_symbols)
        + len(files)
        + len(folder_set)
        + len(communities)
        + processes_created,
        "relationshipCount": call_edges
        + len(all_heritage)
        + len(all_symbols),  # approximate
        "communityCount": len(communities),
        "processCount": processes_created,
    }
