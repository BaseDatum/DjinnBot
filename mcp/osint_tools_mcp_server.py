#!/usr/bin/env python3
"""
OSINT Tools MCP Server
Exposes OSINT tools (Sherlock, Holehe, Maigret, theHarvester, SpiderFoot,
GHunt, Blackbird) to AI agents via MCP stdio.

SpiderFoot is exposed as an async job pair (start / status) so the agent
is not blocked during long-running scans.

Based on https://github.com/frishtik/osint-tools-mcp-server (MIT).
"""

import asyncio
import json
import os
import sys
import uuid
from pathlib import Path
from typing import Any, Dict, List, Optional

# ---------------------------------------------------------------------------
# In-memory job store for long-running scans (SpiderFoot)
# ---------------------------------------------------------------------------

_jobs: Dict[str, Dict[str, Any]] = {}

# ---------------------------------------------------------------------------
# Output directory helper — prefer JuiceFS (/jfs/osint-outputs) for persistent
# storage, fall back to /tmp when JuiceFS is not mounted.
# ---------------------------------------------------------------------------

OSINT_OUTPUT_BASE = os.environ.get("OSINT_OUTPUT_DIR", "/jfs/osint-outputs")


def _output_dir(tool_name: str) -> str:
    """Return (and create) a timestamped output directory for a tool run."""
    from datetime import datetime

    ts = datetime.utcnow().strftime("%Y%m%d-%H%M%S")
    run_id = uuid.uuid4().hex[:8]
    d = os.path.join(OSINT_OUTPUT_BASE, tool_name, f"{ts}-{run_id}")
    os.makedirs(d, exist_ok=True)
    return d


# ---------------------------------------------------------------------------
# Subprocess helper
# ---------------------------------------------------------------------------


async def run_command(
    command: List[str],
    cwd: Optional[str] = None,
    input_data: Optional[str] = None,
    timeout: Optional[int] = None,
) -> tuple[str, str, int]:
    """Run a command as a subprocess and return (stdout, stderr, returncode)."""
    process = None
    try:
        env = os.environ.copy()
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE if input_data else None,
        )
        stdout, stderr = await asyncio.wait_for(
            process.communicate(input=input_data.encode() if input_data else None),
            timeout=timeout,
        )
        return (
            stdout.decode("utf-8", errors="ignore"),
            stderr.decode("utf-8", errors="ignore"),
            process.returncode or 0,
        )
    except asyncio.TimeoutError:
        if process is not None:
            process.kill()
        return "", "Command timed out", 1
    except Exception as e:
        return "", str(e), 1


# ---------------------------------------------------------------------------
# Tool handlers
# ---------------------------------------------------------------------------


async def handle_sherlock(params: Dict[str, Any]) -> Dict[str, Any]:
    username = params["username"]
    timeout = params.get("timeout", 60)
    sites = params.get("sites", [])
    output_format = params.get("output_format", "csv")

    # Use persistent JuiceFS-backed output dir instead of /tmp to avoid
    # disk exhaustion on the container's tiny tmpfs overlay.
    output_dir = _output_dir("sherlock")

    cmd = ["sherlock", username, "--timeout", str(timeout)]
    if sites:
        for site in sites:
            cmd.extend(["--site", site])
    if output_format == "csv":
        cmd.append("--csv")
    elif output_format == "xlsx":
        cmd.append("--xlsx")

    cmd.extend(["--folderoutput", output_dir])
    stdout, stderr, rc = await run_command(cmd, timeout=300)
    if rc == 0:
        results: Dict[str, Any] = {"stdout": stdout, "files": []}
        for fp in Path(output_dir).glob(f"{username}.*"):
            try:
                results["files"].append(
                    {"filename": fp.name, "content": fp.read_text("utf-8")}
                )
            except Exception:
                pass
        return {"success": True, "content": results}
    return {"success": False, "error": f"Sherlock failed: {stderr}"}


