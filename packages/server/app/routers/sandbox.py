"""Agent sandbox file browsing endpoints.

Unified sandbox structure per agent:
/jfs/sandboxes/{agentId}/
├── home/           # Agent's home dir (persists installed packages, configs)
├── usr-local/      # /usr/local overlay (pip installs, etc.)
├── workspace/      # Agent's work files
└── vault/          # Memory vault (ClawVault)
"""

import os
import base64
from fastapi import APIRouter, HTTPException, Query
from pathlib import Path
from typing import Optional, List
from pydantic import BaseModel

from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


def get_sandboxes_dir() -> str:
    """Get unified sandboxes directory - where each agent's full sandbox lives."""
    return os.getenv("SANDBOXES_DIR", "/jfs/sandboxes")


SANDBOXES_DIR = get_sandboxes_dir()
MAX_FILE_SIZE = 1024 * 1024  # 1MB limit for file content

# The JuiceFS volume is mounted at /jfs in the API/engine containers but at
# /djinnbot-data in agent containers.  Agent entrypoint scripts create symlinks
# using /djinnbot-data/... paths (e.g. run-workspace -> /djinnbot-data/runs/{runId}).
# When the API server follows those symlinks the targets don't exist because here
# the same volume is at /jfs.  We fix this by resolving the symlink target manually
# and translating /djinnbot-data → /jfs.
DATA_DIR = os.getenv("DJINN_DATA_PATH", "/jfs")


class FileNode(BaseModel):
    name: str
    path: str
    type: str  # "file" | "directory"
    size: Optional[int] = None
    modified: Optional[int] = None
    children: Optional[List["FileNode"]] = None


class SandboxInfo(BaseModel):
    sandboxId: str
    diskUsage: dict
    fileCount: int
    directoryCount: int
    installedTools: List[dict]
    rootFiles: List[FileNode]


class FileTree(BaseModel):
    path: str
    files: List[FileNode]


class FileContent(BaseModel):
    path: str
    content: str
    size: int
    modified: int
    encoding: str = "utf-8"
    truncated: bool = False


def _resolve_symlink(path: Path) -> Optional[Path]:
    """Resolve a symlink, translating /djinnbot-data → DATA_DIR if needed.

    Agent containers mount the data volume at /djinnbot-data and create symlinks
    with that prefix.  The API server mounts the *same* volume at DATA_DIR
    (typically /data), so those symlink targets appear broken.  This helper
    reads the raw link target and rewrites the prefix so the path resolves.

    Returns the resolved Path on success, or None if truly broken.
    """
    if not path.is_symlink():
        return None
    try:
        target = os.readlink(path)
    except OSError:
        return None

    # Fast path: symlink already resolves (same mount layout)
    target_path = Path(target)
    if target_path.exists():
        return target_path

    # Translate /djinnbot-data/... → DATA_DIR/...
    if target.startswith("/djinnbot-data/"):
        translated = Path(DATA_DIR) / target[len("/djinnbot-data/") :]
        if translated.exists():
            return translated
    elif target.startswith("/djinnbot-data"):
        translated = Path(DATA_DIR) / target[len("/djinnbot-data") :]
        if translated.exists():
            return translated

    return None


