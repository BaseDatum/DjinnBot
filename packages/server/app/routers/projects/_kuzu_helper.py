"""KuzuDB query helper for the knowledge graph API.

All KuzuDB queries are executed in a thread pool to avoid blocking
the async event loop. The KuzuDB Python bindings are synchronous.
"""

import asyncio
import os
import subprocess
from functools import partial
from pathlib import Path
from typing import Optional

from app.logging_config import get_logger

logger = get_logger(__name__)

# Lazy import kuzu (optional dependency)
_kuzu = None


def _get_kuzu():
    global _kuzu
    if _kuzu is None:
        try:
            import kuzu

            _kuzu = kuzu
        except ImportError:
            raise RuntimeError(
                "kuzu package not installed. Install with: pip install kuzu"
            )
    return _kuzu


def _open_db(db_path: str):
    """Open a KuzuDB database and return (db, conn)."""
    kuzu = _get_kuzu()
    db = kuzu.Database(db_path)
    conn = kuzu.Connection(db)
    return db, conn


def _query_sync(db_path: str, cypher: str) -> list[dict]:
    """Execute a Cypher query synchronously and return rows as dicts."""
    if not os.path.exists(db_path):
        return []

    db, conn = _open_db(db_path)
    try:
        result = conn.execute(cypher)
        rows = []
        while result.has_next():
            row = result.get_next()
            # Convert to dict using column names
            cols = result.get_column_names()
            rows.append(dict(zip(cols, row)))
        return rows
    except Exception as err:
        logger.debug(f"KuzuDB query failed: {err}")
        return []
    finally:
        try:
            conn.close()
            db.close()
        except Exception:
            pass