async def handle_holehe(params: Dict[str, Any]) -> Dict[str, Any]:
    email = params["email"]
    only_used = params.get("only_used", True)
    timeout = params.get("timeout", 60)

    cmd = ["holehe", email, "--timeout", str(timeout)]
    if only_used:
        cmd.append("--only-used")

    stdout, stderr, rc = await run_command(cmd, timeout=300)
    if rc == 0:
        return {"success": True, "content": stdout}
    return {"success": False, "error": f"Holehe failed: {stderr}"}


async def handle_maigret(params: Dict[str, Any]) -> Dict[str, Any]:
    username = params["username"]
    timeout = params.get("timeout", 60)
    output_dir = _output_dir("maigret")

    cmd = [
        "maigret",
        username,
        "--timeout",
        str(timeout),
        "--json",
        "simple",
        "--folderoutput",
        output_dir,
    ]
    stdout, stderr, rc = await run_command(cmd, timeout=600)
    if rc == 0:
        # Collect any generated report files
        results: Dict[str, Any] = {"stdout": stdout, "files": []}
        for fp in Path(output_dir).glob("*"):
            if fp.is_file():
                try:
                    results["files"].append(
                        {"filename": fp.name, "content": fp.read_text("utf-8")}
                    )
                except Exception:
                    pass
        return {"success": True, "content": results}
    return {"success": False, "error": f"Maigret failed: {stderr}"}


async def handle_theharvester(params: Dict[str, Any]) -> Dict[str, Any]:
    domain = params["domain"]
    sources = params.get("sources", "all")
    limit = params.get("limit", 500)

    # The binary name depends on how the package was installed.
    # Try 'theHarvester' first (pipx / git install), then 'theharvester' (apt).
    import shutil

    binary = shutil.which("theHarvester") or shutil.which("theharvester")
    if not binary:
        return {
            "success": False,
            "error": "theHarvester binary not found in PATH. "
            "Ensure it is installed (uv tool install git+https://github.com/laramies/theHarvester.git).",
        }

    cmd = [binary, "-d", domain, "-b", sources, "-l", str(limit)]
    stdout, stderr, rc = await run_command(cmd, timeout=600)
    if rc == 0:
        return {"success": True, "content": stdout}
    return {"success": False, "error": f"theHarvester failed: {stderr}"}


async def handle_ghunt(params: Dict[str, Any]) -> Dict[str, Any]:
    identifier = params["identifier"]

    cmd = ["ghunt", "email", identifier]
    stdout, stderr, rc = await run_command(cmd, timeout=300)
    if rc == 0:
        return {"success": True, "content": stdout}
    return {"success": False, "error": f"GHunt failed: {stderr}"}


async def handle_blackbird(params: Dict[str, Any]) -> Dict[str, Any]:
    username = params["username"]
    timeout = params.get("timeout", 60)

    cmd = [
        "python3",
        "/opt/blackbird/blackbird.py",
        "-u",
        username,
        "--timeout",
        str(timeout),
    ]
    stdout, stderr, rc = await run_command(cmd, cwd="/opt/blackbird", timeout=300)
    if rc == 0:
        return {"success": True, "content": stdout}
    return {"success": False, "error": f"Blackbird failed: {stderr}"}


# ---------------------------------------------------------------------------
# SpiderFoot async job handlers
# ---------------------------------------------------------------------------


async def _run_spiderfoot(job_id: str, target: str):
    """Background coroutine that runs SpiderFoot and stores the result."""
    cmd = [
        "python3",
        "/opt/spiderfoot/sf.py",
        "-s",
        target,
        "-u",
        "all",
        "-o",
        "json",
        "-q",
    ]
    stdout, stderr, rc = await run_command(cmd, timeout=3600)
    if rc == 0:
        _jobs[job_id].update({"status": "completed", "result": stdout, "error": None})
    else:
        _jobs[job_id].update(
            {
                "status": "failed",
                "result": None,
                "error": f"SpiderFoot failed: {stderr}",
            }
        )


