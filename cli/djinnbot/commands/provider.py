"""Provider and API key management commands."""

import typer
from typing import Optional
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import print_table, console, colored_status

app = typer.Typer(help="Model provider management")


def _get_client(ctx: typer.Context) -> DjinnBotClient:
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


@app.command("list")
def list_providers(ctx: typer.Context):
    """List all model providers and their configuration status."""
    client = _get_client(ctx)
    try:
        providers = client.list_providers()
        if not providers:
            console.print("[yellow]No providers found[/yellow]")
            return

        rows = []
        for p in providers:
            pid = p.get("providerId", "?")
            name = p.get("name", pid)
            configured = p.get("configured", False)
            enabled = p.get("enabled", False)
            model_count = len(p.get("models", []))
            masked_key = p.get("maskedApiKey") or ""

            if configured and enabled:
                status = colored_status("online")
            elif configured:
                status = "[yellow]disabled[/yellow]"
            else:
                status = "[dim]not configured[/dim]"

            rows.append(
                [
                    name,
                    pid,
                    status,
                    str(model_count) if model_count else "[dim]live[/dim]",
                    masked_key or "[dim]-[/dim]",
                ]
            )

        print_table(
            ["Provider", "ID", "Status", "Models", "API Key"],
            rows,
            title="Model Providers",
        )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("show")
def show_provider(
    ctx: typer.Context,
    provider_id: str = typer.Argument(..., help="Provider ID"),
):
    """Show detailed provider information and available models."""
    client = _get_client(ctx)
    try:
        providers = client.list_providers()
        provider = next(
            (p for p in providers if p.get("providerId") == provider_id), None
        )
        if not provider:
            console.print(f"[red]Provider '{provider_id}' not found[/red]")
            raise typer.Exit(1)

        name = provider.get("name", provider_id)
        console.print(f"\n[bold cyan]{name}[/bold cyan]")
        console.print(f"[dim]ID: {provider_id}[/dim]\n")

        if provider.get("description"):
            console.print(f"{provider['description']}\n")

        console.print(
            f"[bold]Configured:[/bold] {'yes' if provider.get('configured') else 'no'}"
        )
        console.print(
            f"[bold]Enabled:[/bold] {'yes' if provider.get('enabled') else 'no'}"
        )

        if provider.get("maskedApiKey"):
            console.print(f"[bold]API Key:[/bold] {provider['maskedApiKey']}")
        if provider.get("docsUrl"):
            console.print(f"[bold]Docs:[/bold] {provider['docsUrl']}")
        if provider.get("apiKeyEnvVar"):
            console.print(f"[bold]Env Var:[/bold] {provider['apiKeyEnvVar']}")

        extra_fields = provider.get("extraFields", [])
        masked_extra = provider.get("maskedExtraConfig", {})
        if extra_fields:
            console.print(f"\n[bold]Extra Configuration:[/bold]")
            for field in extra_fields:
                env_var = field.get("envVar", "")
                label = field.get("label", env_var)
                value = masked_extra.get(env_var, "") if masked_extra else ""
                required = " [red](required)[/red]" if field.get("required") else ""
                if value:
                    console.print(f"  {label}: {value}{required}")
                else:
                    console.print(f"  {label}: [dim]not set[/dim]{required}")

        # Fetch live models
        console.print(f"\n[bold]Models:[/bold]")
        try:
            result = client.get_provider_models(provider_id)
            models = result.get("models", [])
            source = result.get("source", "static")
            if models:
                console.print(f"  [dim]({len(models)} models, source: {source})[/dim]")
                # Show first 20
                for m in models[:20]:
                    reasoning = (
                        " [blue][reasoning][/blue]" if m.get("reasoning") else ""
                    )
                    console.print(f"  - {m.get('id', '?')}{reasoning}")
                if len(models) > 20:
                    console.print(f"  [dim]... and {len(models) - 20} more[/dim]")
            else:
                console.print("  [dim]No models available[/dim]")
        except Exception:
            static_models = provider.get("models", [])
            if static_models:
                for m in static_models:
                    console.print(f"  - {m.get('id', '?')}")
            else:
                console.print("  [dim]No models listed[/dim]")

    except typer.Exit:
        raise
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("set-key")
def set_key(
    ctx: typer.Context,
    provider_id: str = typer.Argument(
        ..., help="Provider ID (e.g. anthropic, openrouter, openai)"
    ),
    api_key: Optional[str] = typer.Argument(
        None, help="API key (omit to be prompted securely)"
    ),
):
    """Set or update an API key for a model provider."""
    client = _get_client(ctx)

    # If no key provided as argument, prompt for it securely
    if not api_key:
        # Show provider info first
        try:
            providers = client.list_providers()
            provider = next(
                (p for p in providers if p.get("providerId") == provider_id), None
            )
            if provider:
                name = provider.get("name", provider_id)
                docs = provider.get("docsUrl", "")
                console.print(f"\n[bold]{name}[/bold] ({provider_id})")
                if docs:
                    console.print(f"Get your API key at: [cyan]{docs}[/cyan]")
                if provider.get("maskedApiKey"):
                    console.print(f"Current key: {provider['maskedApiKey']}")
                console.print()
        except Exception:
            pass

        api_key = typer.prompt("API key", hide_input=True)
        if not api_key or not api_key.strip():
            console.print("[red]No key provided[/red]")
            raise typer.Exit(1)

    try:
        result = client.upsert_provider(provider_id, api_key=api_key.strip())
        configured = result.get("configured", False)
        masked = result.get("maskedApiKey", "")
        if configured:
            console.print(f"[green]API key set for {provider_id}[/green] ({masked})")
        else:
            console.print(
                f"[yellow]Key saved but provider may need additional configuration[/yellow]"
            )
            extra_fields = result.get("extraFields", [])
            required = [f for f in extra_fields if f.get("required")]
            if required:
                console.print("[bold]Required extra fields:[/bold]")
                for f in required:
                    console.print(
                        f"  - {f.get('label', f.get('envVar', '?'))}: {f.get('description', '')}"
                    )
                console.print(
                    f"\nUse: djinn provider set-extra {provider_id} <ENV_VAR> <VALUE>"
                )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("set-extra")
