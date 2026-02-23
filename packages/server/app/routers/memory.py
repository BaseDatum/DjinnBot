"""Memory vault management endpoints."""

import os
import re
import json
import asyncio
import hashlib
import time
import subprocess
from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from app.utils import read_file as _read_file, parse_frontmatter as _parse_frontmatter
from app import dependencies


class MemoryFileCreate(BaseModel):
    content: str
    filename: str | None = None  # auto-generated if not provided


class MemoryFileUpdate(BaseModel):
    content: str


router = APIRouter()

VAULTS_DIR = os.getenv("VAULTS_DIR", "/data/vaults")

EXCLUDED_DIRS = {"templates", ".clawvault", ".git", "node_modules"}


def _get_vault_stats(vault_path: str) -> tuple[int, int]:
    """Return (file_count, total_size_bytes) for a vault directory."""
    if not os.path.isdir(vault_path):
        return 0, 0

    file_count = 0
    total_size = 0

    for root, dirs, files in os.walk(vault_path):
        dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]
        for filename in files:
            if filename.endswith(".md"):
                filepath = os.path.join(root, filename)
                if os.path.isfile(filepath):
                    file_count += 1
                    total_size += os.path.getsize(filepath)

    return file_count, total_size


@router.get("/vaults")
async def list_vaults():
    """List all agent vaults."""
    if not os.path.isdir(VAULTS_DIR):
        return []

    vaults = []

    for entry in sorted(os.listdir(VAULTS_DIR)):
        vault_path = os.path.join(VAULTS_DIR, entry)
        if os.path.isdir(vault_path):
            file_count, total_size = _get_vault_stats(vault_path)
            vaults.append(
                {
                    "agent_id": entry,
                    "file_count": file_count,
                    "total_size_bytes": total_size,
                }
            )

    return vaults


@router.get("/search")
async def search_vaults(q: str, agent_id: str | None = None, limit: int = 20):
    """Search across vaults for content matching query."""
    if not os.path.isdir(VAULTS_DIR):
        return []

    if not q or not q.strip():
        raise HTTPException(status_code=400, detail="Query parameter 'q' is required")

    query = q.lower()
    results = []

    # Determine which vaults to search
    vaults_to_search = []
    if agent_id:
        vault_path = os.path.join(VAULTS_DIR, agent_id)
        if os.path.isdir(vault_path):
            vaults_to_search.append((agent_id, vault_path))
    else:
        for entry in os.listdir(VAULTS_DIR):
            vault_path = os.path.join(VAULTS_DIR, entry)
            if os.path.isdir(vault_path):
                vaults_to_search.append((entry, vault_path))

    # Search through files
    for vault_agent_id, vault_path in vaults_to_search:
        for root, dirs, files in os.walk(vault_path):
            dirs[:] = [d for d in dirs if d not in EXCLUDED_DIRS]

            for filename in files:
                if not filename.endswith(".md"):
                    continue

                filepath = os.path.join(root, filename)
                content = _read_file(filepath)

                if content is None:
                    continue

                content_lower = content.lower()

                # Simple substring search
                if query in content_lower:
                    pos = content_lower.find(query)
                    start = max(0, pos - 100)
                    end = min(len(content), pos + len(q) + 100)
                    snippet = content[start:end]

                    if start > 0:
                        snippet = "..." + snippet
                    if end < len(content):
                        snippet = snippet + "..."

                    score = content_lower.count(query)
                    rel_path = os.path.relpath(filepath, vault_path)

                    results.append(
                        {
                            "agent_id": vault_agent_id,
                            "filename": rel_path,
                            "snippet": snippet,
                            "score": score,
                        }
                    )

                if len(results) >= limit:
                    break

            if len(results) >= limit:
                break

        if len(results) >= limit:
            break

    results.sort(key=lambda x: x["score"], reverse=True)
    return results[:limit]


@router.get("/vaults/shared/graph")
async def get_shared_graph():
    """Get the shared knowledge graph across all agents."""
    return await get_agent_graph("shared")