async def handle_spiderfoot_start(params: Dict[str, Any]) -> Dict[str, Any]:
    target = params["target"]
    job_id = str(uuid.uuid4())[:8]
    _jobs[job_id] = {
        "status": "running",
        "target": target,
        "result": None,
        "error": None,
    }
    asyncio.create_task(_run_spiderfoot(job_id, target))
    return {
        "success": True,
        "job_id": job_id,
        "message": (
            f"SpiderFoot scan started for '{target}'. "
            f"Use spiderfoot_scan_status with job_id='{job_id}' to check progress. "
            "Scans typically take 5-30 minutes."
        ),
    }


async def handle_spiderfoot_status(params: Dict[str, Any]) -> Dict[str, Any]:
    job_id = params["job_id"]
    job = _jobs.get(job_id)
    if not job:
        return {"success": False, "error": f"No job found with id '{job_id}'"}
    if job["status"] == "running":
        return {
            "success": True,
            "status": "running",
            "message": (
                f"SpiderFoot scan for '{job['target']}' is still running. "
                "Check back in a few minutes."
            ),
        }
    if job["status"] == "completed":
        return {"success": True, "status": "completed", "content": job["result"]}
    return {"success": False, "status": "failed", "error": job["error"]}


# ---------------------------------------------------------------------------
# Tool router
# ---------------------------------------------------------------------------

TOOL_HANDLERS = {
    "sherlock_username_search": handle_sherlock,
    "holehe_email_search": handle_holehe,
    "maigret_username_search": handle_maigret,
    "theharvester_domain_search": handle_theharvester,
    "ghunt_google_search": handle_ghunt,
    "blackbird_username_search": handle_blackbird,
    "spiderfoot_scan_start": handle_spiderfoot_start,
    "spiderfoot_scan_status": handle_spiderfoot_status,
}

# ---------------------------------------------------------------------------
# Tool definitions (returned on tools/list)
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "name": "sherlock_username_search",
        "description": "Search for a username across 399+ social media platforms and websites. Returns a list of platforms where the username exists. Typically completes in 1-3 minutes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "Username to search for"},
                "timeout": {
                    "type": "integer",
                    "description": "Per-site timeout in seconds (default: 60)",
                },
                "sites": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Specific sites to search (omit to search all)",
                },
                "output_format": {
                    "type": "string",
                    "enum": ["txt", "csv", "xlsx"],
                    "description": "Output format (default: csv)",
                },
            },
            "required": ["username"],
        },
    },
    {
        "name": "holehe_email_search",
        "description": "Check if an email address is registered on 120+ platforms. Fast and accurate -- usually completes in under a minute. Good starting point for email-based investigations.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "email": {
                    "type": "string",
                    "description": "Email address to investigate",
                },
                "only_used": {
                    "type": "boolean",
                    "description": "Show only platforms where the email IS registered (default: true)",
                },
                "timeout": {
                    "type": "integer",
                    "description": "Per-site timeout in seconds (default: 60)",
                },
            },
            "required": ["email"],
        },
    },
    {
        "name": "spiderfoot_scan_start",
        "description": (
            "Start a comprehensive SpiderFoot OSINT scan. SpiderFoot runs 200+ modules "
            "that query DNS, WHOIS, search engines, paste sites, breach databases, cert "
            "transparency logs, and more. It auto-detects the target type (IP, domain, "
            "email, phone, username, person name, Bitcoin address, network block, BGP AS). "
            "\n\n"
            "IMPORTANT: Scans take 5-30 minutes to complete. This tool returns immediately "
            "with a job_id. Use spiderfoot_scan_status to poll for results. Do NOT block "
            "on this -- continue the conversation and check back later. For quick lookups, "
            "prefer the targeted tools (sherlock, holehe, theharvester, etc.) instead."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "description": "Target to scan -- SpiderFoot auto-detects type from: IP, domain, email, phone, username, person name, Bitcoin address, network block, or BGP AS",
                },
            },
            "required": ["target"],
        },
    },
    {
        "name": "spiderfoot_scan_status",
        "description": (
            "Check the status of a running SpiderFoot scan and retrieve results when complete. "
            "Returns 'running' if the scan is still in progress, 'completed' with full results, "
            "or 'failed' with an error message. SpiderFoot scans typically take 5-30 minutes."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "job_id": {
                    "type": "string",
                    "description": "The job_id returned by spiderfoot_scan_start",
                },
            },
            "required": ["job_id"],
        },
    },
    {
        "name": "ghunt_google_search",
        "description": "Extract information from a Google account using an email address or Google ID. Returns account details and associated information. Usually completes in 1-2 minutes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "identifier": {
                    "type": "string",
                    "description": "Email address or Google ID to search",
                },
            },
            "required": ["identifier"],
        },
    },
    {
        "name": "maigret_username_search",
        "description": "Search for a username across 3000+ sites with false positive detection and detailed confidence-scored analysis. More thorough than Sherlock but slower. Typically completes in 3-8 minutes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "Username to search for"},
                "timeout": {
                    "type": "integer",
                    "description": "Per-site timeout in seconds (default: 60)",
                },
            },
            "required": ["username"],
        },
    },
    {
        "name": "theharvester_domain_search",
        "description": "Gather emails, subdomains, hosts, employee names, open ports and banners from public sources for a given domain. Typically completes in 2-5 minutes.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "domain": {
                    "type": "string",
                    "description": "Domain or company name to search",
                },
                "sources": {
                    "type": "string",
                    "description": "Comma-separated data sources (default: all). Options include: baidu, bing, certspotter, crtsh, dnsdumpster, duckduckgo, github-code, google, hackertarget, hunter, otx, rapiddns, securityTrails, virustotal, yahoo, etc.",
                },
                "limit": {
                    "type": "integer",
                    "description": "Max results to return (default: 500)",
                },
            },
            "required": ["domain"],
        },
    },
    {
        "name": "blackbird_username_search",
        "description": "Lightning-fast username search across 581 sites. Fastest of the username OSINT tools -- use this for quick checks. Typically completes in under a minute.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "username": {"type": "string", "description": "Username to search for"},
                "timeout": {
                    "type": "integer",
                    "description": "Per-site timeout in seconds (default: 60)",
                },
            },
            "required": ["username"],
        },
    },
]

