"""Pipeline management commands."""
import typer
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_table, console
from pathlib import Path

try:
    import yaml
    HAS_YAML = True
except ImportError:
    HAS_YAML = False

app = typer.Typer(help="Pipeline management")


def get_client(ctx: typer.Context):
    """Get client from context or create new instance."""
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("list")
def list_pipelines(ctx: typer.Context):
    """List all pipelines."""
    client = get_client(ctx)
    try:
        pipelines = client.list_pipelines()
        if not pipelines:
            console.print("[yellow]No pipelines found[/yellow]")
            return

        rows = []
        for p in pipelines:
            steps = len(p.get("steps", []))
            agents = ", ".join(p.get("agents", [])[:3])
            if len(p.get("agents", [])) > 3:
                agents += "..."
            rows.append([
                p.get("id", "?"),
                p.get("name", "?"),
                str(steps),
                agents or "-"
            ])
        print_table(["ID", "Name", "Steps", "Agents"], rows, title="Pipelines")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("show")
def show_pipeline(ctx: typer.Context, pipeline_id: str):
    """Show detailed pipeline information."""
    client = get_client(ctx)
    try:
        pipeline = client.get_pipeline(pipeline_id)

        console.print(f"\n[bold cyan]{pipeline.get('name', pipeline_id)}[/bold cyan]")
        console.print(f"[dim]ID: {pipeline.get('id')}[/dim]\n")

        if pipeline.get("description"):
            console.print(f"{pipeline['description']}\n")

        steps = pipeline.get("steps", [])
        if steps:
            rows = []
            for i, step in enumerate(steps, 1):
                rows.append([
                    str(i),
                    step.get("id", "?"),
                    step.get("agent", "?"),
                    step.get("description", "-")
                ])
            print_table(["#", "Step ID", "Agent", "Description"], rows)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("validate")
def validate_pipeline(
    ctx: typer.Context,
    pipeline_id: str = typer.Argument(..., help="Pipeline ID to validate"),
    local: bool = typer.Option(False, "--local", "-l", help="Validate a local YAML file instead of server pipeline")
):
    """Validate a pipeline (server-side by ID, or local YAML file with --local)."""
    if local:
        # Local validation
        if not HAS_YAML:
            console.print("[red]pyyaml is required for local validation. Install with: pip install pyyaml[/red]")
            raise typer.Exit(1)
        
        file_path = Path(pipeline_id)
        if not file_path.exists():
            console.print(f"[red]File not found: {pipeline_id}[/red]")
            raise typer.Exit(1)
        
        try:
            with open(file_path, "r") as f:
                content = yaml.safe_load(f)
            
            # Basic structure validation
            errors = []
            if not isinstance(content, dict):
                errors.append("Root must be a mapping")
            else:
                if "id" not in content:
                    errors.append("Missing required field: id")
                if "steps" not in content:
                    errors.append("Missing required field: steps")
                elif not isinstance(content.get("steps"), list):
                    errors.append("steps must be a list")
            
            if errors:
                console.print("[red]✗ Pipeline is invalid[/red]")
                for error in errors:
                    console.print(f"[red]  • {error}[/red]")
                raise typer.Exit(1)
            else:
                console.print("[green]✓ Pipeline YAML is valid[/green]")
        except yaml.YAMLError as e:
            console.print(f"[red]YAML parse error: {e}[/red]")
            raise typer.Exit(1)
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            raise typer.Exit(1)
    else:
        # Server-side validation
        client = get_client(ctx)
        try:
            result = client.validate_pipeline(pipeline_id)
            if result.get("valid"):
                console.print("[green]✓ Pipeline is valid[/green]")
                if result.get("warnings"):
                    for warning in result["warnings"]:
                        console.print(f"[yellow]⚠ {warning}[/yellow]")
            else:
                console.print("[red]✗ Pipeline is invalid[/red]")
                for error in result.get("errors", []):
                    console.print(f"[red]  • {error}[/red]")
                raise typer.Exit(1)
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            raise typer.Exit(1)