@router.get("/vaults/{agent_id}")
async def list_vault_files(agent_id: str):
    """List files in an agent's vault."""
    vault_dir = os.path.join(VAULTS_DIR, agent_id)

    if not os.path.isdir(vault_dir):
        return []

    files = []

    for root, dirs, files_in_dir in os.walk(vault_dir):
        dirs[:] = [d for d in sorted(dirs) if d not in EXCLUDED_DIRS]

        for filename in sorted(files_in_dir):
            if not filename.endswith(".md"):
                continue

            filepath = os.path.join(root, filename)
            if not os.path.isfile(filepath):
                continue

            content = _read_file(filepath)
            if content is None:
                continue

            meta, body = _parse_frontmatter(content)

            created_at = None
            if meta.get("createdAt"):
                try:
                    created_at = int(meta["createdAt"])
                except ValueError:
                    pass

            preview = body.strip()[:200] if body else None

            # Calculate relative path from vault root
            rel_path = os.path.relpath(filepath, vault_dir)
            directory = os.path.dirname(rel_path) or None

            # Infer category from frontmatter or directory name
            category = meta.get("category")
            if not category and directory:
                category = directory.split(os.sep)[0]

            files.append(
                {
                    "filename": rel_path,
                    "directory": directory,
                    "category": category,
                    "title": meta.get("title"),
                    "created_at": created_at,
                    "size_bytes": os.path.getsize(filepath),
                    "preview": preview,
                }
            )

    return files


# --- Graph routes MUST come before the {filename} catch-all ---


@router.get("/vaults/{agent_id}/graph")
async def get_agent_graph(agent_id: str):
    """Get knowledge graph for an agent's vault."""
    vault_dir = os.path.join(VAULTS_DIR, agent_id)

    if not os.path.isdir(vault_dir):
        return {
            "nodes": [],
            "edges": [],
            "stats": {
                "nodeCount": 0,
                "edgeCount": 0,
                "nodeTypeCounts": {},
                "edgeTypeCounts": {},
            },
        }

    graph_path = os.path.join(vault_dir, ".clawvault", "graph-index.json")

    if not os.path.isfile(graph_path):
        return {
            "nodes": [],
            "edges": [],
            "stats": {
                "nodeCount": 0,
                "edgeCount": 0,
                "nodeTypeCounts": {},
                "edgeTypeCounts": {},
            },
        }

    try:
        with open(graph_path, "r") as f:
            index = json.loads(f.read())

        graph = index.get("graph", {})
        nodes = graph.get("nodes", [])

        # Enrich nodes with createdAt from filesystem mtime if not present
        for node in nodes:
            if "createdAt" not in node and node.get("path"):
                node_path = os.path.join(vault_dir, node["path"])
                if os.path.isfile(node_path):
                    node["createdAt"] = int(os.path.getmtime(node_path) * 1000)

        return {
            "nodes": nodes,
            "edges": graph.get("edges", []),
            "stats": graph.get("stats", {}),
        }
    except Exception:
        return {
            "nodes": [],
            "edges": [],
            "stats": {
                "nodeCount": 0,
                "edgeCount": 0,
                "nodeTypeCounts": {},
                "edgeTypeCounts": {},
            },
        }


@router.get("/vaults/{agent_id}/graph/neighbors/{node_id:path}")
async def get_node_neighbors(agent_id: str, node_id: str, max_hops: int = 1):
    """Get neighbors of a node in the knowledge graph."""
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    graph_path = os.path.join(vault_dir, ".clawvault", "graph-index.json")

    if not os.path.isfile(graph_path):
        return {"nodes": [], "edges": []}

    with open(graph_path, "r") as f:
        index = json.loads(f.read())

    graph = index.get("graph", {})
    nodes = {n["id"]: n for n in graph.get("nodes", [])}
    edges = graph.get("edges", [])

    # BFS from node_id
    visited = {node_id}
    queue = [(node_id, 0)]
    result_edges = []

    while queue:
        current, depth = queue.pop(0)
        if depth >= max_hops:
            continue

        for edge in edges:
            neighbor = None
            if edge["source"] == current:
                neighbor = edge["target"]
            elif edge["target"] == current:
                neighbor = edge["source"]

            if neighbor and neighbor not in visited:
                visited.add(neighbor)
                queue.append((neighbor, depth + 1))

            if neighbor:
                result_edges.append(edge)

    return {
        "nodes": [nodes[nid] for nid in visited if nid in nodes],
        "edges": result_edges,
    }


