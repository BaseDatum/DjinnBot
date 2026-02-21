"""Agent management commands."""

import typer
from typing import Optional
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_table, console, colored_status, format_ts

app = typer.Typer(help="Agent management")


def _get_client(ctx: typer.Context) -> DjinnBotClient:
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("list")
def list_agents(ctx: typer.Context):
    """List all agents."""
    client = _get_client(ctx)
    try:
        agents = client.list_agents()
        if not agents:
            console.print("[yellow]No agents found[/yellow]")
            return

        rows = []
        for a in agents:
            emoji = a.get("emoji") or ""
            name = a.get("name", "?")
            role = a.get("role") or "-"
            slack = "yes" if a.get("slack_connected") else "no"
            mem_count = str(a.get("memory_count", 0))
            rows.append(
                [f"{emoji} {name}".strip(), a.get("id", "?"), role, slack, mem_count]
            )

        print_table(
            ["Agent", "ID", "Role", "Slack", "Memory Files"],
            rows,
            title="Agents",
        )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("show")
def show_agent(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
):
    """Show detailed agent information."""
    client = _get_client(ctx)
    try:
        agent = client.get_agent(agent_id)

        emoji = agent.get("emoji") or ""
        name = agent.get("name", agent_id)
        console.print(f"\n[bold cyan]{emoji} {name}[/bold cyan]")
        console.print(f"[dim]ID: {agent.get('id', '?')}[/dim]\n")

        if agent.get("role"):
            console.print(f"[bold]Role:[/bold] {agent['role']}")
        if agent.get("description"):
            console.print(f"[bold]Description:[/bold] {agent['description']}")
        if agent.get("slack_connected"):
            console.print("[bold]Slack:[/bold] connected")

        persona_files = agent.get("persona_files", [])
        if persona_files:
            console.print(f"\n[bold]Persona Files:[/bold]")
            for f in persona_files:
                console.print(f"  - {f}")

        soul_preview = agent.get("soul_preview")
        if soul_preview:
            from rich.panel import Panel

            console.print(f"\n[bold]Soul Preview:[/bold]")
            preview = (
                soul_preview[:300] + "..." if len(soul_preview) > 300 else soul_preview
            )
            console.print(Panel(preview, border_style="dim"))

    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("status")
def agent_status(
    ctx: typer.Context,
    agent_id: Optional[str] = typer.Argument(
        None, help="Agent ID (omit for fleet overview)"
    ),
):
    """Show runtime status of agent(s)."""
    client = _get_client(ctx)
    try:
        if agent_id:
            status = client.get_agent_status(agent_id)

            emoji = status.get("emoji") or ""
            name = status.get("name", agent_id)
            state = status.get("status", "offline")
            console.print(
                f"\n[bold cyan]{emoji} {name}[/bold cyan] - {colored_status(state)}"
            )

            if status.get("last_seen"):
                console.print(
                    f"[bold]Last Seen:[/bold] {format_ts(status['last_seen'])}"
                )

            active_steps = status.get("active_steps", [])
            if active_steps:
                console.print(f"\n[bold]Active Steps:[/bold]")
                rows = []
                for s in active_steps:
                    rows.append(
                        [
                            s.get("run_id", "?")[:12],
                            s.get("step_id", "?"),
                            s.get("started_at", "-"),
                        ]
                    )
                print_table(["Run", "Step", "Started"], rows)
            else:
                console.print("\n[dim]No active steps[/dim]")

            if status.get("current_run"):
                console.print(f"[bold]Current Run:[/bold] {status['current_run']}")
        else:
            data = client.get_agents_status()
            agents_list = data.get("agents", [])
            summary = data.get("summary", {})

            if not agents_list:
                console.print("[yellow]No agents found[/yellow]")
                return

            # Print summary
            console.print(f"\n[bold]Fleet Summary:[/bold]")
            console.print(
                f"  Total: {summary.get('total', 0)} | "
                f"Idle: {summary.get('idle', 0)} | "
                f"Working: {summary.get('working', 0)} | "
                f"Thinking: {summary.get('thinking', 0)} | "
                f"Queued: {summary.get('totalQueued', 0)}"
            )
            console.print()

            rows = []
            for a in agents_list:
                emoji = a.get("emoji") or ""
                name = a.get("name", "?")
                state = a.get("state", "idle")
                queue_len = str(a.get("queueLength", 0))
                work = ""
                if a.get("currentWork"):
                    cw = a["currentWork"]
                    work = f"{cw.get('step', '?')} ({cw.get('runId', '?')[:8]})"

                rows.append(
                    [
                        f"{emoji} {name}".strip(),
                        colored_status(state),
                        queue_len,
                        work or "-",
                    ]
                )

            print_table(
                ["Agent", "State", "Queue", "Current Work"],
                rows,
                title="Agent Status",
            )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("runs")
def agent_runs(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
):
    """Show runs the agent participated in."""
    client = _get_client(ctx)
    try:
        runs = client.get_agent_runs(agent_id)
        if not runs:
            console.print("[yellow]No runs found[/yellow]")
            return

        rows = []
        for r in runs:
            rows.append(
                [
                    r.get("run_id", "?")[:12],
                    r.get("pipeline_id", "?"),
                    colored_status(r.get("status", "?")),
                    (r.get("task") or "-")[:50],
                    format_ts(r.get("created_at")),
                ]
            )

        print_table(
            ["Run ID", "Pipeline", "Status", "Task", "Created"],
            rows,
            title=f"Runs for {agent_id}",
        )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("config")
def agent_config(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
):
    """Show agent configuration."""
    client = _get_client(ctx)
    try:
        config = client.get_agent_config(agent_id)
        if not config:
            console.print("[dim]No configuration found[/dim]")
            return

        console.print(f"\n[bold cyan]Config for {agent_id}[/bold cyan]\n")
        for key, value in config.items():
            console.print(f"  [bold]{key}:[/bold] {value}")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("projects")
def agent_projects(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
):
    """List projects an agent is assigned to."""
    client = _get_client(ctx)
    try:
        projects = client.get_agent_projects(agent_id)
        if not projects:
            console.print("[yellow]No projects found[/yellow]")
            return

        rows = []
        for p in projects:
            rows.append(
                [
                    p.get("project_id", "?")[:12],
                    p.get("project_name", "?"),
                    p.get("role", "-"),
                    p.get("project_status", "-"),
                ]
            )

        print_table(
            ["Project ID", "Name", "Role", "Status"],
            rows,
            title=f"Projects for {agent_id}",
        )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
