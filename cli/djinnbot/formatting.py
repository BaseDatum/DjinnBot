"""Rich table formatting helpers for djinnbot CLI."""
from rich.console import Console
from rich.table import Table
from rich import box

console = Console()


def print_table(headers: list[str], rows: list[list[str]], title: str = None):
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


def print_run_progress(run: dict):
    """Visual step-by-step progress for a run."""
    steps = run.get("steps", [])
    current_step = run.get("current_step_id")
    status = run.get("status", "unknown")

    status_colors = {
        "pending": "dim",
        "running": "yellow",
        "completed": "green",
        "failed": "red",
        "cancelled": "dim",
    }
    color = status_colors.get(status, "white")

    console.print(f"\n[bold]Run:[/bold] {run.get('id')}")
    console.print(f"[bold]Pipeline:[/bold] {run.get('pipeline_id')}")
    console.print(f"[bold]Status:[/bold] [{color}]{status}[/{color}]")
    console.print(f"[bold]Task:[/bold] {run.get('task', 'N/A')}\n")

    if steps:
        table = Table(box=box.SIMPLE)
        table.add_column("Step", style="cyan")
        table.add_column("Agent")
        table.add_column("Status")
        table.add_column("Duration")

        for step in steps:
            step_id = step.get("id", "?")
            agent = step.get("agent", "?")
            step_status = step.get("status", "pending")
            duration = step.get("duration", "-")

            if step_id == current_step:
                step_status = f"▶ {step_status}"

            status_color = status_colors.get(step_status.replace("▶ ", ""), "white")
            table.add_row(step_id, agent, f"[{status_color}]{step_status}[/{status_color}]", duration)

        console.print(table)