@router.post("/vaults/{agent_id}/graph/rebuild")
async def rebuild_agent_graph(agent_id: str):
    """Trigger a knowledge graph rebuild for an agent vault."""
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    if not os.path.isdir(vault_dir):
        raise HTTPException(status_code=404, detail="Vault not found")

    try:
        # Try to call clawvault CLI via node to rebuild the graph
        result = subprocess.run(
            [
                "node",
                "-e",
                f'''
                const {{ getMemoryGraph }} = require("clawvault");
                getMemoryGraph("{vault_dir}", {{ refresh: true }}).then(g => 
                    console.log(JSON.stringify({{ nodes: g.nodes.length, edges: g.edges.length }}))
                ).catch(e => {{ console.error(e.message); process.exit(1); }});
            ''',
            ],
            capture_output=True,
            text=True,
            timeout=30,
        )
        if result.returncode == 0:
            try:
                return json.loads(result.stdout)
            except json.JSONDecodeError:
                return {"status": "rebuilt", "nodes": 0, "edges": 0}
        else:
            raise HTTPException(
                status_code=500, detail=f"Rebuild failed: {result.stderr}"
            )
    except FileNotFoundError:
        # Node.js not available in API container — trigger via Redis for engine to handle
        if dependencies.redis_client:
            await dependencies.redis_client.publish(
                "djinnbot:graph:rebuild", json.dumps({"agent_id": agent_id})
            )
            return {"status": "queued", "message": "Rebuild requested via engine"}
        raise HTTPException(
            status_code=501, detail="Graph rebuild not available in this container"
        )
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail="Graph rebuild timed out")


# --- WebSocket for live graph updates ---