def validate_sandbox_path(agent_id: str, requested_path: str = "/") -> Path:
    """
    Validate and resolve a sandbox path for the given agent.

    SECURITY:
    - Blocks directory traversal (../)
    - Resolves symlinks (with /djinnbot-data → DATA_DIR translation)
    - Ensures final path is within the data volume
    - Normalizes path separators

    Returns: Absolute Path object within sandbox
    Raises: HTTPException if path is invalid or outside sandbox
    """
    logger.debug(
        f"Validating sandbox path: agent_id={agent_id}, requested_path={requested_path}"
    )

    # Get sandbox root (unified sandbox for this agent)
    sandbox_root = Path(get_sandboxes_dir()) / agent_id
    sandbox_root_resolved = sandbox_root.resolve()
    data_dir_resolved = Path(DATA_DIR).resolve()

    # Normalize requested path (remove leading slash for join)
    requested_path = requested_path.lstrip("/")

    # Block obvious traversal attempts
    if ".." in requested_path.split(os.sep):
        logger.debug(
            f"Path traversal blocked: agent_id={agent_id}, path={requested_path}"
        )
        raise HTTPException(status_code=400, detail="Path traversal detected")

    # Construct full path
    full_path = sandbox_root / requested_path

    # Resolve symlinks and normalize.
    # Walk the path components, translating any symlink that points to
    # /djinnbot-data (the agent-container mount) so it resolves under DATA_DIR.
    try:
        full_path_resolved = full_path.resolve()
    except (OSError, RuntimeError):
        # resolve() failed — the symlink target doesn't exist.
        # Try translating each symlink segment.
        full_path_resolved = _resolve_with_translation(full_path)
        if full_path_resolved is None:
            raise HTTPException(status_code=400, detail="Path could not be resolved")

    # Also handle the case where resolve() "succeeded" but returned a
    # /djinnbot-data/... path (can happen if resolve doesn't traverse).
    resolved_str = str(full_path_resolved)
    if resolved_str.startswith("/djinnbot-data/"):
        full_path_resolved = Path(DATA_DIR) / resolved_str[len("/djinnbot-data/") :]
    elif resolved_str.startswith("/djinnbot-data"):
        full_path_resolved = Path(DATA_DIR) / resolved_str[len("/djinnbot-data") :]

    # Ensure resolved path is still within the data volume (sandbox root or its
    # symlink targets like vaults/runs/workspaces all live under DATA_DIR).
    try:
        full_path_resolved.relative_to(sandbox_root_resolved)
    except ValueError:
        # Not under sandbox root — but symlinked dirs (vaults, runs, workspaces)
        # live elsewhere under DATA_DIR. Allow anything under the data volume.
        try:
            full_path_resolved.relative_to(data_dir_resolved)
        except ValueError:
            raise HTTPException(status_code=400, detail="Path outside sandbox")

    return full_path_resolved


def _resolve_with_translation(path: Path) -> Optional[Path]:
    """Walk path components, translating broken symlinks via _resolve_symlink.

    Returns the resolved real path, or None if unresolvable.
    """
    # Find the deepest existing ancestor
    parts = list(path.parts)
    resolved = Path(parts[0])  # root "/"

    for part in parts[1:]:
        candidate = resolved / part
        if candidate.is_symlink():
            translated = _resolve_symlink(candidate)
            if translated is not None and translated.exists():
                resolved = translated
                continue
        if candidate.exists():
            resolved = candidate.resolve() if candidate.is_symlink() else candidate
        else:
            # Component doesn't exist even after translation
            return None

    return resolved if resolved.exists() else None


def get_sandbox_path(agent_id: str) -> Optional[Path]:
    """Get the sandbox root path for an agent, or None if it doesn't exist."""
    logger.debug(f"Getting sandbox path: agent_id={agent_id}")
    path = Path(get_sandboxes_dir()) / agent_id
    if not path.exists():
        logger.debug(f"Sandbox does not exist: agent_id={agent_id}")
        return None
    return path


def calculate_disk_usage(path: Path) -> dict:
    """Calculate total disk usage for a sandbox."""
    logger.debug(f"Calculating disk usage for: {path}")
    total = 0
    try:
        for item in path.rglob("*"):
            if item.is_file():
                try:
                    total += item.stat().st_size
                except (OSError, PermissionError):
                    pass
    except (OSError, PermissionError):
        pass

    return {
        "used": total // (1024 * 1024),  # Convert to MB
        "total": 5120,  # 5GB default limit
        "unit": "MB",
    }


