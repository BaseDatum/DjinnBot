"""Browser cookie management commands.

djinnbot cookies list                              List all cookie sets
djinnbot cookies upload FILE --name NAME           Upload a Netscape cookie file
djinnbot cookies delete COOKIE_SET_ID              Delete a cookie set
djinnbot cookies grants AGENT_ID                   List grants for an agent
djinnbot cookies grant AGENT_ID COOKIE_SET_ID      Grant agent access
djinnbot cookies revoke AGENT_ID COOKIE_SET_ID     Revoke agent access
djinnbot cookies export                            Export cookies from local browser
"""

import os
import platform
import sqlite3
import sys
import tempfile
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.table import Table

app = typer.Typer(help="Manage browser cookies for agent browsing")
console = Console()


def _get_client(ctx: typer.Context):
    from djinnbot.client import DjinnBotClient

    return DjinnBotClient(
        base_url=ctx.obj["url"],
        token=ctx.obj.get("token"),
    )


@app.command("list")
def list_cookies(ctx: typer.Context):
    """List all uploaded cookie sets."""
    client = _get_client(ctx)
    resp = client.client.get("/v1/browser/cookies")
    resp.raise_for_status()
    sets = resp.json()

    if not sets:
        console.print("[dim]No cookie sets uploaded yet.[/dim]")
        return

    table = Table(title="Browser Cookie Sets")
    table.add_column("ID", style="dim")
    table.add_column("Name", style="bold")
    table.add_column("Domain")
    table.add_column("Cookies", justify="right")
    table.add_column("Created")

    for s in sets:
        from datetime import datetime

        created = datetime.fromtimestamp(s["created_at"] / 1000).strftime("%Y-%m-%d")
        table.add_row(s["id"], s["name"], s["domain"], str(s["cookie_count"]), created)

    console.print(table)


@app.command("upload")
def upload_cookies(
    ctx: typer.Context,
    file: Path = typer.Argument(..., help="Path to Netscape-format cookies.txt file"),
    name: str = typer.Option(
        ..., "--name", "-n", help="Name for this cookie set (e.g., LinkedIn)"
    ),
):
    """Upload a Netscape-format cookie file."""
    if not file.exists():
        console.print(f"[red]File not found: {file}[/red]")
        raise typer.Exit(1)

    client = _get_client(ctx)
    with open(file, "rb") as f:
        resp = client.client.post(
            "/v1/browser/cookies",
            data={"name": name, "user_id": "system"},
            files={"cookie_file": (file.name, f, "text/plain")},
        )
    resp.raise_for_status()
    result = resp.json()
    console.print(
        f"[green]Uploaded:[/green] {result['name']} ({result['domain']}, "
        f"{result['cookie_count']} cookies) - ID: {result['id']}"
    )


@app.command("delete")
def delete_cookies(
    ctx: typer.Context,
    cookie_set_id: str = typer.Argument(..., help="Cookie set ID to delete"),
):
    """Delete a cookie set and all its grants."""
    client = _get_client(ctx)
    resp = client.client.delete(f"/v1/browser/cookies/{cookie_set_id}")
    resp.raise_for_status()
    console.print(f"[green]Deleted cookie set {cookie_set_id}[/green]")


@app.command("grants")
def list_grants(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
):
    """List cookie grants for an agent."""
    client = _get_client(ctx)
    resp = client.client.get(f"/v1/browser/cookies/agents/{agent_id}")
    resp.raise_for_status()
    grants = resp.json()

    if not grants:
        console.print(f"[dim]No cookie grants for {agent_id}.[/dim]")
        return

    table = Table(title=f"Cookie Grants for {agent_id}")
    table.add_column("Cookie Set ID", style="dim")
    table.add_column("Name", style="bold")
    table.add_column("Domain")
    table.add_column("Granted By")

    for g in grants:
        table.add_row(
            g["cookie_set_id"],
            g.get("cookie_set_name") or "?",
            g.get("cookie_set_domain") or "?",
            g["granted_by"],
        )

    console.print(table)


@app.command("grant")
def grant_cookies(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
    cookie_set_id: str = typer.Argument(..., help="Cookie set ID"),
):
    """Grant an agent access to a cookie set."""
    client = _get_client(ctx)
    resp = client.client.post(
        f"/v1/browser/cookies/agents/{agent_id}/{cookie_set_id}/grant"
    )
    resp.raise_for_status()
    console.print(f"[green]Granted {cookie_set_id} to {agent_id}[/green]")


@app.command("revoke")
def revoke_cookies(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
    cookie_set_id: str = typer.Argument(..., help="Cookie set ID"),
):
    """Revoke an agent's access to a cookie set."""
    client = _get_client(ctx)
    resp = client.client.delete(
        f"/v1/browser/cookies/agents/{agent_id}/{cookie_set_id}"
    )
    resp.raise_for_status()
    console.print(f"[green]Revoked {cookie_set_id} from {agent_id}[/green]")


# ── Cookie export from local browser ──────────────────────────────────────


