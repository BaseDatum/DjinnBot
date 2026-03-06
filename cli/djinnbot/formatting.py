"""Rich table formatting helpers for djinnbot CLI."""

from rich.console import Console
from rich.table import Table
from rich import box
from typing import Optional

console = Console()


def print_table(
    headers: list[str],
    rows: list[list[str]],
    title: Optional[str] = None,
):
    """Print a formatted table."""
    table = Table(
        title=title,
        box=box.ROUNDED,
        header_style="bold cyan",
        border_style="dim",
    )
    for header in headers:
        table.add_column(header)
    for row in rows:
        table.add_row(*row)
    console.print(table)


def print_status(label: str, value: str, color: str = "green"):
    """Print a status line with colored value."""
    console.print(f"[bold]{label}:[/bold] [{color}]{value}[/{color}]")


def format_ts(ts) -> str:
    """Format epoch ms timestamp to readable string."""
    if not ts or not isinstance(ts, (int, float)):
        return "-"
    try:
        from datetime import datetime

        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")
    except Exception:
        return str(ts)


def format_size(size: int) -> str:
    """Format file size in human-readable format."""
    if size < 1024:
        return f"{size}B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f}KB"
    else:
        return f"{size / (1024 * 1024):.1f}MB"


STATUS_COLORS = {
    "pending": "dim",
    "queued": "dim",
    "running": "yellow",
    "working": "yellow",
    "thinking": "blue",
    "completed": "green",
    "failed": "red",
    "cancelled": "dim",
    "paused": "yellow",
    "idle": "dim",
    "offline": "red",
    "online": "green",
}


def colored_status(status: str) -> str:
    """Return a Rich-markup colored status string."""
    color = STATUS_COLORS.get(status, "white")
    return f"[{color}]{status}[/{color}]"


def print_run_progress(run: dict):
    """Visual step-by-step progress for a run."""
    steps = run.get("steps", [])
    current_step = run.get("current_step")
    status = run.get("status", "unknown")

    console.print(f"\n[bold]Run:[/bold] {run.get('id')}")
    console.print(f"[bold]Pipeline:[/bold] {run.get('pipeline_id')}")
    console.print(f"[bold]Status:[/bold] {colored_status(status)}")
    console.print(f"[bold]Task:[/bold] {run.get('task', 'N/A')}\n")

    if steps:
        table = Table(box=box.SIMPLE)
        table.add_column("Step", style="cyan")
        table.add_column("Agent")
        table.add_column("Status")
        table.add_column("Started")
        table.add_column("Completed")

        for s in steps:
            step_id = s.get("step_id", s.get("id", "?"))
            agent_id = s.get("agent_id", "?")
            step_status = s.get("status", "pending")
            started = format_ts(s.get("started_at"))
            completed = format_ts(s.get("completed_at"))

            indicator = ""
            if step_id == current_step:
                indicator = " >"

            table.add_row(
                f"{indicator}{step_id}",
                agent_id,
                colored_status(step_status),
                started,
                completed,
            )

        console.print(table)
