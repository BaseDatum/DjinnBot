"""Memory management commands."""
import typer
from typing import Optional
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_table, console
from rich.panel import Panel
from rich.markdown import Markdown
from rich.syntax import Syntax

app = typer.Typer(help="Memory management")


def get_client(ctx: typer.Context):
    """Get client from context or create new instance."""
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


def _format_size(size: int) -> str:
    """Format file size in human-readable format."""
    if size < 1024:
        return f"{size}B"
    elif size < 1024 * 1024:
        return f"{size / 1024:.1f}KB"
    else:
        return f"{size / (1024 * 1024):.1f}MB"


@app.command("vaults")
def list_vaults(ctx: typer.Context):
    """List all memory vaults."""
    client = get_client(ctx)
    try:
        vaults = client.list_vaults()
        if not vaults:
            console.print("[yellow]No vaults found[/yellow]")
            return
        
        rows = []
        for vault in vaults:
            agent_id = vault.get("agent_id", "?")
            file_count = vault.get("file_count", 0)
            total_size = vault.get("total_size", 0)
            
            rows.append([
                agent_id,
                str(file_count),
                _format_size(total_size)
            ])
        
        print_table(["Agent ID", "Files", "Size"], rows, title="Memory Vaults")
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("list")
def list_vault_files(ctx: typer.Context, agent_id: str = typer.Argument(..., help="Agent ID")):
    """List files in a vault."""
    client = get_client(ctx)
    try:
        files = client.list_vault_files(agent_id)
        if not files:
            console.print("[yellow]No files found[/yellow]")
            return
        
        rows = []
        for file in files:
            filename = file.get("filename", "?")
            category = file.get("category", "-")
            title = file.get("title", "-")
            size = file.get("size", 0)
            preview = file.get("preview", "")[:50]
            
            rows.append([
                filename,
                category,
                title[:30],
                _format_size(size),
                preview
            ])
        
        print_table(
            ["Filename", "Category", "Title", "Size", "Preview"],
            rows,
            title=f"Files in {agent_id}"
        )
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("show")
def show_vault_file(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
    filename: str = typer.Argument(..., help="Filename")
):
    """Show full file content."""
    client = get_client(ctx)
    try:
        file = client.get_vault_file(agent_id, filename)
        
        title = file.get("title", filename)
        category = file.get("category", "unknown")
        content = file.get("content", "")
        
        console.print(f"\n[bold cyan]{title}[/bold cyan]")
        console.print(f"[dim]File: {filename} | Category: {category}[/dim]\n")
        
        # Try to syntax highlight if it looks like code
        if filename.endswith((".py", ".js", ".ts", ".json", ".yaml", ".yml")):
            ext = filename.split(".")[-1]
            syntax = Syntax(content, ext, theme="monokai", line_numbers=False)
            console.print(Panel(syntax, border_style="dim"))
        elif filename.endswith(".md"):
            # Render markdown
            md = Markdown(content)
            console.print(Panel(md, border_style="dim"))
        else:
            # Plain text
            console.print(Panel(content, border_style="dim"))
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("search")
def search_memory(
    ctx: typer.Context,
    query: str = typer.Argument(..., help="Search query"),
    agent: Optional[str] = typer.Option(None, "--agent", "-a", help="Filter by agent ID"),
    limit: int = typer.Option(20, "--limit", "-n", help="Maximum results")
):
    """Search across memory vaults."""
    client = get_client(ctx)
    try:
        results = client.search_memory(query, agent_id=agent, limit=limit)
        if not results:
            console.print("[yellow]No results found[/yellow]")
            return
        
        rows = []
        for result in results:
            agent_id = result.get("agent_id", "?")
            filename = result.get("filename", "?")
            title = result.get("title", "-")
            score = result.get("score", 0)
            preview = result.get("preview", "")[:60]
            
            rows.append([
                agent_id,
                filename,
                title[:25],
                f"{score:.2f}",
                preview
            ])
        
        print_table(
            ["Agent", "File", "Title", "Score", "Preview"],
            rows,
            title=f"Search: {query}"
        )
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("delete")
def delete_vault_file(
    ctx: typer.Context,
    agent_id: str = typer.Argument(..., help="Agent ID"),
    filename: str = typer.Argument(..., help="Filename")
):
    """Delete a file from a vault."""
    client = get_client(ctx)
    
    # Confirmation prompt
    confirm = typer.confirm(
        f"Are you sure you want to delete {filename} from {agent_id}'s vault?",
        default=False
    )
    
    if not confirm:
        console.print("[dim]Cancelled[/dim]")
        return
    
    try:
        result = client.delete_vault_file(agent_id, filename)
        console.print(f"[green]✓ Deleted {filename} from {agent_id}[/green]")
    
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