def _find_chrome_cookies_db() -> Optional[Path]:
    """Find Chrome's Cookies SQLite database."""
    system = platform.system()
    if system == "Darwin":
        p = Path.home() / "Library/Application Support/Google/Chrome/Default/Cookies"
    elif system == "Linux":
        p = Path.home() / ".config/google-chrome/Default/Cookies"
    elif system == "Windows":
        p = Path.home() / "AppData/Local/Google/Chrome/User Data/Default/Cookies"
    else:
        return None
    return p if p.exists() else None


def _find_firefox_cookies_db() -> Optional[Path]:
    """Find Firefox's cookies.sqlite database."""
    system = platform.system()
    if system == "Darwin":
        profiles_dir = Path.home() / "Library/Application Support/Firefox/Profiles"
    elif system == "Linux":
        profiles_dir = Path.home() / ".mozilla/firefox"
    elif system == "Windows":
        profiles_dir = Path.home() / "AppData/Roaming/Mozilla/Firefox/Profiles"
    else:
        return None

    if not profiles_dir.exists():
        return None

    # Find the default profile
    for profile in sorted(
        profiles_dir.iterdir(), key=lambda p: p.stat().st_mtime, reverse=True
    ):
        cookies_db = profile / "cookies.sqlite"
        if cookies_db.exists():
            return cookies_db
    return None


def _export_from_sqlite(db_path: Path, domain: Optional[str], browser: str) -> str:
    """Export cookies from a SQLite database to Netscape format."""
    # Copy the database to avoid locking issues
    with tempfile.NamedTemporaryFile(suffix=".sqlite", delete=False) as tmp:
        tmp_path = tmp.name
        import shutil

        shutil.copy2(db_path, tmp_path)

    try:
        conn = sqlite3.connect(tmp_path)
        cursor = conn.cursor()

        if browser == "chrome":
            query = "SELECT host_key, path, is_secure, expires_utc, name, value FROM cookies"
            if domain:
                query += f" WHERE host_key LIKE '%{domain}%'"
        else:  # firefox
            query = "SELECT host, path, isSecure, expiry, name, value FROM moz_cookies"
            if domain:
                query += f" WHERE host LIKE '%{domain}%'"

        cursor.execute(query)
        rows = cursor.fetchall()
        conn.close()

        lines = ["# Netscape HTTP Cookie File"]
        for row in rows:
            host, path, secure, expires, name, value = row
            # Chrome stores expiry as microseconds since 1601-01-01
            if browser == "chrome" and expires > 0:
                expires = max(0, int((expires / 1_000_000) - 11644473600))
            secure_str = "TRUE" if secure else "FALSE"
            http_only = "TRUE" if host.startswith(".") else "FALSE"
            lines.append(
                f"{host}\t{http_only}\t{path}\t{secure_str}\t{expires}\t{name}\t{value}"
            )

        return "\n".join(lines)
    finally:
        os.unlink(tmp_path)


@app.command("export")
def export_cookies(
    domain: Optional[str] = typer.Option(
        None, "--domain", "-d", help="Filter by domain (e.g., linkedin.com)"
    ),
    browser: str = typer.Option(
        "auto", "--browser", "-b", help="Browser to export from (chrome, firefox, auto)"
    ),
    output: Optional[Path] = typer.Option(
        None, "--output", "-o", help="Output file (default: stdout)"
    ),
):
    """Export cookies from your local browser in Netscape format.

    Pipe directly to upload: djinnbot cookies export -d linkedin.com | djinnbot cookies upload - --name LinkedIn
    """
    db_path = None
    detected_browser = None

    if browser in ("auto", "chrome"):
        db_path = _find_chrome_cookies_db()
        if db_path:
            detected_browser = "chrome"

    if not db_path and browser in ("auto", "firefox"):
        db_path = _find_firefox_cookies_db()
        if db_path:
            detected_browser = "firefox"

    if not db_path:
        console.print("[red]Could not find browser cookie database.[/red]")
        console.print("Supported: Chrome, Firefox")
        console.print("You can also manually export cookies using a browser extension")
        console.print(
            "like 'cookies.txt' and upload the file with: djinnbot cookies upload FILE --name NAME"
        )
        raise typer.Exit(1)

    console.print(f"[dim]Exporting from {detected_browser}: {db_path}[/dim]", err=True)

    try:
        result = _export_from_sqlite(db_path, domain, detected_browser)
    except Exception as e:
        console.print(f"[red]Export failed: {e}[/red]")
        console.print(
            "[dim]The browser may be locking the database. Try closing it first.[/dim]"
        )
        raise typer.Exit(1)

    cookie_count = len([l for l in result.splitlines() if l and not l.startswith("#")])

    if output:
        output.write_text(result)
        console.print(
            f"[green]Exported {cookie_count} cookies to {output}[/green]", err=True
        )
    else:
        sys.stdout.write(result + "\n")
        console.print(f"[dim]Exported {cookie_count} cookies[/dim]", err=True)
