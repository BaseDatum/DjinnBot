"""Djinnbot CLI entry point."""
import typer
from djinnbot.commands import pipeline, run, step, agent, memory
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_status, console

app = typer.Typer(
    name="djinnbot",
    help="DjinnBot CLI — Agent orchestration framework",
    no_args_is_help=True,
)

app.add_typer(pipeline.app, name="pipeline")
app.add_typer(run.app, name="run")
app.add_typer(step.app, name="step")
app.add_typer(agent.app, name="agent")
app.add_typer(memory.app, name="memory")


@app.callback()
def main(
    ctx: typer.Context,
    url: str = typer.Option("http://localhost:8000", "--url", help="Server URL")
):
    """DjinnBot CLI"""
    ctx.ensure_object(dict)
    ctx.obj["url"] = url
    ctx.obj["client"] = DjinnBotClient(base_url=url)


@app.command()
def status(ctx: typer.Context):
    """Show djinnbot server status"""
    client = ctx.obj.get("client") if ctx.obj else DjinnBotClient()
    try:
        result = client.get_status()
        print_status("Server", result.get("status", "unknown"))
        print_status("Version", result.get("version", "unknown"))
        redis_ok = result.get("redis_connected", False)
        print_status("Redis", "connected" if redis_ok else "disconnected", "green" if redis_ok else "red")
        print_status("Active Runs", str(result.get("active_runs", 0)))
        print_status("Pipelines", str(result.get("total_pipelines", 0)))
        print_status("Agents", str(result.get("total_agents", 0)))
    except Exception as e:
        console.print(f"[red]Error connecting to server: {e}[/red]")
        raise typer.Exit(1)


if __name__ == "__main__":
    app()
