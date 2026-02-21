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


def _get_client(ctx: typer.Context) -> DjinnBotClient:
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("list")
def list_pipelines(ctx: typer.Context):
    """List all pipelines."""
    client = _get_client(ctx)
    try:
        pipelines = client.list_pipelines()
        if not pipelines:
            console.print("[yellow]No pipelines found[/yellow]")
            return

        rows = []
        for p in pipelines:
            step_count = len(p.get("steps", []))
            agents = ", ".join(str(a) for a in p.get("agents", [])[:3])
            if len(p.get("agents", [])) > 3:
                agents += "..."
            rows.append(
                [
                    p.get("id", "?"),
                    p.get("name", "?"),
                    p.get("description", "-") or "-",
                    str(step_count),
                    agents or "-",
                ]
            )
        print_table(
            ["ID", "Name", "Description", "Steps", "Agents"],
            rows,
            title="Pipelines",
        )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("show")
def show_pipeline(
    ctx: typer.Context,
    pipeline_id: str = typer.Argument(..., help="Pipeline ID"),
):
    """Show detailed pipeline information."""
    client = _get_client(ctx)
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
                if isinstance(step, dict):
                    rows.append(
                        [
                            str(i),
                            step.get("id", step.get("name", "?")),
                            step.get("agent", step.get("agent_id", "?")),
                            step.get("description", "-"),
                        ]
                    )
                else:
                    rows.append([str(i), str(step), "-", "-"])
            print_table(["#", "Step ID", "Agent", "Description"], rows)
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("validate")
def validate_pipeline(
    ctx: typer.Context,
    pipeline_id: str = typer.Argument(..., help="Pipeline ID or local YAML file path"),
    local: bool = typer.Option(
        False, "--local", "-l", help="Validate a local YAML file"
    ),
):
    """Validate a pipeline (server-side by ID, or local YAML file with --local)."""
    if local:
        if not HAS_YAML:
            console.print(
                "[red]pyyaml is required for local validation. Install with: pip install pyyaml[/red]"
            )
            raise typer.Exit(1)

        file_path = Path(pipeline_id)
        if not file_path.exists():
            console.print(f"[red]File not found: {pipeline_id}[/red]")
            raise typer.Exit(1)

        try:
            with open(file_path, "r") as f:
                content = yaml.safe_load(f)

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
                console.print("[red]Pipeline is invalid[/red]")
                for error in errors:
                    console.print(f"[red]  - {error}[/red]")
                raise typer.Exit(1)
            else:
                console.print("[green]Pipeline YAML is valid[/green]")
        except yaml.YAMLError as e:
            console.print(f"[red]YAML parse error: {e}[/red]")
            raise typer.Exit(1)
    else:
        client = _get_client(ctx)
        try:
            result = client.validate_pipeline(pipeline_id)
            if result.get("valid"):
                console.print("[green]Pipeline is valid[/green]")
                for warning in result.get("warnings", []):
                    console.print(f"[yellow]  Warning: {warning}[/yellow]")
            else:
                console.print("[red]Pipeline is invalid[/red]")
                for error in result.get("errors", []):
                    console.print(f"[red]  - {error}[/red]")
                raise typer.Exit(1)
        except Exception as e:
            console.print(f"[red]Error: {e}[/red]")
            raise typer.Exit(1)


@app.command("raw")
def show_raw(
    ctx: typer.Context,
    pipeline_id: str = typer.Argument(..., help="Pipeline ID"),
):
    """Show raw YAML for a pipeline."""
    client = _get_client(ctx)
    try:
        result = client.get_pipeline_raw(pipeline_id)
        yaml_content = result.get("yaml", "")
        if yaml_content:
            from rich.syntax import Syntax

            syntax = Syntax(yaml_content, "yaml", theme="monokai", line_numbers=True)
            console.print(syntax)
        else:
            console.print("[dim]No YAML content[/dim]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