# ---------------------------------------------------------------------------
# MCP stdio server
# ---------------------------------------------------------------------------


async def main():
    """Main MCP server loop -- JSON-RPC over stdio."""
    reader = asyncio.StreamReader()
    protocol = asyncio.StreamReaderProtocol(reader)
    await asyncio.get_event_loop().connect_read_pipe(lambda: protocol, sys.stdin)

    while True:
        line = await reader.readline()
        if not line:
            break

        try:
            request = json.loads(line.strip())
        except json.JSONDecodeError as e:
            print(
                json.dumps(
                    {
                        "jsonrpc": "2.0",
                        "id": None,
                        "error": {"code": -32700, "message": f"Parse error: {e}"},
                    }
                ),
                flush=True,
            )
            continue

        method = request.get("method")
        params = request.get("params", {})
        request_id = request.get("id")

        try:
            if method == "initialize":
                response = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "protocolVersion": "2024-11-05",
                        "capabilities": {"tools": {}},
                        "serverInfo": {
                            "name": "osint-tools-mcp-server",
                            "version": "1.1.0",
                        },
                    },
                }

            elif method == "notifications/initialized":
                # Client acknowledgement -- no response needed for notifications
                continue

            elif method == "tools/list":
                response = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {"tools": TOOLS},
                }

            elif method == "tools/call":
                tool_name = params.get("name")
                tool_params = params.get("arguments", {})
                handler = TOOL_HANDLERS.get(tool_name)

                if handler:
                    result = await handler(tool_params)
                else:
                    result = {"success": False, "error": f"Unknown tool: {tool_name}"}

                response = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "result": {
                        "content": [
                            {"type": "text", "text": json.dumps(result, indent=2)}
                        ]
                    },
                }

            else:
                response = {
                    "jsonrpc": "2.0",
                    "id": request_id,
                    "error": {
                        "code": -32601,
                        "message": f"Method not found: {method}",
                    },
                }

        except Exception as e:
            response = {
                "jsonrpc": "2.0",
                "id": request_id,
                "error": {"code": -32603, "message": f"Internal error: {e}"},
            }

        print(json.dumps(response), flush=True)


if __name__ == "__main__":
    asyncio.run(main())
