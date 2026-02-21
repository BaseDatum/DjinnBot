"""Djinnbot CLI entry point."""

from typing import Optional

import typer
from djinnbot.commands import pipeline, agent, memory, provider
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_status, console

app = typer.Typer(
    name="djinnbot",
    help="DjinnBot CLI - Agent orchestration platform",
    no_args_is_help=True,
)

app.add_typer(pipeline.app, name="pipeline")
app.add_typer(agent.app, name="agent")
app.add_typer(memory.app, name="memory")
app.add_typer(provider.app, name="provider")


@app.callback()
def main(
    ctx: typer.Context,
    url: str = typer.Option(
        "http://localhost:8000", "--url", envvar="DJINNBOT_URL", help="Server URL"
    ),
):
    """DjinnBot CLI"""
    ctx.ensure_object(dict)
    ctx.obj["url"] = url
    ctx.obj["client"] = DjinnBotClient(base_url=url)


@app.command()
def status(ctx: typer.Context):
    """Show djinnbot server status."""
    client: DjinnBotClient = ctx.obj.get("client") if ctx.obj else DjinnBotClient()
    try:
        result = client.get_status()
        print_status("Server", result.get("status", "unknown"))
        print_status("Version", result.get("version", "unknown"))

        redis_ok = result.get("redis_connected", False)
        print_status(
            "Redis",
            "connected" if redis_ok else "disconnected",
            "green" if redis_ok else "red",
        )

        print_status("Active Runs", str(result.get("active_runs", 0)))
        print_status("Pipelines", str(result.get("total_pipelines", 0)))
        print_status("Agents", str(result.get("total_agents", 0)))

        gh = result.get("github", {})
        if gh.get("configured"):
            gh_status = "healthy" if gh.get("healthy") else "unhealthy"
            gh_color = "green" if gh.get("healthy") else "red"
            print_status("GitHub App", gh_status, gh_color)
    except Exception as e:
        console.print(f"[red]Error connecting to server: {e}[/red]")
        raise typer.Exit(1)


@app.command()
def chat(
    ctx: typer.Context,
    agent_name: Optional[str] = typer.Option(
        None, "--agent", "-a", help="Agent ID to chat with"
    ),
    model: Optional[str] = typer.Option(
        None, "--model", "-m", help="Model to use for chat"
    ),
):
    """Start an interactive chat session with an agent."""
    from djinnbot.chat import run_chat
    from djinnbot.picker import pick_agent, pick_model

    client: DjinnBotClient = ctx.obj.get("client") if ctx.obj else DjinnBotClient()
    base_url: str = (
        ctx.obj.get("url", "http://localhost:8000")
        if ctx.obj
        else "http://localhost:8000"
    )

    # ── Resolve agent ───────────────────────────────────────────────
    if not agent_name:
        try:
            agents = client.list_agents()
        except Exception as e:
            console.print(f"[red]Error fetching agents: {e}[/red]")
            raise typer.Exit(1)

        if not agents:
            console.print("[red]No agents found on the server[/red]")
            raise typer.Exit(1)

        agent_name = pick_agent(agents)
        if not agent_name:
            console.print("[dim]Cancelled[/dim]")
            raise typer.Exit(0)

    # ── Resolve model ───────────────────────────────────────────────
    if not model:
        try:
            available_models = client.get_available_models()
        except Exception as e:
            console.print(
                f"[yellow]Warning: Could not load models from server: {e}[/yellow]"
            )
            available_models = []

        if not available_models:
            console.print(
                "[red]No models available. Configure API keys in the dashboard first.[/red]"
            )
            raise typer.Exit(1)

        model = pick_model(available_models)
        if not model:
            console.print("[dim]Cancelled[/dim]")
            raise typer.Exit(0)

    # ── Get display name for the agent ──────────────────────────────
    display_name = agent_name
    try:
        agent_info = client.get_agent(agent_name)
        emoji = agent_info.get("emoji") or ""
        display_name = f"{emoji} {agent_info.get('name', agent_name)}".strip()
    except Exception:
        pass

    console.print(
        f"\n[bold]Starting chat with {display_name} using {model}...[/bold]\n"
    )

    # ── Launch TUI ──────────────────────────────────────────────────
    run_chat(
        base_url=base_url,
        agent_id=agent_name,
        agent_name=display_name,
        model=model,
    )


if __name__ == "__main__":
    app()