def set_extra(
    ctx: typer.Context,
    provider_id: str = typer.Argument(..., help="Provider ID"),
    env_var: str = typer.Argument(..., help="Environment variable name"),
    value: Optional[str] = typer.Argument(None, help="Value (omit to be prompted)"),
):
    """Set an extra configuration field for a provider (e.g. Azure base URL)."""
    client = _get_client(ctx)

    if not value:
        value = typer.prompt(f"Value for {env_var}")
        if not value or not value.strip():
            console.print("[red]No value provided[/red]")
            raise typer.Exit(1)

    try:
        result = client.upsert_provider(
            provider_id, extra_config={env_var: value.strip()}
        )
        console.print(f"[green]Set {env_var} for {provider_id}[/green]")
        if result.get("configured"):
            console.print(f"Provider is now fully configured")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("enable")
def enable_provider(
    ctx: typer.Context,
    provider_id: str = typer.Argument(..., help="Provider ID"),
):
    """Enable a provider."""
    client = _get_client(ctx)
    try:
        client.upsert_provider(provider_id, enabled=True)
        console.print(f"[green]{provider_id} enabled[/green]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("disable")
def disable_provider(
    ctx: typer.Context,
    provider_id: str = typer.Argument(..., help="Provider ID"),
):
    """Disable a provider (keeps API key)."""
    client = _get_client(ctx)
    try:
        client.upsert_provider(provider_id, enabled=False)
        console.print(f"[yellow]{provider_id} disabled[/yellow]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("remove")
def remove_provider(
    ctx: typer.Context,
    provider_id: str = typer.Argument(..., help="Provider ID"),
):
    """Remove a provider's API key and configuration."""
    client = _get_client(ctx)
    confirm = typer.confirm(
        f"Remove API key and config for {provider_id}?", default=False
    )
    if not confirm:
        console.print("[dim]Cancelled[/dim]")
        return
    try:
        client.delete_provider(provider_id)
        console.print(f"[green]{provider_id} configuration removed[/green]")
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)


@app.command("models")
def list_models(
    ctx: typer.Context,
    provider_id: Optional[str] = typer.Argument(
        None, help="Provider ID (omit for all configured providers)"
    ),
):
    """List available models (from configured providers only)."""
    client = _get_client(ctx)
    try:
        if provider_id:
            result = client.get_provider_models(provider_id)
            models = result.get("models", [])
            source = result.get("source", "static")
            if not models:
                console.print(f"[yellow]No models available for {provider_id}[/yellow]")
                return

            rows = []
            for m in models:
                reasoning = "yes" if m.get("reasoning") else ""
                rows.append(
                    [
                        m.get("id", "?"),
                        m.get("name", "?"),
                        reasoning,
                    ]
                )
            print_table(
                ["Model ID", "Name", "Reasoning"],
                rows,
                title=f"Models for {provider_id} (source: {source})",
            )
        else:
            models = client.get_available_models()
            if not models:
                console.print(
                    "[yellow]No models available. Configure API keys first.[/yellow]"
                )
                console.print(
                    "[dim]Use: djinn provider set-key <provider-id> <api-key>[/dim]"
                )
                return

            rows = []
            for m in models:
                reasoning = "yes" if m.get("reasoning") else ""
                rows.append(
                    [
                        m.get("id", "?"),
                        m.get("provider", "?"),
                        reasoning,
                    ]
                )
            print_table(
                ["Model ID", "Provider", "Reasoning"],
                rows,
                title=f"Available Models ({len(models)})",
            )
    except Exception as e:
        console.print(f"[red]Error: {e}[/red]")
        raise typer.Exit(1)