async def _query(db_path: str, cypher: str) -> list[dict]:
    """Execute a Cypher query asynchronously."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, partial(_query_sync, db_path, cypher))


# ── Public query functions ─────────────────────────────────────────────────


async def query_graph_data(db_path: str) -> dict:
    """Get graph data for visualization."""
    nodes = []
    edges = []
    communities = []
    processes = []

    # Get code symbols (non-File, non-Folder)
    for label in [
        "Function",
        "Class",
        "Method",
        "Interface",
        "Struct",
        "Enum",
        "Trait",
        "Impl",
        "Constructor",
        "CodeElement",
    ]:
        try:
            rows = await _query(
                db_path,
                f"MATCH (n:`{label}`) RETURN n.id AS id, n.name AS name, "
                f"n.filePath AS filePath, n.startLine AS startLine, "
                f"'{label}' AS label LIMIT 500",
            )
            for r in rows:
                nodes.append(
                    {
                        "id": r["id"],
                        "name": r["name"],
                        "filePath": r.get("filePath", ""),
                        "startLine": r.get("startLine"),
                        "label": label,
                    }
                )
        except Exception:
            pass

    # Get communities
    try:
        rows = await _query(
            db_path,
            "MATCH (c:Community) RETURN c.id AS id, c.heuristicLabel AS label, "
            "c.cohesion AS cohesion, c.symbolCount AS symbolCount",
        )
        communities = [
            {
                "id": r["id"],
                "label": r["label"],
                "cohesion": r.get("cohesion", 0),
                "symbolCount": r.get("symbolCount", 0),
            }
            for r in rows
        ]
    except Exception:
        pass

    # Get processes
    try:
        rows = await _query(
            db_path,
            "MATCH (p:Process) RETURN p.id AS id, p.heuristicLabel AS label, "
            "p.processType AS processType, p.stepCount AS stepCount",
        )
        processes = [
            {
                "id": r["id"],
                "label": r["label"],
                "processType": r.get("processType", ""),
                "stepCount": r.get("stepCount", 0),
            }
            for r in rows
        ]
    except Exception:
        pass

    # Get edges (CALLS, IMPORTS, EXTENDS, IMPLEMENTS — limited for UI perf)
    try:
        rows = await _query(
            db_path,
            "MATCH (a)-[r:CodeRelation]->(b) "
            "WHERE r.type IN ['CALLS', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS'] "
            "RETURN a.id AS sourceId, b.id AS targetId, r.type AS type, "
            "r.confidence AS confidence LIMIT 2000",
        )
        edges = [
            {
                "sourceId": r["sourceId"],
                "targetId": r["targetId"],
                "type": r["type"],
                "confidence": r.get("confidence", 1.0),
            }
            for r in rows
        ]
    except Exception:
        pass

    return {
        "nodes": nodes,
        "edges": edges,
        "communities": communities,
        "processes": processes,
    }


async def query_communities(db_path: str) -> dict:
    """List all communities with members."""
    communities = []
    try:
        rows = await _query(
            db_path,
            "MATCH (c:Community) RETURN c.id AS id, c.heuristicLabel AS label, "
            "c.cohesion AS cohesion, c.symbolCount AS symbolCount "
            "ORDER BY c.symbolCount DESC",
        )
        for r in rows:
            # Get members
            members = await _query(
                db_path,
                f"MATCH (s)-[:CodeRelation {{type: 'MEMBER_OF'}}]->(c:Community {{id: '{r['id']}'}}) "
                f"RETURN s.name AS name, s.filePath AS filePath LIMIT 20",
            )
            communities.append(
                {
                    "id": r["id"],
                    "label": r["label"],
                    "cohesion": r.get("cohesion", 0),
                    "symbolCount": r.get("symbolCount", 0),
                    "members": [
                        {"name": m["name"], "filePath": m.get("filePath", "")}
                        for m in members
                    ],
                }
            )
    except Exception as err:
        logger.debug(f"Failed to query communities: {err}")

    return {"communities": communities}


async def query_processes(db_path: str) -> dict:
    """List all processes with steps."""
    processes = []
    try:
        rows = await _query(
            db_path,
            "MATCH (p:Process) RETURN p.id AS id, p.heuristicLabel AS label, "
            "p.processType AS processType, p.stepCount AS stepCount "
            "ORDER BY p.stepCount DESC",
        )
        for r in rows:
            # Get steps
            steps = await _query(
                db_path,
                f"MATCH (s)-[r:CodeRelation {{type: 'STEP_IN_PROCESS'}}]->(p:Process {{id: '{r['id']}'}}) "
                f"RETURN s.name AS name, s.filePath AS filePath, r.step AS step "
                f"ORDER BY r.step",
            )
            processes.append(
                {
                    "id": r["id"],
                    "label": r["label"],
                    "processType": r.get("processType", ""),
                    "stepCount": r.get("stepCount", 0),
                    "steps": [
                        {
                            "name": s["name"],
                            "filePath": s.get("filePath", ""),
                            "step": s.get("step", 0),
                        }
                        for s in steps
                    ],
                }
            )
    except Exception as err:
        logger.debug(f"Failed to query processes: {err}")

    return {"processes": processes}


async def query_search(db_path: str, query: str, limit: int = 10) -> dict:
    """Simple name-based search across code symbols."""
    results = []
    search_term = query.replace("'", "\\'")

    for label in ["Function", "Class", "Method", "Interface", "Struct"]:
        try:
            rows = await _query(
                db_path,
                f"MATCH (n:`{label}`) WHERE n.name CONTAINS '{search_term}' "
                f"RETURN n.id AS id, n.name AS name, n.filePath AS filePath, "
                f"n.startLine AS startLine, '{label}' AS label LIMIT {limit}",
            )
            for r in rows:
                results.append(
                    {
                        "id": r["id"],
                        "name": r["name"],
                        "filePath": r.get("filePath", ""),
                        "startLine": r.get("startLine"),
                        "label": label,
                    }
                )
        except Exception:
            pass

    return {"results": results[:limit]}


async def query_context(
    db_path: str, symbol_name: str, file_path: Optional[str] = None
) -> dict:
    """360-degree context for a symbol."""
    safe_name = symbol_name.replace("'", "\\'")

    # Find the symbol
    where = f"n.name = '{safe_name}'"
    if file_path:
        safe_fp = file_path.replace("'", "\\'")
        where += f" AND n.filePath = '{safe_fp}'"

    symbol = None
    for label in ["Function", "Class", "Method", "Interface", "Struct", "CodeElement"]:
        try:
            rows = await _query(
                db_path,
                f"MATCH (n:`{label}`) WHERE {where} "
                f"RETURN n.id AS id, n.name AS name, n.filePath AS filePath, "
                f"n.startLine AS startLine, n.endLine AS endLine, '{label}' AS label LIMIT 1",
            )
            if rows:
                symbol = rows[0]
                break
        except Exception:
            pass

    if not symbol:
        return {"error": f"Symbol '{symbol_name}' not found"}

    sid = symbol["id"].replace("'", "\\'")

    # Incoming calls
    incoming_calls = await _query(
        db_path,
        f"MATCH (caller)-[r:CodeRelation {{type: 'CALLS'}}]->(target) "
        f"WHERE target.id = '{sid}' "
        f"RETURN caller.name AS name, caller.filePath AS filePath, r.confidence AS confidence",
    )

    # Outgoing calls
    outgoing_calls = await _query(
        db_path,
        f"MATCH (source)-[r:CodeRelation {{type: 'CALLS'}}]->(callee) "
        f"WHERE source.id = '{sid}' "
        f"RETURN callee.name AS name, callee.filePath AS filePath, r.confidence AS confidence",
    )

    # Processes
    processes = await _query(
        db_path,
        f"MATCH (s)-[r:CodeRelation {{type: 'STEP_IN_PROCESS'}}]->(p:Process) "
        f"WHERE s.id = '{sid}' "
        f"RETURN p.id AS processId, p.heuristicLabel AS label, r.step AS step, p.stepCount AS totalSteps",
    )

    # Community
    community = await _query(
        db_path,
        f"MATCH (s)-[r:CodeRelation {{type: 'MEMBER_OF'}}]->(c:Community) "
        f"WHERE s.id = '{sid}' "
        f"RETURN c.id AS id, c.heuristicLabel AS label, c.cohesion AS cohesion LIMIT 1",
    )

    return {
        "symbol": symbol,
        "incoming": {"calls": incoming_calls},
        "outgoing": {"calls": outgoing_calls},
        "processes": processes,
        "community": community[0] if community else None,
    }


async def query_impact(
    db_path: str,
    target: str,
    direction: str = "upstream",
    max_depth: int = 3,
    min_confidence: float = 0.7,
) -> dict:
    """Blast radius analysis."""
    safe_target = target.replace("'", "\\'")

    # Find target node
    target_node = None
    for label in ["Function", "Class", "Method", "Interface", "Struct"]:
        rows = await _query(
            db_path,
            f"MATCH (n:`{label}`) WHERE n.name = '{safe_target}' "
            f"RETURN n.id AS id, n.name AS name, n.filePath AS filePath, "
            f"'{label}' AS label LIMIT 1",
        )
        if rows:
            target_node = rows[0]
            break

    if not target_node:
        return {"error": f"Target '{target}' not found"}

    tid = target_node["id"].replace("'", "\\'")

    # Get dependents at each depth
    by_depth = []
    if direction == "upstream":
        # What depends on this?
        for depth in range(1, max_depth + 1):
            hops = "-[r:CodeRelation]->" * depth
            # Simplified: get direct callers/importers
            rows = await _query(
                db_path,
                f"MATCH (dep)-[r:CodeRelation]->(target) "
                f"WHERE target.id = '{tid}' AND r.type IN ['CALLS', 'IMPORTS'] "
                f"AND r.confidence >= {min_confidence} "
                f"RETURN dep.name AS name, dep.filePath AS filePath, "
                f"r.type AS edgeType, r.confidence AS confidence",
            )
            if rows:
                labels = ["WILL BREAK", "LIKELY AFFECTED", "MAY NEED TESTING"]
                by_depth.append(
                    {
                        "depth": depth,
                        "label": labels[min(depth - 1, 2)],
                        "symbols": rows,
                    }
                )
            if depth == 1:
                break  # For now, only direct dependents
    else:
        # What does this depend on?
        rows = await _query(
            db_path,
            f"MATCH (source)-[r:CodeRelation]->(dep) "
            f"WHERE source.id = '{tid}' AND r.type IN ['CALLS', 'IMPORTS'] "
            f"AND r.confidence >= {min_confidence} "
            f"RETURN dep.name AS name, dep.filePath AS filePath, "
            f"r.type AS edgeType, r.confidence AS confidence",
        )
        if rows:
            by_depth.append(
                {"depth": 1, "label": "DIRECT DEPENDENCIES", "symbols": rows}
            )

    # Affected processes
    affected_procs = await _query(
        db_path,
        f"MATCH (s)-[r:CodeRelation {{type: 'STEP_IN_PROCESS'}}]->(p:Process) "
        f"WHERE s.id = '{tid}' "
        f"RETURN p.id AS processId, p.heuristicLabel AS label, r.step AS step",
    )

    total_affected = sum(len(d.get("symbols", [])) for d in by_depth)
    risk = "LOW"
    if total_affected > 10:
        risk = "CRITICAL"
    elif total_affected > 5:
        risk = "HIGH"
    elif total_affected > 2:
        risk = "MEDIUM"

    return {
        "target": target_node,
        "risk": risk,
        "summary": {
            "directDependents": total_affected,
            "affectedProcesses": len(affected_procs),
        },
        "byDepth": by_depth,
        "affectedProcesses": affected_procs,
    }


async def query_changes(db_path: str, workspace_path: str) -> dict:
    """Map git changes to affected symbols."""
    # Get changed files from git
    try:
        result = subprocess.run(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=workspace_path,
            capture_output=True,
            text=True,
        )
        unstaged = result.stdout.strip().split("\n") if result.stdout.strip() else []

        result2 = subprocess.run(
            ["git", "diff", "--cached", "--name-only"],
            cwd=workspace_path,
            capture_output=True,
            text=True,
        )
        staged = result2.stdout.strip().split("\n") if result2.stdout.strip() else []

        changed_files = list(set(unstaged + staged))
        changed_files = [f for f in changed_files if f]
    except Exception:
        return {"error": "Failed to get git diff"}

    if not changed_files:
        return {
            "changedSymbols": [],
            "affectedProcesses": [],
            "riskLevel": "LOW",
            "summary": {"changedCount": 0, "affectedCount": 0, "changedFiles": 0},
        }

    # Find symbols in changed files
    changed_symbols = []
    for fp in changed_files:
        safe_fp = fp.replace("'", "\\'")
        for label in ["Function", "Class", "Method", "Interface"]:
            try:
                rows = await _query(
                    db_path,
                    f"MATCH (n:`{label}`) WHERE n.filePath = '{safe_fp}' "
                    f"RETURN n.name AS name, n.filePath AS filePath, '{label}' AS label",
                )
                for r in rows:
                    changed_symbols.append({**r, "changeType": "modified"})
            except Exception:
                pass

    # Find affected processes
    affected = set()
    for sym in changed_symbols:
        safe_name = sym["name"].replace("'", "\\'")
        try:
            rows = await _query(
                db_path,
                f"MATCH (s)-[:CodeRelation {{type: 'STEP_IN_PROCESS'}}]->(p:Process) "
                f"WHERE s.name = '{safe_name}' "
                f"RETURN p.id AS processId, p.heuristicLabel AS label",
            )
            for r in rows:
                affected.add((r["processId"], r["label"]))
        except Exception:
            pass

    total = len(changed_symbols)
    risk = "LOW"
    if total > 20:
        risk = "CRITICAL"
    elif total > 10:
        risk = "HIGH"
    elif total > 5:
        risk = "MEDIUM"

    return {
        "changedSymbols": changed_symbols,
        "affectedProcesses": [{"processId": p, "label": l} for p, l in affected],
        "riskLevel": risk,
        "summary": {
            "changedCount": total,
            "affectedCount": len(affected),
            "changedFiles": len(changed_files),
        },
    }


async def query_cypher(db_path: str, cypher: str) -> dict:
    """Execute raw Cypher and format as markdown table."""
    rows = await _query(db_path, cypher)
    if not rows:
        return {"markdown": "No results.", "row_count": 0}

    # Build markdown table
    cols = list(rows[0].keys())
    header = "| " + " | ".join(cols) + " |"
    sep = "| " + " | ".join(["---"] * len(cols)) + " |"
    body = "\n".join(
        "| " + " | ".join(str(r.get(c, "")) for c in cols) + " |" for r in rows[:100]
    )

    return {"markdown": f"{header}\n{sep}\n{body}", "row_count": len(rows)}
