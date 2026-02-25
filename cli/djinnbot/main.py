"""Djinnbot CLI entry point."""

from typing import Optional

import typer
from djinnbot.commands import pipeline, agent, memory, provider, setup, update
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

# Register setup and update as top-level commands (not sub-groups)
app.command("setup")(setup.setup)
app.command("update")(update.update)


@app.callback()
def main(
    ctx: typer.Context,
    url: str = typer.Option(
        "http://localhost:8000", "--url", envvar="DJINNBOT_URL", help="Server URL"
    ),
    api_key: Optional[str] = typer.Option(
        None, "--api-key", envvar="DJINNBOT_API_KEY", help="API key for authentication"
    ),
):
    """DjinnBot CLI"""
    from djinnbot.auth import resolve_token

    ctx.ensure_object(dict)
    ctx.obj["url"] = url

    # Determine auth token: explicit --api-key > env var > stored credentials
    token = api_key
    if not token:
        token = resolve_token(url)

    ctx.obj["token"] = token
    ctx.obj["client"] = DjinnBotClient(base_url=url, token=token)


def _get_client(ctx: typer.Context) -> DjinnBotClient:
    """Get the client from context, with fallback."""
    if ctx.obj:
        return ctx.obj.get("client", DjinnBotClient())
    return DjinnBotClient()


def _get_url(ctx: typer.Context) -> str:
    """Get the server URL from context."""
    if ctx.obj:
        return ctx.obj.get("url", "http://localhost:8000")
    return "http://localhost:8000"


@app.command()
def status(ctx: typer.Context):
    """Show djinnbot server status."""
    client = _get_client(ctx)
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

        # Storage backend (JuiceFS + RustFS) — present when build-from-source mode
        storage = result.get("storage")
        if storage:
            jfs_ok = storage.get("juicefs_mounted", False)
            print_status(
                "JuiceFS",
                "mounted" if jfs_ok else "not mounted",
                "green" if jfs_ok else "red",
            )
            rustfs_ok = storage.get("rustfs_healthy", False)
            print_status(
                "RustFS",
                "healthy" if rustfs_ok else "unhealthy",
                "green" if rustfs_ok else "red",
            )
            if storage.get("juicefs_volume"):
                print_status("JFS Volume", storage["juicefs_volume"])
            data_path = storage.get("data_path")
            if data_path:
                print_status("Data Path", data_path)

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
def login(
    ctx: typer.Context,
    api_key: Optional[str] = typer.Option(
        None, "--api-key", "-k", help="Log in with an API key instead of credentials"
    ),
):
    """Log in to the djinnbot server.

    Interactive login prompts for email/password. If the account has 2FA
    enabled, you'll be prompted for a TOTP code or recovery code.

    Use --api-key to authenticate with a pre-created API key instead.
    """
    from djinnbot import auth

    server_url = _get_url(ctx)

    # ── API key login ───────────────────────────────────────────────
    if api_key:
        # Validate the key works
        try:
            user_info = auth.get_current_user(server_url, api_key)
        except Exception as e:
            console.print(f"[red]API key validation failed: {e}[/red]")
            raise typer.Exit(1)

        auth.save_api_key(server_url, api_key)
        name = user_info.get("displayName") or user_info.get("email") or "unknown"
        console.print(f"[green]Logged in as {name} (API key)[/green]")
        return

    # ── Check server auth status ────────────────────────────────────
    try:
        auth_status = auth.get_auth_status(server_url)
    except Exception as e:
        console.print(f"[red]Cannot reach server: {e}[/red]")
        raise typer.Exit(1)

    if not auth_status.get("authEnabled"):
        console.print("[yellow]Authentication is not enabled on this server.[/yellow]")
        console.print("All requests are allowed without credentials.")
        return

    if not auth_status.get("setupComplete"):
        console.print(
            "[yellow]Server setup not complete — no users exist yet.[/yellow]"
        )
        console.print("Complete initial setup via the dashboard first.")
        raise typer.Exit(1)

    # ── Interactive email/password login ─────────────────────────────
    email = typer.prompt("Email")
    password = typer.prompt("Password", hide_input=True)

    try:
        result = auth.login_with_password(server_url, email, password)
    except Exception as e:
        detail = ""
        if hasattr(e, "response"):
            try:
                detail = e.response.json().get("detail", "")
            except Exception:
                pass
        console.print(f"[red]Login failed: {detail or e}[/red]")
        raise typer.Exit(1)

    # ── TOTP challenge ──────────────────────────────────────────────
    if result.get("requiresTOTP"):
        pending_token = result["pendingToken"]
        console.print("[yellow]Two-factor authentication required.[/yellow]")

        code = typer.prompt("Enter TOTP code (or 'r' for recovery code)")

        if code.strip().lower() == "r":
            recovery_code = typer.prompt("Recovery code")
            try:
                result = auth.login_with_recovery(
                    server_url, pending_token, recovery_code
                )
            except Exception as e:
                detail = ""
                if hasattr(e, "response"):
                    try:
                        detail = e.response.json().get("detail", "")
                    except Exception:
                        pass
                console.print(f"[red]Recovery code failed: {detail or e}[/red]")
                raise typer.Exit(1)

            remaining = result.get("remainingRecoveryCodes")
            if remaining is not None and remaining <= 3:
                console.print(
                    f"[yellow]Warning: only {remaining} recovery codes remaining.[/yellow]"
                )
        else:
            try:
                result = auth.login_with_totp(server_url, pending_token, code)
            except Exception as e:
                detail = ""
                if hasattr(e, "response"):
                    try:
                        detail = e.response.json().get("detail", "")
                    except Exception:
                        pass
                console.print(f"[red]TOTP verification failed: {detail or e}[/red]")
                raise typer.Exit(1)

    # ── Save tokens ─────────────────────────────────────────────────
    auth.save_tokens(
        server_url=server_url,
        access_token=result["accessToken"],
        refresh_token=result["refreshToken"],
        expires_in=result.get("expiresIn", 900),
        user=result.get("user"),
    )

    user = result.get("user", {})
    name = user.get("displayName") or user.get("email") or "unknown"
    console.print(f"[green]Logged in as {name}[/green]")


