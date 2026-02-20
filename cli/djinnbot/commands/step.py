"""Step management commands."""
import typer
from typing import Optional
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import console, print_table

app = typer.Typer(help="Step management")


def get_client(ctx: typer.Context):
    """Get client from context or create new instance."""
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("status")
def step_status(
    ctx: typer.Context,
    run_id: str = typer.Argument(..., help="Run ID"),
    step_id: str = typer.Argument(..., help="Step ID")
):
    """Show step status and details."""
    client = get_client(ctx)
    try:
        step = client.get_step(run_id, step_id)

        status = step.get("status", "unknown")
        status_colors = {
            "pending": "dim",
            "running": "yellow",
            "completed": "green",
            "failed": "red",
        }
        color = status_colors.get(status, "white")

        console.print(f"\n[bold cyan]Step: {step_id}[/bold cyan]")
        console.print(f"[dim]Run: {run_id}[/dim]\n")
        console.print(f"[bold]Agent:[/bold] {step.get('agent', 'N/A')}")
        console.print(f"[bold]Status:[/bold] [{color}]{status}[/{color}]")

        if step.get("started_at"):
            console.print(f"[bold]Started:[/bold] {step.get('started_at')}")
        if step.get("completed_at"):
            console.print(f"[bold]Completed:[/bold] {step.get('completed_at')}")
        if step.get("duration"):
            console.print(f"[bold]Duration:[/bold] {step.get('duration')}")

        if step.get("inputs"):
            console.print(f"\n[bold]Inputs:[/bold]")
            for key, value in step["inputs"].items():
                console.print(f"  {key}: {value}")

        if step.get("outputs"):
            console.print(f"\n[bold]Outputs:[/bold]")
            for key, value in step["outputs"].items():
                console.print(f"  {key}: {value}")

        if step.get("error"):
            console.print(f"\n[bold red]Error:[/bold red] {step['error']}")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("logs")
def step_logs(
    ctx: typer.Context,
    run_id: str = typer.Argument(..., help="Run ID"),
    step_id: str = typer.Argument(..., help="Step ID")
):
    """Show step logs."""
    client = get_client(ctx)
    try:
        step = client.get_step(run_id, step_id)
        logs = step.get("logs", [])

        if not logs:
            console.print("[dim]No logs found for this step[/dim]")
            return

        for log in logs:
            ts = log.get("timestamp", "")[11:19]
            level = log.get("level", "INFO")
            message = log.get("message", "")
            color = {"ERROR": "red", "WARN": "yellow"}.get(level, "white")
            console.print(f"[{ts}] [{color}]{level:5}[/{color}] {message}")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("restart")
def restart_step(
    ctx: typer.Context,
    run_id: str = typer.Argument(..., help="Run ID"),
    step_id: str = typer.Argument(..., help="Step ID"),
    context: Optional[str] = typer.Option(None, "--context", "-c", help="Additional context")
):
    """Restart a failed step."""
    client = get_client(ctx)
    try:
        result = client.restart_step(run_id, step_id, context)
        console.print(f"[green]✓ Step {step_id} restarted[/green]")
        console.print(f"  Run: {run_id}")
        if context:
            console.print(f"  Context: {context}")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
