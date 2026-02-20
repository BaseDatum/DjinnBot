"""Agent management commands."""
import typer
from typing import Optional
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_table, console
from rich.panel import Panel
from rich.markdown import Markdown

app = typer.Typer(help="Agent management")


def get_client(ctx: typer.Context):
    """Get client from context or create new instance."""
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("list")
def list_agents(ctx: typer.Context):
    """List all agents."""
    client = get_client(ctx)
    try:
        agents = client.list_agents()
        if not agents:
            console.print("[yellow]No agents found[/yellow]")
            return

        rows = []
        for agent in agents:
            emoji = agent.get("emoji", "🤖")
            name = agent.get("name", "?")
            role = agent.get("role", "-")
            slack_status = agent.get("slack_status", "-")
            memory_count = len(agent.get("memory_files", []))
            
            rows.append([
                f"{emoji} {name}",
                role,
                slack_status,
                str(memory_count)
            ])
        
        print_table(["Agent", "Role", "Slack Status", "Memory"], rows, title="Agents")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("show")
def show_agent(ctx: typer.Context, agent_id: str = typer.Argument(..., help="Agent ID")):
    """Show detailed agent information."""
    client = get_client(ctx)
    try:
        agent = client.get_agent(agent_id)
        
        emoji = agent.get("emoji", "🤖")
        name = agent.get("name", agent_id)
        console.print(f"\n[bold cyan]{emoji} {name}[/bold cyan]")
        console.print(f"[dim]ID: {agent.get('id', '?')}[/dim]\n")
        
        # Basic info
        if agent.get("role"):
            console.print(f"[bold]Role:[/bold] {agent['role']}")
        if agent.get("slack_status"):
            console.print(f"[bold]Slack Status:[/bold] {agent['slack_status']}")
        if agent.get("model"):
            console.print(f"[bold]Model:[/bold] {agent['model']}")
        
        # Persona files
        persona_files = agent.get("persona_files", [])
        if persona_files:
            console.print(f"\n[bold]Persona Files:[/bold]")
            for file in persona_files:
                console.print(f"  • {file}")
        
        # Soul preview
        soul = agent.get("soul")
        if soul:
            console.print(f"\n[bold]Soul:[/bold]")
            preview = soul[:300] + "..." if len(soul) > 300 else soul
            console.print(Panel(preview, border_style="dim"))
        
        # Config
        config = agent.get("config", {})
        if config:
            console.print(f"\n[bold]Config:[/bold]")
            for key, value in config.items():
                console.print(f"  {key}: {value}")
        
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("status")
def agent_status(
    ctx: typer.Context,
    agent_id: Optional[str] = typer.Argument(None, help="Agent ID (if not specified, shows all agents)")
):
    """Show runtime status of agent(s)."""
    client = get_client(ctx)
    try:
        if agent_id:
            # Single agent status
            status = client.get_agent_status(agent_id)
            
            emoji = status.get("emoji", "🤖")
            name = status.get("name", agent_id)
            online = status.get("online", False)
            status_text = "[green]online[/green]" if online else "[dim]offline[/dim]"
            
            console.print(f"\n[bold cyan]{emoji} {name}[/bold cyan] — {status_text}")
            
            active_steps = status.get("active_steps", [])
            if active_steps:
                console.print(f"\n[bold]Active Steps:[/bold]")
                rows = []
                for step in active_steps:
                    rows.append([
                        step.get("run_id", "?")[:8],
                        step.get("step_id", "?"),
                        step.get("started_at", "-")
                    ])
                print_table(["Run", "Step", "Started"], rows)
            else:
                console.print("\n[dim]No active steps[/dim]")
        else:
            # All agents status
            statuses = client.get_agents_status()
            if not statuses:
                console.print("[yellow]No agents found[/yellow]")
                return
            
            rows = []
            for status in statuses:
                emoji = status.get("emoji", "🤖")
                name = status.get("name", "?")
                online = status.get("online", False)
                status_text = "[green]●[/green]" if online else "[dim]○[/dim]"
                active_count = len(status.get("active_steps", []))
                
                rows.append([
                    status_text,
                    f"{emoji} {name}",
                    str(active_count)
                ])
            
            print_table(["", "Agent", "Active Steps"], rows, title="Agent Status")
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("runs")
def agent_runs(ctx: typer.Context, agent_id: str = typer.Argument(..., help="Agent ID")):
    """Show runs the agent participated in."""
    client = get_client(ctx)
    try:
        runs = client.get_agent_runs(agent_id)
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
                run.get("task_description", "-")[:50]
            ])
        
        print_table(["Run ID", "Pipeline", "Status", "Task"], rows, title=f"Runs for {agent_id}")
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("memory")
def agent_memory(ctx: typer.Context, agent_id: str = typer.Argument(..., help="Agent ID")):
    """List memory files for an agent."""
    client = get_client(ctx)
    try:
        files = client.get_agent_memory(agent_id)
        if not files:
            console.print("[yellow]No memory files found[/yellow]")
            return
        
        rows = []
        for file in files:
            filename = file.get("filename", "?")
            category = file.get("category", "-")
            size = file.get("size", 0)
            size_kb = f"{size / 1024:.1f}KB" if size > 0 else "-"
            
            rows.append([
                filename,
                category,
                size_kb
            ])
        
        print_table(["Filename", "Category", "Size"], rows, title=f"Memory for {agent_id}")
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