@app.command()
def logout(ctx: typer.Context):
    """Log out from the djinnbot server.

    Clears stored credentials and invalidates the server session.
    """
    from djinnbot import auth

    server_url = _get_url(ctx)
    creds = auth.load_credentials(server_url)

    if not creds:
        console.print("[dim]Not logged in.[/dim]")
        return

    # Try to invalidate server-side session for JWT auth
    if creds.get("type") == "jwt":
        access = creds.get("accessToken", "")
        refresh = creds.get("refreshToken", "")
        if access and refresh:
            auth.server_logout(server_url, access, refresh)

    auth.clear_credentials(server_url)
    console.print("[green]Logged out.[/green]")


@app.command()
def whoami(ctx: typer.Context):
    """Show the currently authenticated user."""
    from djinnbot import auth

    server_url = _get_url(ctx)
    token = ctx.obj.get("token") if ctx.obj else None

    if not token:
        console.print("[dim]Not logged in. Run [bold]djinn login[/bold] first.[/dim]")
        raise typer.Exit(1)

    try:
        user = auth.get_current_user(server_url, token)
    except Exception as e:
        console.print(f"[red]Failed to fetch user info: {e}[/red]")
        console.print(
            "[dim]Your session may have expired. Run [bold]djinn login[/bold] again.[/dim]"
        )
        raise typer.Exit(1)

    print_status("User", user.get("displayName") or user.get("email", "unknown"))
    print_status("Email", user.get("email", "—"))
    print_status("ID", user.get("id", "—"))
    print_status("Admin", "yes" if user.get("isAdmin") else "no")
    print_status("Service", "yes" if user.get("isService") else "no")
    if user.get("totpEnabled"):
        print_status("2FA", "enabled", "green")


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

    client = _get_client(ctx)
    base_url = _get_url(ctx)
    token = ctx.obj.get("token") if ctx.obj else None

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
        token=token,
    )


if __name__ == "__main__":
    app()
