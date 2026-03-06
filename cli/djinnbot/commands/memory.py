"""Memory management commands."""

import typer
from typing import Optional
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_table, console, format_size

app = typer.Typer(help="Memory vault management")


def _get_client(ctx: typer.Context) -> DjinnBotClient:
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("vaults")
def list_vaults(ctx: typer.Context):
    """List all memory vaults."""
    client = _get_client(ctx)
    try:
        vaults = client.list_vaults()
        if not vaults:
            console.print("[yellow]No vaults found[/yellow]")
            return

        rows = []
        for vault in vaults:
            rows.append(
                [
                    vault.get("agent_id", "?"),
                    str(vault.get("file_count", 0)),
                    format_size(vault.get("total_size_bytes", 0)),
                ]
            )

        print_table(["Agent ID", "Files", "Size"], rows, title="Memory Vaults")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("list")
def list_vault_files(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
):
    """List files in a vault."""
    client = _get_client(ctx)
    try:
        files = client.list_vault_files(agent_id)
        if not files:
            console.print("[yellow]No files found[/yellow]")
            return

        rows = []
        for f in files:
            category = f.get("category") or "-"
            title = (f.get("title") or "-")[:30]
            size = format_size(f.get("size_bytes", 0))
            preview = (f.get("preview") or "")[:50]

            rows.append(
                [
                    f.get("filename", "?"),
                    category,
                    title,
                    size,
                    preview,
                ]
            )

        print_table(
            ["Filename", "Category", "Title", "Size", "Preview"],
            rows,
            title=f"Files in {agent_id}",
        )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("show")
def show_vault_file(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
    filename: str = typer.Argument(..., help="Filename (supports subdirectory paths)"),
):
    """Show full file content."""
    client = _get_client(ctx)
    try:
        result = client.get_vault_file(agent_id, filename)

        console.print(f"\n[bold cyan]{filename}[/bold cyan]")

        metadata = result.get("metadata", {})
        if metadata:
            meta_parts = []
            if metadata.get("title"):
                meta_parts.append(f"Title: {metadata['title']}")
            if metadata.get("category"):
                meta_parts.append(f"Category: {metadata['category']}")
            if meta_parts:
                console.print(f"[dim]{' | '.join(meta_parts)}[/dim]")

        console.print()

        content = result.get("content", "")

        # Try syntax highlighting for known file types
        if filename.endswith((".py", ".js", ".ts", ".json", ".yaml", ".yml")):
            from rich.syntax import Syntax

            ext = filename.rsplit(".", 1)[-1]
            syntax = Syntax(content, ext, theme="monokai", line_numbers=False)
            from rich.panel import Panel

            console.print(Panel(syntax, border_style="dim"))
        elif filename.endswith(".md"):
            from rich.markdown import Markdown
            from rich.panel import Panel

            md = Markdown(content)
            console.print(Panel(md, border_style="dim"))
        else:
            from rich.panel import Panel

            console.print(Panel(content, border_style="dim"))
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("search")
def search_memory(
    ctx: typer.Context,
    query: str = typer.Argument(..., help="Search query"),
    agent: Optional[str] = typer.Option(
        None, "--agent", "-a", help="Filter by agent ID"
    ),
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum results"),
):
    """Search across memory vaults."""
    client = _get_client(ctx)
    try:
        results = client.search_memory(query, agent_id=agent, limit=limit)
        if not results:
            console.print("[yellow]No results found[/yellow]")
            return

        rows = []
        for r in results:
            snippet = (r.get("snippet") or "")[:60]
            rows.append(
                [
                    r.get("agent_id", "?"),
                    r.get("filename", "?"),
                    str(r.get("score", 0)),
                    snippet,
                ]
            )

        print_table(
            ["Agent", "File", "Score", "Snippet"],
            rows,
            title=f"Search: {query}",
        )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("delete")
def delete_vault_file(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
    filename: str = typer.Argument(..., help="Filename"),
):
    """Delete a file from an agent's vault."""
    client = _get_client(ctx)

    confirm = typer.confirm(
        f"Delete {filename} from {agent_id}'s vault?",
        default=False,
    )
    if not confirm:
        console.print("[dim]Cancelled[/dim]")
        return

    try:
        client.delete_vault_file(agent_id, filename)
        console.print(f"[green]Deleted {filename} from {agent_id}[/green]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