def count_files_and_dirs(path: Path) -> tuple[int, int]:
    """Count files and directories in a path."""
    logger.debug(f"Counting files and dirs in: {path}")
    file_count = 0
    dir_count = 0

    try:
        for item in path.rglob("*"):
            if item.is_file():
                file_count += 1
            elif item.is_dir():
                dir_count += 1
    except (OSError, PermissionError):
        pass

    return file_count, dir_count


def list_installed_tools(sandbox_path: Path) -> List[dict]:
    """List installed tools from .local/bin directory."""
    logger.debug(f"Listing installed tools in: {sandbox_path}")
    tools = []
    local_bin = sandbox_path / ".local" / "bin"

    if not local_bin.exists():
        return tools

    try:
        for item in local_bin.iterdir():
            if item.is_file() and os.access(item, os.X_OK):
                tools.append(
                    {
                        "name": item.name,
                        "version": None,  # Could be extracted from --version in the future
                    }
                )
    except (OSError, PermissionError):
        pass

    return tools


def build_file_node(
    path: Path, sandbox_root: Path, max_depth: int = 0
) -> Optional[FileNode]:
    """Build a FileNode from a Path object.

    Args:
        path: The filesystem path to build a node for.
        sandbox_root: Root of the sandbox (for computing relative paths).
        max_depth: How many levels of children to include for directories.
                   0 = no children, 1 = immediate children only, etc.

    Returns None for broken symlinks or unreadable paths instead of raising.
    """
    try:
        # Use lstat() so broken symlinks don't raise — we get the symlink's own metadata
        stat_info = path.lstat()
        is_symlink = path.is_symlink()

        # The actual filesystem path to iterate (differs from `path` when we
        # need to translate a broken symlink to the correct mount point).
        effective_path = path

        # For symlinks, try to resolve the type.
        # If the target doesn't exist at the raw path (mount-point mismatch),
        # translate the target through _resolve_symlink().
        if is_symlink:
            try:
                is_dir = path.is_dir()  # follows symlink
            except OSError:
                is_dir = False

            if not is_dir and not path.exists():
                # Broken symlink — attempt mount-point translation
                resolved = _resolve_symlink(path)
                if resolved is not None:
                    is_dir = resolved.is_dir()
                    effective_path = resolved
                    try:
                        stat_info = resolved.stat()
                    except OSError:
                        pass
        else:
            is_dir = path.is_dir()

        # Get relative path from sandbox root (always use the *original* path
        # so the frontend sees sandbox-relative paths, not translated ones).
        try:
            rel_path = path.relative_to(sandbox_root)
            path_str = "/" + str(rel_path).replace(os.sep, "/")
        except ValueError:
            path_str = "/" + path.name

        node = FileNode(
            name=path.name,
            path=path_str,
            type="directory" if is_dir else "file",
            size=stat_info.st_size if not is_dir else None,
            modified=int(stat_info.st_mtime * 1000),  # Convert to milliseconds
            children=None,
        )

        # Include children for directories when depth allows.
        # Use effective_path for iteration (handles translated symlinks).
        if max_depth > 0 and is_dir:
            children = []
            try:
                for child in sorted(
                    effective_path.iterdir(), key=lambda p: (not p.is_dir(), p.name)
                ):
                    # For children of a translated symlink we need to present
                    # paths relative to sandbox_root.  We build a "virtual" child
                    # path under the original parent so relative_to() works.
                    if effective_path != path:
                        virtual_child = path / child.name
                    else:
                        virtual_child = child

                    child_node = _build_file_node_from(
                        virtual_child, child, sandbox_root, max_depth=max_depth - 1
                    )
                    if child_node is not None:
                        children.append(child_node)
                node.children = children
            except (OSError, PermissionError):
                pass

        return node

    except (OSError, PermissionError) as e:
        logger.warning(f"Skipping unreadable path {path}: {e}")
        return None


