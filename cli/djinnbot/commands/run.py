"""Run management commands."""
import typer
from datetime import datetime
from typing import Optional
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_table, console, print_run_progress

app = typer.Typer(help="Run management")


def _format_ts(ts) -> str:
    """Format epoch ms timestamp to readable string."""
    if not ts or not isinstance(ts, (int, float)):
        return "-"
    try:
        return datetime.fromtimestamp(ts / 1000).strftime("%Y-%m-%d %H:%M")
    except:
        return str(ts)


def get_client(ctx: typer.Context):
    """Get client from context or create new instance."""
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("start")
def start_run(
    ctx: typer.Context,
    pipeline_id: str = typer.Argument(..., help="Pipeline ID to run"),
    task: str = typer.Argument(..., help="Task description"),
    context: Optional[str] = typer.Option(None, "--context", "-c", help="Additional context")
):
    """Start a new pipeline run."""
    client = get_client(ctx)
    try:
        result = client.start_run(pipeline_id, task, context)
        run_id = result.get("id")
        console.print(f"[green]✓ Run started:[/green] {run_id}")
        console.print(f"  Pipeline: {pipeline_id}")
        console.print(f"  Task: {task}")
    except Exception as e:
        console.print(f"[red]Error starting run: {e}[/red]")
        raise typer.Exit(1)


@app.command("list")
def list_runs(
    ctx: typer.Context,
    pipeline: Optional[str] = typer.Option(None, "--pipeline", "-p", help="Filter by pipeline ID"),
    status: Optional[str] = typer.Option(None, "--status", "-s", help="Filter by status")
):
    """List pipeline runs."""
    client = get_client(ctx)
    try:
        runs = client.list_runs(pipeline_id=pipeline, status=status)
        if not runs:
            console.print("[yellow]No runs found[/yellow]")
            return

        rows = []
        for run in runs:
            status_color = {
                "completed": "green",
                "running": "yellow",
                "failed": "red",
                "pending": "dim",
            }.get(run.get("status"), "white")

            rows.append([
                run.get("id", "?")[:8],
                run.get("pipeline_id", "?"),
                f"[{status_color}]{run.get('status', '?')}[/{status_color}]",
                _format_ts(run.get("created_at"))
            ])
        print_table(["Run ID", "Pipeline", "Status", "Created"], rows, title="Pipeline Runs")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("status")
def run_status(ctx: typer.Context, run_id: str = typer.Argument(..., help="Run ID to check")):
    """Show step-by-step run progress."""
    client = get_client(ctx)
    try:
        run = client.get_run(run_id)
        print_run_progress(run)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("logs")