class VaultWatcher:
    """Watches a vault for changes and broadcasts graph updates to connected clients.

    Two notification paths for low-latency updates:
    1. Redis subscription to ``djinnbot:vault:updated`` — the agent runtime
       publishes here immediately after writing a memory. The watcher receives
       the signal, waits a short moment for the file to flush, then rebuilds
       the graph and pushes to all connected WebSocket clients. This gives
       sub-second latency for the dashboard.
    2. Filesystem polling (fallback) — every 2 seconds, hashes all .md files
       in the vault. Catches any writes that bypassed the Redis channel.
    """

    def __init__(self, agent_id: str, vault_path: str):
        self.agent_id = agent_id
        self.vault_path = vault_path
        self.clients: set[WebSocket] = set()
        self._watch_task: asyncio.Task | None = None
        self._redis_task: asyncio.Task | None = None
        self._rebuilt_task: asyncio.Task | None = None
        self._last_graph: dict | None = None
        self._version = 0
        # Event used to wake the watch loop immediately when Redis notifies
        self._notify_event: asyncio.Event = asyncio.Event()

    async def add_client(self, ws: WebSocket):
        self.clients.add(ws)
        if self._last_graph is None:
            self._last_graph = self._build_graph()
            self._version = 1
        await ws.send_json(
            {
                "type": "graph:init",
                "payload": {"version": self._version, "graph": self._last_graph},
            }
        )
        if len(self.clients) == 1:
            self._watch_task = asyncio.create_task(self._watch_loop())
            self._redis_task = asyncio.create_task(self._redis_listener())
            self._rebuilt_task = asyncio.create_task(self._graph_rebuilt_listener())

    def remove_client(self, ws: WebSocket):
        self.clients.discard(ws)
        if not self.clients:
            if self._watch_task:
                self._watch_task.cancel()
                self._watch_task = None
            if self._redis_task:
                self._redis_task.cancel()
                self._redis_task = None
            if self._rebuilt_task:
                self._rebuilt_task.cancel()
                self._rebuilt_task = None
            self._last_graph = None

    def _build_graph(self) -> dict:
        index_path = os.path.join(self.vault_path, ".clawvault", "graph-index.json")
        if os.path.isfile(index_path):
            try:
                with open(index_path) as f:
                    data = json.load(f)
                if "graph" in data:
                    return data["graph"]
            except Exception:
                pass
        return {"nodes": [], "edges": [], "stats": {}}

    def _hash_vault(self) -> str:
        h = hashlib.md5()
        if not os.path.isdir(self.vault_path):
            return ""
        try:
            # Include graph-index.json mtime so we detect when the engine
            # finishes rebuilding (it lives inside .clawvault/ which is
            # excluded from the .md walk below).
            graph_idx = os.path.join(self.vault_path, ".clawvault", "graph-index.json")
            if os.path.isfile(graph_idx):
                st = os.stat(graph_idx)
                h.update(f"__graph_index__:{st.st_mtime_ns}".encode())

            for root_dir, dirs, files in os.walk(self.vault_path):
                dirs[:] = [
                    d
                    for d in sorted(dirs)
                    if d not in (".git", ".clawvault", "node_modules")
                ]
                for f in sorted(files):
                    if f.endswith(".md"):
                        fp = os.path.join(root_dir, f)
                        rel = os.path.relpath(fp, self.vault_path)
                        st = os.stat(fp)
                        h.update(f"{rel}:{st.st_mtime_ns}".encode())
        except OSError:
            pass
        return h.hexdigest()

    async def _broadcast_update(self) -> None:
        """Read the current graph-index.json and broadcast to all clients.

        The engine rebuilds graph-index.json asynchronously and publishes
        ``djinnbot:graph:rebuilt`` when done (handled by
        ``_graph_rebuilt_listener``).  This method simply reads whatever is
        on disk right now.  If the file hasn't been rebuilt yet we may get
        stale data — that's OK because ``_graph_rebuilt_listener`` will
        trigger another broadcast once the fresh index lands.

        We guard against regressing: if the new graph is empty but we
        previously had a non-empty graph, we skip the broadcast so the
        client doesn't flash back to the empty state.
        """
        new_graph = self._build_graph()

        # Don't overwrite a populated graph with an empty one — the
        # rebuild hasn't finished yet; a follow-up broadcast will arrive
        # once graph-index.json is actually written.
        prev_nodes = (self._last_graph or {}).get("nodes", [])
        new_nodes = new_graph.get("nodes", [])
        if len(prev_nodes) > 0 and len(new_nodes) == 0:
            return

        self._version += 1
        self._last_graph = new_graph
        msg = {
            "type": "graph:update",
            "payload": {"version": self._version, "graph": self._last_graph},
        }
        dead = set()
        for client in self.clients:
            try:
                await client.send_json(msg)
            except Exception:
                dead.add(client)
        self.clients -= dead

    async def _redis_listener(self) -> None:
        """Subscribe to vault:updated Redis channel for instant notifications.

        When the agent runtime writes a memory, it publishes to
        ``djinnbot:vault:updated`` with ``{agentId, sharedUpdated}``.
        For the ``shared`` vault watcher, we trigger on ``sharedUpdated=true``.
        For per-agent watchers, we trigger when ``agentId`` matches.
        """
        if not dependencies.redis_client:
            return
        pubsub = None
        try:
            # Create a dedicated pubsub from the existing Redis client.
            # redis.asyncio.Redis.pubsub() returns a PubSub that shares the
            # connection pool, so no extra connection config is needed.
            pubsub = dependencies.redis_client.pubsub()
            await pubsub.subscribe("djinnbot:vault:updated")
            async for message in pubsub.listen():
                if not self.clients:
                    break
                if message["type"] != "message":
                    continue
                try:
                    payload = json.loads(message["data"])
                    agent_id = payload.get("agentId", "")
                    shared_updated = payload.get("sharedUpdated", False)
                    # Match: either this is our agent's vault, or we're the
                    # shared watcher and a shared write happened.
                    if agent_id == self.agent_id or (
                        self.agent_id == "shared" and shared_updated
                    ):
                        # Wake the watch loop to broadcast immediately
                        self._notify_event.set()
                except Exception:
                    pass
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(f"[VaultWatcher] Redis listener failed for {self.agent_id}: {e}")
        finally:
            if pubsub:
                try:
                    await pubsub.unsubscribe("djinnbot:vault:updated")
                    await pubsub.aclose()
                except Exception:
                    pass

    async def _graph_rebuilt_listener(self) -> None:
        """Subscribe to ``djinnbot:graph:rebuilt`` — published by the engine
        after it finishes running ``clawvault graph --refresh``.

        This gives us a *reliable* signal that graph-index.json is fresh,
        eliminating the timing race between the rebuild and the file read.
        """
        if not dependencies.redis_client:
            return
        pubsub = None
        try:
            pubsub = dependencies.redis_client.pubsub()
            await pubsub.subscribe("djinnbot:graph:rebuilt")
            async for message in pubsub.listen():
                if not self.clients:
                    break
                if message["type"] != "message":
                    continue
                try:
                    payload = json.loads(message["data"])
                    rebuilt_agent = payload.get("agent_id", "")
                    if rebuilt_agent == self.agent_id:
                        await self._broadcast_update()
                except Exception:
                    pass
        except asyncio.CancelledError:
            pass
        except Exception as e:
            print(
                f"[VaultWatcher] graph:rebuilt listener failed for {self.agent_id}: {e}"
            )
        finally:
            if pubsub:
                try:
                    await pubsub.unsubscribe("djinnbot:graph:rebuilt")
                    await pubsub.aclose()
                except Exception:
                    pass

    async def _watch_loop(self):
        last_hash = self._hash_vault()
        try:
            while self.clients:
                # Wait for either: Redis notification (instant) or timeout (2s fallback)
                try:
                    await asyncio.wait_for(self._notify_event.wait(), timeout=2.0)
                    self._notify_event.clear()
                    # Small delay for file flush after Redis notification
                    await asyncio.sleep(0.3)
                except asyncio.TimeoutError:
                    pass

                current_hash = self._hash_vault()
                if current_hash != last_hash:
                    last_hash = current_hash
                    # Request a graph rebuild from the engine — it will publish
                    # graph:rebuilt when done, which triggers another broadcast
                    # with fresh data via _graph_rebuilt_listener.
                    if dependencies.redis_client:
                        try:
                            await dependencies.redis_client.publish(
                                "djinnbot:graph:rebuild",
                                json.dumps({"agent_id": self.agent_id}),
                            )
                        except Exception:
                            pass
                    # Broadcast whatever we have now (may be stale but the
                    # rebuilt listener will follow up with fresh data).
                    await self._broadcast_update()
        except asyncio.CancelledError:
            pass