def _build_file_node_from(
    virtual_path: Path,
    real_path: Path,
    sandbox_root: Path,
    max_depth: int = 0,
) -> Optional[FileNode]:
    """Build a FileNode where the display path and real FS path may differ.

    This handles children of translated symlinks: the *virtual_path* is used
    for the relative path shown in the UI, while *real_path* is what we
    actually stat/iterate on disk.
    """
    try:
        is_symlink = real_path.is_symlink()
        is_dir = False
        effective_path = real_path

        if is_symlink:
            try:
                is_dir = real_path.is_dir()
            except OSError:
                is_dir = False
            if not is_dir and not real_path.exists():
                resolved = _resolve_symlink(real_path)
                if resolved is not None:
                    is_dir = resolved.is_dir()
                    effective_path = resolved
        else:
            is_dir = real_path.is_dir()

        try:
            stat_info = (
                effective_path.stat()
                if effective_path != real_path
                else real_path.lstat()
            )
        except OSError:
            stat_info = real_path.lstat()

        try:
            rel_path = virtual_path.relative_to(sandbox_root)
            path_str = "/" + str(rel_path).replace(os.sep, "/")
        except ValueError:
            path_str = "/" + virtual_path.name

        node = FileNode(
            name=virtual_path.name,
            path=path_str,
            type="directory" if is_dir else "file",
            size=stat_info.st_size if not is_dir else None,
            modified=int(stat_info.st_mtime * 1000),
            children=None,
        )

        if max_depth > 0 and is_dir:
            children = []
            try:
                for child in sorted(
                    effective_path.iterdir(), key=lambda p: (not p.is_dir(), p.name)
                ):
                    vchild = virtual_path / child.name
                    child_node = _build_file_node_from(
                        vchild, child, sandbox_root, max_depth=max_depth - 1
                    )
                    if child_node is not None:
                        children.append(child_node)
                node.children = children
            except (OSError, PermissionError):
                pass

        return node

    except (OSError, PermissionError) as e:
        logger.warning(f"Skipping unreadable path {real_path}: {e}")
        return None


def is_binary_file(filepath: Path, sample_size: int = 8192) -> bool:
    """Check if a file is binary by reading a sample."""
    try:
        with open(filepath, "rb") as f:
            chunk = f.read(sample_size)
            # Check for null bytes (common in binary files)
            if b"\x00" in chunk:
                return True
            # Check for high ratio of non-text bytes
            text_chars = bytearray(
                {7, 8, 9, 10, 12, 13, 27} | set(range(0x20, 0x100)) - {0x7F}
            )
            non_text = sum(1 for byte in chunk if byte not in text_chars)
            return non_text / len(chunk) > 0.3 if chunk else False
    except Exception:
        return True