def run_logs(
    ctx: typer.Context,
    run_id: str = typer.Argument(..., help="Run ID"),
    follow: bool = typer.Option(False, "--follow", "-f", help="Follow log output")
):
    """Show run logs."""
    client = get_client(ctx)
    try:
        if follow:
            console.print("[dim]Following events via SSE (Ctrl+C to exit)...[/dim]\n")
            for event in client.stream_run_events(run_id):
                event_type = event.get("type", "unknown")
                ts = ""
                if event.get("timestamp"):
                    from datetime import datetime
                    try:
                        dt = datetime.fromtimestamp(event["timestamp"] / 1000)
                        ts = dt.strftime("%H:%M:%S")
                    except:
                        ts = str(event["timestamp"])

                # Color based on event type
                type_colors = {
                    "RUN_CREATED": "cyan",
                    "STEP_QUEUED": "dim",
                    "STEP_STARTED": "yellow",
                    "STEP_COMPLETE": "green",
                    "STEP_FAILED": "red",
                    "STEP_RETRYING": "yellow",
                    "STEP_CANCELLED": "dim",
                    "RUN_COMPLETE": "green bold",
                    "RUN_FAILED": "red bold",
                    "HUMAN_INTERVENTION": "magenta",
                    "AGENT_MESSAGE": "blue",
                }
                color = type_colors.get(event_type, "white")

                # Format message based on event type
                msg = ""
                if event_type == "RUN_CREATED":
                    msg = f"Pipeline: {event.get('pipelineId', '?')} | Task: {event.get('taskDescription', '?')}"
                elif event_type in ("STEP_QUEUED", "STEP_STARTED"):
                    msg = f"Step: {event.get('stepId', '?')}"
                    if event.get("agentId"):
                        msg += f" | Agent: {event['agentId']}"
                    if event.get("sessionId"):
                        msg += f" | Session: {event['sessionId'][:12]}"
                elif event_type == "STEP_COMPLETE":
                    outputs = event.get("outputs", {})
                    output_str = ", ".join(f"{k}={v[:50]}" for k, v in outputs.items()) if outputs else "no outputs"
                    msg = f"Step: {event.get('stepId', '?')} | {output_str}"
                elif event_type == "STEP_FAILED":
                    msg = f"Step: {event.get('stepId', '?')} | Error: {event.get('error', '?')}"
                elif event_type == "STEP_RETRYING":
                    msg = f"Step: {event.get('stepId', '?')} | {event.get('feedback', '')}"
                elif event_type in ("RUN_COMPLETE", "RUN_FAILED"):
                    msg = event.get("error") or ", ".join(f"{k}={v[:50]}" for k, v in event.get("outputs", {}).items())
                elif event_type == "AGENT_MESSAGE":
                    msg = f"{event.get('from', '?')} → {event.get('to', '?')}: {event.get('message', '')}"
                elif event_type == "HUMAN_INTERVENTION":
                    msg = f"Action: {event.get('action', '?')} | {event.get('context', '')}"
                else:
                    msg = str(event)

                console.print(f"[dim][{ts}][/dim] [{color}]{event_type:20}[/{color}] {msg}")
        else:
            logs = client.get_run_logs(run_id)
            if not logs:
                console.print("[dim]No logs found[/dim]")
                return
            for event in logs:
                event_type = event.get("type", "unknown")
                ts = ""
                if event.get("timestamp"):
                    from datetime import datetime
                    try:
                        dt = datetime.fromtimestamp(event["timestamp"] / 1000)
                        ts = dt.strftime("%H:%M:%S")
                    except:
                        ts = ""

                type_colors = {
                    "STEP_COMPLETE": "green", "STEP_FAILED": "red",
                    "STEP_STARTED": "yellow", "RUN_COMPLETE": "green",
                    "RUN_FAILED": "red",
                }
                color = type_colors.get(event_type, "dim")

                step = event.get("stepId", "")
                detail = event.get("error", "") or event.get("feedback", "") or ""
                if event.get("outputs"):
                    detail = ", ".join(f"{k}={v[:50]}" for k, v in event["outputs"].items())

                console.print(f"[dim][{ts}][/dim] [{color}]{event_type:20}[/{color}] {step} {detail}")
    except KeyboardInterrupt:
        console.print("\n[dim]Stopped following logs[/dim]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("cancel")
def cancel_run(ctx: typer.Context, run_id: str = typer.Argument(..., help="Run ID to cancel")):
    """Cancel a running pipeline."""
    client = get_client(ctx)
    try:
        result = client.cancel_run(run_id)
        console.print(f"[green]✓ Run {run_id} cancelled[/green]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("restart")
def restart_run(
    ctx: typer.Context,
    run_id: str = typer.Argument(..., help="Run ID to restart"),
    context: Optional[str] = typer.Option(None, "--context", "-c", help="Additional context")
):
    """Restart a run from scratch."""
    client = get_client(ctx)
    try:
        result = client.restart_run(run_id, context)
        console.print(f"[green]✓ Run {run_id} restarted[/green]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("pause")
def pause_run(ctx: typer.Context, run_id: str = typer.Argument(..., help="Run ID to pause")):
    """Pause a running pipeline."""
    client = get_client(ctx)
    try:
        result = client.pause_run(run_id)
        console.print(f"[green]✓ Run {run_id} paused[/green]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("resume")
def resume_run(ctx: typer.Context, run_id: str = typer.Argument(..., help="Run ID to resume")):
    """Resume a paused pipeline."""
    client = get_client(ctx)
    try:
        result = client.resume_run(run_id)
        console.print(f"[green]✓ Run {run_id} resumed[/green]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