_vault_watchers: dict[str, VaultWatcher] = {}


@router.websocket("/vaults/{agent_id}/ws")
async def vault_graph_ws(websocket: WebSocket, agent_id: str):
    """WebSocket endpoint for live graph updates.

    During onboarding the shared vault may not exist yet when the dashboard
    first mounts the mini graph.  Instead of rejecting with 4004 (which
    forces the client into exponential-backoff reconnects), we accept the
    connection and poll briefly until the vault directory appears.
    """
    vault_path = os.path.join(VAULTS_DIR, agent_id)

    await websocket.accept()

    # Wait up to ~30 seconds for the vault directory to appear (onboarding
    # creates it when the first agent writes a shared memory).
    if not os.path.isdir(vault_path):
        for _ in range(30):
            await asyncio.sleep(1)
            if os.path.isdir(vault_path):
                break
        else:
            # Still not there — close cleanly so the client can retry.
            await websocket.close(code=4004, reason="Vault not found")
            return

    if agent_id not in _vault_watchers:
        _vault_watchers[agent_id] = VaultWatcher(agent_id, vault_path)

    watcher = _vault_watchers[agent_id]
    await watcher.add_client(websocket)

    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        watcher.remove_client(websocket)


# --- Catch-all file routes AFTER specific routes ---