@router.get("/{agent_id}/sandbox")
async def get_sandbox_info(agent_id: str) -> SandboxInfo:
    """Get sandbox info and root file listing."""
    logger.debug(f"Getting sandbox info: agent_id={agent_id}")

    sandbox_path = get_sandbox_path(agent_id)

    # Handle non-existent sandbox
    if sandbox_path is None:
        return SandboxInfo(
            sandboxId=agent_id,
            diskUsage={"used": 0, "total": 5120, "unit": "MB"},
            fileCount=0,
            directoryCount=0,
            installedTools=[],
            rootFiles=[],
        )

    # Calculate metrics
    disk_usage = calculate_disk_usage(sandbox_path)
    file_count, dir_count = count_files_and_dirs(sandbox_path)
    installed_tools = list_installed_tools(sandbox_path)

    # List root files with deep recursion so the tree is fully browsable.
    # max_depth=10 follows symlinks and nested dirs up to 10 levels.
    root_files = []
    try:
        for item in sorted(
            sandbox_path.iterdir(), key=lambda p: (not p.is_dir(), p.name)
        ):
            node = build_file_node(item, sandbox_path, max_depth=10)
            if node is not None:
                root_files.append(node)
    except (OSError, PermissionError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to list root files: {e}")

    return SandboxInfo(
        sandboxId=agent_id,
        diskUsage=disk_usage,
        fileCount=file_count,
        directoryCount=dir_count,
        installedTools=installed_tools,
        rootFiles=root_files,
    )


@router.get("/{agent_id}/sandbox/tree")
async def get_file_tree(
    agent_id: str, path: str = Query("/", description="Path within sandbox to browse")
) -> FileTree:
    """Get file tree for a specific path within the sandbox."""
    logger.debug(f"Getting file tree: agent_id={agent_id}, path={path}")

    sandbox_root = Path(get_sandboxes_dir()) / agent_id

    # Build the "virtual" parent path under sandbox_root (for relative path
    # computation in the UI) and the "real" path to iterate on disk.
    requested = path.lstrip("/")
    virtual_parent = sandbox_root / requested if requested else sandbox_root

    # Validate — this may return a translated real path for symlinks
    resolved_path = validate_sandbox_path(agent_id, path)

    # Check if path exists
    if not resolved_path.exists():
        raise HTTPException(status_code=404, detail="Path not found")

    # Check if it's a directory
    if not resolved_path.is_dir():
        raise HTTPException(status_code=400, detail="Path is not a directory")

    # Build file list.  Use resolved_path for iteration (real FS path) and
    # virtual_parent for building sandbox-relative display paths.
    files = []
    try:
        for item in sorted(
            resolved_path.iterdir(), key=lambda p: (not p.is_dir(), p.name)
        ):
            vchild = virtual_parent / item.name
            node = _build_file_node_from(vchild, item, sandbox_root, max_depth=10)
            if node is not None:
                files.append(node)
    except (OSError, PermissionError) as e:
        raise HTTPException(status_code=500, detail=f"Failed to list directory: {e}")

    # Return normalized path (always relative to sandbox root)
    norm_path = "/" + requested if requested else "/"
    return FileTree(path=norm_path if norm_path != "/." else "/", files=files)


@router.get("/{agent_id}/sandbox/file")
async def get_file_content(
    agent_id: str, path: str = Query(..., description="Path to file within sandbox")
) -> FileContent:
    """Get content of a specific file."""
    logger.debug(f"Getting file content: agent_id={agent_id}, path={path}")

    # Validate and resolve path
    resolved_path = validate_sandbox_path(agent_id, path)

    # Check if file exists
    if not resolved_path.exists():
        raise HTTPException(status_code=404, detail="File not found")

    # Check if it's a file
    if not resolved_path.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    # Get file stats
    try:
        stat = resolved_path.stat()
        file_size = stat.st_size
        modified = int(stat.st_mtime * 1000)
    except (OSError, PermissionError) as e:
        raise HTTPException(
            status_code=500, detail=f"Failed to read file metadata: {e}"
        )

    # Check file size
    truncated = file_size > MAX_FILE_SIZE
    read_size = min(file_size, MAX_FILE_SIZE)

    # Check if file is binary
    if is_binary_file(resolved_path):
        # For binary files, return base64 encoded content
        try:
            with open(resolved_path, "rb") as f:
                content_bytes = f.read(read_size)
                content = base64.b64encode(content_bytes).decode("ascii")
                encoding = "base64"
        except Exception as e:
            raise HTTPException(
                status_code=500, detail=f"Failed to read binary file: {e}"
            )

        return FileContent(
            path=path,
            content=content,
            size=file_size,
            modified=modified,
            encoding=encoding,
            truncated=truncated,
        )

    # Read text file
    try:
        with open(resolved_path, "r", encoding="utf-8", errors="replace") as f:
            content = f.read(read_size)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {e}")

    return FileContent(
        path=path,
        content=content,
        size=file_size,
        modified=modified,
        encoding="utf-8",
        truncated=truncated,
    )