@router.get("/vaults/{agent_id}/{filename:path}")
async def get_vault_file(agent_id: str, filename: str):
    """Get full file content from an agent's vault."""
    # Allow subdirectory paths but block traversal
    if ".." in filename or filename.startswith("/") or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    # Resolve and verify the path stays within the vault
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    filepath = os.path.realpath(os.path.join(vault_dir, filename))
    if not filepath.startswith(os.path.realpath(vault_dir)):
        raise HTTPException(status_code=400, detail="Path traversal detected")

    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Memory file not found")

    content = _read_file(filepath)
    if content is None:
        raise HTTPException(status_code=500, detail="Failed to read file")

    meta, body = _parse_frontmatter(content)

    return {"filename": filename, "content": content, "metadata": meta}


@router.put("/vaults/{agent_id}/{filename:path}")
async def update_vault_file(agent_id: str, filename: str, req: MemoryFileUpdate):
    """Update an existing file in an agent's vault."""
    # Allow subdirectory paths but block traversal
    if ".." in filename or filename.startswith("/") or "\\" in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")

    # Resolve and verify the path stays within the vault
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    filepath = os.path.realpath(os.path.join(vault_dir, filename))
    if not filepath.startswith(os.path.realpath(vault_dir)):
        raise HTTPException(status_code=400, detail="Path traversal detected")

    # Block editing .clawvault directory
    if ".clawvault" in filename.split(os.sep):
        raise HTTPException(status_code=403, detail="Cannot edit .clawvault files")

    # Block editing template files
    if filename.startswith("templates/"):
        raise HTTPException(status_code=403, detail="Cannot edit template files")

    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Memory file not found")

    # Write content to file
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(req.content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {str(e)}")

    return {"filename": filename, "size": len(req.content), "updated": True}


@router.post("/vaults/{agent_id}/files")
async def create_vault_file(agent_id: str, req: MemoryFileCreate):
    """Create a new file in an agent's vault."""
    vault_dir = os.path.join(VAULTS_DIR, agent_id)

    if not os.path.isdir(vault_dir):
        raise HTTPException(status_code=404, detail="Vault not found")

    # Determine filename
    if req.filename:
        # Validate provided filename
        if ".." in req.filename or req.filename.startswith("/") or "\\" in req.filename:
            raise HTTPException(status_code=400, detail="Invalid filename")
        filename = req.filename
    else:
        # Auto-generate filename: inbox/note-{timestamp}.md
        timestamp = int(time.time() * 1000)
        filename = f"inbox/note-{timestamp}.md"

    # Block creating files in .clawvault
    if ".clawvault" in filename.split(os.sep):
        raise HTTPException(status_code=403, detail="Cannot create files in .clawvault")

    # Block creating template files
    if filename.startswith("templates/"):
        raise HTTPException(status_code=403, detail="Cannot create template files")

    # Resolve full path and verify it stays within vault
    filepath = os.path.realpath(os.path.join(vault_dir, filename))
    if not filepath.startswith(os.path.realpath(vault_dir)):
        raise HTTPException(status_code=400, detail="Path traversal detected")

    # Ensure parent directory exists
    parent_dir = os.path.dirname(filepath)
    if parent_dir and not os.path.isdir(parent_dir):
        os.makedirs(parent_dir, exist_ok=True)

    # Check if file already exists
    if os.path.isfile(filepath):
        raise HTTPException(status_code=409, detail="File already exists")

    # Write content to file
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(req.content)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {str(e)}")

    return {"filename": filename, "size": len(req.content), "created": True}

    # Resolve and verify the path stays within the vault
    vault_dir = os.path.join(VAULTS_DIR, agent_id)
    filepath = os.path.realpath(os.path.join(vault_dir, filename))
    if not filepath.startswith(os.path.realpath(vault_dir)):
        raise HTTPException(status_code=400, detail="Path traversal detected")

    if not os.path.isfile(filepath):
        raise HTTPException(status_code=404, detail="Memory file not found")

    try:
        os.remove(filepath)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete file: {str(e)}")

    return {"agent_id": agent_id, "filename": filename, "deleted": True}
