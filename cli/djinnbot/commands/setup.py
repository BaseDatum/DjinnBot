"""Interactive setup wizard for DjinnBot.

Handles first-time configuration: cloning the repo, generating secrets,
configuring model providers, starting the Docker stack, and optional
SSL/TLS setup with Traefik.

Designed to be idempotent — safe to re-run.
"""

import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich import box

console = Console()

# Keys that must be generated for the app to work
REQUIRED_SECRETS = {
    "SECRET_ENCRYPTION_KEY": ("token_hex", 32),
    "ENGINE_INTERNAL_TOKEN": ("token_urlsafe", 32),
    "AUTH_SECRET_KEY": ("token_urlsafe", 64),
    "MCPO_API_KEY": ("token_urlsafe", 32),
}

SUPPORTED_PROVIDERS = [
    ("openrouter", "OpenRouter", "Access to all models (recommended)"),
    ("anthropic", "Anthropic", "Claude models"),
    ("openai", "OpenAI", "GPT models"),
    ("google", "Google", "Gemini models"),
    ("xai", "xAI", "Grok models"),
    ("groq", "Groq", "Fast open-source models"),
    ("mistral", "Mistral", "Mistral models"),
]

# Map provider ID to .env variable name (for bootstrap key in .env)
PROVIDER_ENV_KEYS = {
    "openrouter": "OPENROUTER_API_KEY",
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "google": "GEMINI_API_KEY",
    "xai": "XAI_API_KEY",
    "groq": "GROQ_API_KEY",
    "mistral": "MISTRAL_API_KEY",
}

REPO_URL = "https://github.com/BaseDatum/djinnbot.git"

# ── .env helpers ────────────────────────────────────────────────────────────


def get_env_value(env_path: Path, key: str) -> str:
    """Read a value from a .env file. Returns empty string if not found."""
    if not env_path.exists():
        return ""
    for line in env_path.read_text().splitlines():
        stripped = line.strip()
        if stripped.startswith("#") or "=" not in stripped:
            continue
        k, _, v = stripped.partition("=")
        if k.strip() == key:
            return v.strip()
    return ""


def set_env_value(env_path: Path, key: str, value: str) -> None:
    """Set a key=value in a .env file. Replaces existing or appends."""
    if not env_path.exists():
        env_path.write_text(f"{key}={value}\n")
        return

    content = env_path.read_text()
    pattern = rf"^({re.escape(key)}\s*=).*$"
    new_line = f"{key}={value}"

    new_content, count = re.subn(pattern, new_line, content, flags=re.MULTILINE)
    if count == 0:
        # Key doesn't exist — append
        if not new_content.endswith("\n"):
            new_content += "\n"
        new_content += f"{key}={value}\n"

    env_path.write_text(new_content)


# ── Utility helpers ─────────────────────────────────────────────────────────


def generate_secret(method: str, length: int) -> str:
    if method == "token_hex":
        return secrets.token_hex(length)
    return secrets.token_urlsafe(length)


def check_port(port: int) -> bool:
    """Return True if port is available (nothing listening)."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex(("127.0.0.1", port)) != 0


def detect_external_ip() -> Optional[str]:
    """Detect the external/public IP address."""
    for url in [
        "https://ifconfig.me",
        "https://icanhazip.com",
        "https://api.ipify.org",
    ]:
        try:
            result = subprocess.run(
                ["curl", "-s", "--max-time", "5", url],
                capture_output=True,
                text=True,
                timeout=10,
            )
            ip = result.stdout.strip()
            if ip and re.match(r"^\d+\.\d+\.\d+\.\d+$", ip):
                return ip
        except Exception:
            continue

    # Fallback: hostname
    try:
        result = subprocess.run(
            ["hostname", "-I"],
            capture_output=True,
            text=True,
            timeout=5,
        )
        parts = result.stdout.strip().split()
        if parts:
            return parts[0]
    except Exception:
        pass

    return None


def run_cmd(
    cmd: list[str],
    cwd: Optional[Path] = None,
    env: Optional[dict] = None,
    stream: bool = False,
    check: bool = True,
) -> subprocess.CompletedProcess:
    """Run a command with error handling."""
    merged_env = {**os.environ, **(env or {})}
    try:
        if stream:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                env=merged_env,
                check=check,
            )
        else:
            result = subprocess.run(
                cmd,
                cwd=cwd,
                env=merged_env,
                capture_output=True,
                text=True,
                check=check,
            )
        return result
    except subprocess.CalledProcessError as e:
        stderr = e.stderr if hasattr(e, "stderr") and e.stderr else ""
        console.print(f"[red]Command failed:[/red] {' '.join(cmd)}")
        if stderr:
            console.print(f"[dim]{stderr[:1000]}[/dim]")
        raise
    except FileNotFoundError:
        console.print(f"[red]Command not found:[/red] {cmd[0]}")
        raise


def docker_cmd() -> list[str]:
    """Return the docker command prefix, using sudo if needed."""
    try:
        subprocess.run(
            ["docker", "ps"],
            capture_output=True,
            timeout=10,
            check=True,
        )
        return ["docker"]
    except (subprocess.CalledProcessError, FileNotFoundError):
        pass

    # Try with sudo
    try:
        subprocess.run(
            ["sudo", "docker", "ps"],
            capture_output=True,
            timeout=10,
            check=True,
        )
        console.print(
            "[yellow]Using sudo for docker commands. "
            "Log out and back in to use docker without sudo.[/yellow]"
        )
        return ["sudo", "docker"]
    except Exception:
        pass

    console.print("[red]Cannot access Docker. Is Docker running?[/red]")
    raise typer.Exit(1)


def wait_for_health(url: str, timeout: int = 180) -> bool:
    """Poll a URL until it returns 200 or timeout."""
    console.print(f"[dim]Waiting for {url} ...[/dim]")
    start = time.time()
    while time.time() - start < timeout:
        try:
            result = subprocess.run(
                ["curl", "-sf", "--max-time", "3", url],
                capture_output=True,
                timeout=10,
            )
            if result.returncode == 0:
                return True
        except Exception:
            pass
        time.sleep(3)
    return False


# ── Setup steps ─────────────────────────────────────────────────────────────


def step_locate_repo(install_dir: Optional[str]) -> Path:
    """Find or clone the DjinnBot repository."""
    console.print(Panel("[bold]Step 1: Locate DjinnBot Repository[/bold]"))

    # Check if a directory was explicitly provided
    if install_dir:
        repo_dir = Path(install_dir).expanduser().resolve()
        if repo_dir.exists() and (repo_dir / "docker-compose.yml").exists():
            console.print(f"[green]Using existing repo at {repo_dir}[/green]")
            return repo_dir
        # Clone to this directory
        return _clone_repo(repo_dir)

    # Check if CWD is a djinnbot repo
    cwd = Path.cwd()
    if (cwd / "docker-compose.yml").exists() and (cwd / ".env.example").exists():
        console.print(f"[green]Found DjinnBot repo in current directory: {cwd}[/green]")
        return cwd

    # Ask user
    default_dir = Path.home() / "djinnbot"
    response = typer.prompt(
        "Where should DjinnBot be installed?",
        default=str(default_dir),
    )
    repo_dir = Path(response).expanduser().resolve()

    if repo_dir.exists() and (repo_dir / "docker-compose.yml").exists():
        console.print(f"[green]Using existing repo at {repo_dir}[/green]")
        return repo_dir

    return _clone_repo(repo_dir)


def _clone_repo(target: Path) -> Path:
    """Clone the DjinnBot repo to target directory."""
    console.print(f"Cloning DjinnBot to {target} ...")
    target.parent.mkdir(parents=True, exist_ok=True)
    try:
        run_cmd(["git", "clone", REPO_URL, str(target)], stream=True)
    except Exception:
        console.print(
            f"[red]Failed to clone repository.[/red]\n"
            f"[dim]You can clone manually: git clone {REPO_URL} {target}[/dim]"
        )
        raise typer.Exit(1)
    console.print(f"[green]Repository cloned to {target}[/green]")
    return target


def step_configure_env(repo_dir: Path) -> Path:
    """Copy .env.example to .env if needed."""
    console.print(Panel("[bold]Step 2: Configure Environment[/bold]"))

    env_path = repo_dir / ".env"
    example_path = repo_dir / ".env.example"

    if env_path.exists():
        console.print("[green].env file already exists[/green]")
        overwrite = typer.confirm(
            "Overwrite with fresh .env.example? (existing secrets will be lost)",
            default=False,
        )
        if overwrite:
            shutil.copy2(example_path, env_path)
            console.print("[green]Copied .env.example → .env[/green]")
    else:
        if not example_path.exists():
            console.print("[red].env.example not found in repo[/red]")
            raise typer.Exit(1)
        shutil.copy2(example_path, env_path)
        console.print("[green]Created .env from .env.example[/green]")

    return env_path


def step_generate_secrets(env_path: Path) -> None:
    """Generate all required encryption keys."""
    console.print(Panel("[bold]Step 3: Generate Encryption Keys[/bold]"))

    generated = []
    skipped = []

    for key, (method, length) in REQUIRED_SECRETS.items():
        existing = get_env_value(env_path, key)
        if existing and existing not in ("", "changeme"):
            skipped.append(key)
            continue

        value = generate_secret(method, length)
        set_env_value(env_path, key, value)
        generated.append(key)

    if generated:
        console.print(f"[green]Generated {len(generated)} secret(s):[/green]")
        for k in generated:
            console.print(f"  [dim]{k}[/dim]")

    if skipped:
        console.print(
            f"[dim]Kept {len(skipped)} existing secret(s): {', '.join(skipped)}[/dim]"
        )

    # Enable auth for production
    current_auth = get_env_value(env_path, "AUTH_ENABLED")
    if current_auth != "true":
        enable_auth = typer.confirm(
            "Enable authentication? (recommended for any non-local deployment)",
            default=True,
        )
        if enable_auth:
            set_env_value(env_path, "AUTH_ENABLED", "true")
            console.print("[green]Authentication enabled[/green]")
        else:
            set_env_value(env_path, "AUTH_ENABLED", "false")
            console.print(
                "[yellow]Authentication disabled — anyone can access the API[/yellow]"
            )


def step_check_ports(env_path: Path, ssl_planned: bool) -> None:
    """Check for port conflicts before starting."""
    console.print(Panel("[bold]Step 4: Port Check[/bold]"))

    ports_to_check = {
        int(get_env_value(env_path, "API_PORT") or "8000"): "API",
        int(get_env_value(env_path, "DASHBOARD_PORT") or "3000"): "Dashboard",
        int(get_env_value(env_path, "REDIS_PORT") or "6379"): "Redis",
        5432: "PostgreSQL",
        int(get_env_value(env_path, "MCPO_PORT") or "8001"): "MCP Proxy",
    }

    if ssl_planned:
        ports_to_check[80] = "HTTP (Traefik)"
        ports_to_check[443] = "HTTPS (Traefik)"

    conflicts = []
    for port, name in sorted(ports_to_check.items()):
        available = check_port(port)
        if available:
            console.print(f"  [green]:{port}[/green] {name} — available")
        else:
            console.print(f"  [red]:{port}[/red] {name} — IN USE")
            conflicts.append((port, name))

    if conflicts:
        console.print("")
        console.print("[yellow]Port conflicts detected.[/yellow]")
        console.print("Options:")
        console.print("  1. Stop the conflicting services")
        console.print("  2. Change ports in .env (e.g. API_PORT=8080)")
        console.print("")
        proceed = typer.confirm("Continue anyway?", default=False)
        if not proceed:
            console.print("[dim]Fix port conflicts and re-run: djinn setup[/dim]")
            raise typer.Exit(1)
    else:
        console.print("[green]All ports available[/green]")


def step_detect_ip(env_path: Path) -> str:
    """Detect external IP and set VITE_API_URL."""
    console.print(Panel("[bold]Step 5: Network Configuration[/bold]"))

    ip = detect_external_ip()
    if ip:
        console.print(f"Detected external IP: [bold]{ip}[/bold]")
        use_detected = typer.confirm("Use this IP?", default=True)
        if not use_detected:
            ip = typer.prompt("Enter the IP or hostname for this server")
    else:
        console.print("[yellow]Could not detect external IP[/yellow]")
        ip = typer.prompt("Enter the IP or hostname for this server")

    return ip


def step_provider_key(env_path: Path) -> Optional[str]:
    """Prompt for the first model provider API key."""
    console.print(Panel("[bold]Step 6: Model Provider[/bold]"))

    console.print(
        "DjinnBot needs an LLM API key for agents to function.\n"
        "OpenRouter is recommended — it gives access to all major models\n"
        "(Claude, GPT, Gemini, etc.) with a single key.\n"
    )

    table = Table(box=box.SIMPLE, show_header=True, header_style="bold cyan")
    table.add_column("#", style="dim", width=3)
    table.add_column("Provider")
    table.add_column("Description")
    for i, (pid, name, desc) in enumerate(SUPPORTED_PROVIDERS, 1):
        table.add_row(str(i), name, desc)
    console.print(table)

    console.print("")
    choice = typer.prompt(
        "Select a provider (number)",
        default="1",
    )

    try:
        idx = int(choice) - 1
        if idx < 0 or idx >= len(SUPPORTED_PROVIDERS):
            raise ValueError
        provider_id, provider_name, _ = SUPPORTED_PROVIDERS[idx]
    except (ValueError, IndexError):
        console.print("[yellow]Invalid choice, defaulting to OpenRouter[/yellow]")
        provider_id, provider_name = "openrouter", "OpenRouter"

    console.print(f"\nSelected: [bold]{provider_name}[/bold]")

    api_key = typer.prompt(
        f"Enter your {provider_name} API key",
        hide_input=True,
    )

    if not api_key or not api_key.strip():
        console.print(
            "[yellow]No key provided. You can add one later via the dashboard "
            "or: djinn provider set-key[/yellow]"
        )
        return None

    api_key = api_key.strip()

    # Write to .env for engine/QMDR bootstrap
    env_key = PROVIDER_ENV_KEYS.get(provider_id)
    if env_key:
        set_env_value(env_path, env_key, api_key)
        console.print(f"[green]{env_key} written to .env[/green]")

    # For OpenRouter, it's also used by QMDR for embeddings/search
    if provider_id == "openrouter":
        console.print(
            "[dim]This key will also power the semantic memory system "
            "(embeddings via text-embedding-3-small)[/dim]"
        )

    return provider_id


def step_ask_ssl() -> bool:
    """Ask if the user wants SSL setup."""
    console.print(Panel("[bold]Step 7: SSL/TLS Configuration[/bold]"))

    console.print(
        "[bold]SSL is strongly recommended for production deployments.[/bold]\n\n"
        "With SSL enabled, DjinnBot will:\n"
        "  - Serve the dashboard and API over HTTPS\n"
        "  - Automatically obtain and renew certificates via Let's Encrypt\n"
        "  - Redirect all HTTP traffic to HTTPS\n"
        "  - Use Traefik as a reverse proxy (separate Docker stack)\n\n"
        "[bold]Requirements:[/bold]\n"
        "  - A domain name pointing to this server (A record)\n"
        "  - Ports 80 and 443 accessible from the internet\n"
        "  - Access to your domain's DNS provider to create the A record\n"
    )

    return typer.confirm("Set up SSL with automatic certificates?", default=True)


def step_configure_ssl(env_path: Path, repo_dir: Path, ip: str) -> Optional[str]:
    """Configure SSL with Traefik. Returns domain name or None."""
    console.print(Panel("[bold]SSL Setup[/bold]"))

    # Get domain
    domain = (
        typer.prompt("Enter your domain name (e.g. djinn.example.com)").strip().lower()
    )

    if not domain or "." not in domain:
        console.print("[red]Invalid domain name[/red]")
        return None

    # Verify DNS
    console.print(f"[dim]Checking DNS for {domain}...[/dim]")
    dns_ok = _verify_dns(domain, ip)
    if not dns_ok:
        console.print(
            f"[yellow]DNS for {domain} does not appear to resolve to {ip}[/yellow]\n"
            f"Make sure you have an A record: {domain} → {ip}\n"
            f"DNS changes can take a few minutes to propagate."
        )
        proceed = typer.confirm("Continue anyway?", default=False)
        if not proceed:
            return None

    # Get email for Let's Encrypt
    email = typer.prompt(
        "Email for Let's Encrypt notifications (cert expiry warnings)"
    ).strip()

    if not email or "@" not in email:
        console.print("[red]Valid email required for Let's Encrypt[/red]")
        return None

    # Set env values
    set_env_value(env_path, "DOMAIN", domain)
    set_env_value(env_path, "BIND_HOST", "127.0.0.1")
    set_env_value(env_path, "TRAEFIK_ENABLED", "true")
    set_env_value(env_path, "VITE_API_URL", f"https://{domain}")

    # Write proxy/.env
    proxy_dir = repo_dir / "proxy"
    proxy_env = proxy_dir / ".env"
    proxy_env.write_text(f"ACME_EMAIL={email}\nDOMAIN={domain}\n")
    console.print(f"[green]Proxy config written to proxy/.env[/green]")

    # Generate docker-compose.override.yml for Traefik integration
    _write_compose_override(repo_dir, domain)

    # Create the shared Docker network
    docker = docker_cmd()
    try:
        run_cmd(
            [*docker, "network", "create", "djinnbot-proxy"],
            check=False,
        )
        console.print("[green]Created djinnbot-proxy network[/green]")
    except Exception:
        console.print("[dim]djinnbot-proxy network already exists[/dim]")

    console.print(f"[green]SSL configured for {domain}[/green]")
    return domain


def _verify_dns(domain: str, expected_ip: str) -> bool:
    """Check if domain resolves to expected IP."""
    try:
        resolved = socket.gethostbyname(domain)
        return resolved == expected_ip
    except socket.gaierror:
        return False


def _write_compose_override(repo_dir: Path, domain: str) -> None:
    """Generate docker-compose.override.yml for Traefik integration."""
    override_path = repo_dir / "docker-compose.override.yml"

    content = f"""# Generated by `djinn setup` — Traefik reverse proxy integration
# This file is auto-picked-up by `docker compose` alongside docker-compose.yml.
# Delete this file to revert to direct port-binding mode.

services:
  api:
    networks:
      - djinnbot_default
      - djinnbot-proxy
    labels:
      - "traefik.enable=true"
      # Route /v1/* to the API (higher priority due to longer rule)
      - "traefik.http.routers.djinnbot-api.rule=Host(`{domain}`) && PathPrefix(`/v1`)"
      - "traefik.http.routers.djinnbot-api.entrypoints=websecure"
      - "traefik.http.routers.djinnbot-api.tls.certresolver=letsencrypt"
      - "traefik.http.services.djinnbot-api.loadbalancer.server.port=8000"
      # Flush immediately for SSE streaming
      - "traefik.http.services.djinnbot-api.loadbalancer.responseforwarding.flushinterval=-1"

  dashboard:
    networks:
      - djinnbot_default
      - djinnbot-proxy
    labels:
      - "traefik.enable=true"
      # Catch-all for the domain (lower priority than /v1 prefix)
      - "traefik.http.routers.djinnbot-dashboard.rule=Host(`{domain}`)"
      - "traefik.http.routers.djinnbot-dashboard.entrypoints=websecure"
      - "traefik.http.routers.djinnbot-dashboard.tls.certresolver=letsencrypt"
      - "traefik.http.services.djinnbot-dashboard.loadbalancer.server.port=80"
      - "traefik.http.routers.djinnbot-dashboard.priority=1"

networks:
  djinnbot-proxy:
    external: true
"""
    override_path.write_text(content)
    console.print(f"[green]Generated docker-compose.override.yml[/green]")


def step_start_stack(
    repo_dir: Path,
    env_path: Path,
    domain: Optional[str],
    ip: str,
) -> None:
    """Start the Docker Compose stack."""
    console.print(Panel("[bold]Starting DjinnBot[/bold]"))

    docker = docker_cmd()
    compose_cmd = [*docker, "compose"]

    # Start proxy first if SSL is configured
    if domain:
        console.print("[bold]Starting Traefik proxy...[/bold]")
        proxy_dir = repo_dir / "proxy"
        try:
            run_cmd(
                [*compose_cmd, "up", "-d"],
                cwd=proxy_dir,
                stream=True,
            )
            console.print("[green]Traefik proxy started[/green]")
        except Exception:
            console.print("[red]Failed to start Traefik proxy[/red]")
            console.print(
                "[dim]Check: docker compose -f proxy/docker-compose.yml logs[/dim]"
            )
            raise typer.Exit(1)

    # Start main stack
    console.print("[bold]Building and starting DjinnBot services...[/bold]")
    console.print(
        "[dim]This may take several minutes on first run (building images)...[/dim]"
    )

    try:
        run_cmd(
            [*compose_cmd, "up", "-d", "--build"],
            cwd=repo_dir,
            stream=True,
        )
    except Exception:
        console.print("[red]Failed to start DjinnBot stack[/red]")
        console.print("[dim]Check logs: docker compose logs --tail=50[/dim]")
        raise typer.Exit(1)

    console.print("[green]Docker Compose started[/green]")

    # Wait for API health
    api_port = get_env_value(env_path, "API_PORT") or "8000"
    health_url = f"http://127.0.0.1:{api_port}/v1/status"

    console.print(f"\n[bold]Waiting for API to become healthy...[/bold]")
    if wait_for_health(health_url, timeout=180):
        console.print("[green]API is healthy[/green]")
    else:
        console.print("[red]API did not become healthy within 3 minutes[/red]")
        console.print("[dim]Check logs: docker compose logs api --tail=100[/dim]")
        console.print("[dim]The stack may still be starting. Try: djinn status[/dim]")


def step_configure_provider_api(
    env_path: Path,
    provider_id: Optional[str],
) -> None:
    """Set the provider API key via the running API (persists to database)."""
    if not provider_id:
        return

    api_port = get_env_value(env_path, "API_PORT") or "8000"
    api_key = ""

    # Read the key we wrote to .env
    env_key = PROVIDER_ENV_KEYS.get(provider_id, "")
    if env_key:
        api_key = get_env_value(env_path, env_key)

    if not api_key:
        return

    # Use the engine internal token for auth (if auth is enabled)
    token = get_env_value(env_path, "ENGINE_INTERNAL_TOKEN")

    console.print(f"[dim]Registering {provider_id} API key with the server...[/dim]")

    headers = ["Content-Type: application/json"]
    if token:
        headers.append(f"Authorization: Bearer {token}")

    import json

    payload = json.dumps(
        {
            "providerId": provider_id,
            "apiKey": api_key,
            "enabled": True,
        }
    )

    header_args = []
    for h in headers:
        header_args.extend(["-H", h])

    try:
        result = subprocess.run(
            [
                "curl",
                "-sf",
                "--max-time",
                "10",
                "-X",
                "PUT",
                *header_args,
                "-d",
                payload,
                f"http://127.0.0.1:{api_port}/v1/settings/providers/{provider_id}",
            ],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            console.print(f"[green]Provider {provider_id} registered with API[/green]")
        else:
            console.print(
                f"[yellow]Could not register provider via API (non-fatal). "
                f"You can do it later: djinn provider set-key {provider_id}[/yellow]"
            )
    except Exception:
        console.print(
            f"[yellow]Could not reach API to register provider (non-fatal).[/yellow]"
        )


def step_print_summary(
    env_path: Path,
    repo_dir: Path,
    ip: str,
    domain: Optional[str],
    ssl_enabled: bool,
    provider_id: Optional[str],
) -> None:
    """Print the final summary with access URLs and next steps."""
    api_port = get_env_value(env_path, "API_PORT") or "8000"
    dash_port = get_env_value(env_path, "DASHBOARD_PORT") or "3000"
    auth_enabled = get_env_value(env_path, "AUTH_ENABLED") == "true"

    if ssl_enabled and domain:
        dashboard_url = f"https://{domain}"
        api_url = f"https://{domain}/v1"
    else:
        dashboard_url = f"http://{ip}:{dash_port}"
        api_url = f"http://{ip}:{api_port}"

    console.print("")
    console.print(
        Panel(
            "[bold green]DjinnBot is running![/bold green]",
            border_style="green",
        )
    )

    table = Table(box=box.ROUNDED, show_header=False, border_style="dim")
    table.add_column("", style="bold", width=16)
    table.add_column("")
    table.add_row("Dashboard", f"[cyan]{dashboard_url}[/cyan]")
    table.add_row("API", f"[cyan]{api_url}[/cyan]")
    if ssl_enabled:
        table.add_row("SSL", "[green]Enabled (auto-renewing)[/green]")
    table.add_row("Install Dir", str(repo_dir))
    if provider_id:
        table.add_row("Provider", provider_id)
    console.print(table)

    console.print("")

    if auth_enabled:
        console.print(
            "[bold]Next step:[/bold] Open the dashboard to complete initial setup.\n"
            "You'll create your admin account on first visit.\n"
        )
    else:
        console.print(
            "[bold]Next step:[/bold] Open the dashboard and start using DjinnBot.\n"
        )

    console.print("[bold]Useful commands:[/bold]")
    console.print(f"  djinn status              Check server health")
    console.print(f"  djinn chat                Chat with an agent")
    console.print(f"  djinn provider list       List configured providers")
    console.print(f"  djinn provider set-key    Add/change a provider API key")
    console.print(f"")
    console.print(f"[bold]Docker commands[/bold] (run from {repo_dir}):")
    console.print(f"  docker compose logs -f    Stream all logs")
    console.print(f"  docker compose restart    Restart all services")
    console.print(f"  docker compose down       Stop all services")
    if ssl_enabled:
        console.print(
            f"  docker compose -f proxy/docker-compose.yml logs  Traefik logs"
        )
    console.print("")
    console.print("[dim]Re-run setup anytime: djinn setup[/dim]")


# ── Main command ────────────────────────────────────────────────────────────

app = typer.Typer(help="Setup and configuration")


@app.command("setup")
def setup(
    install_dir: Optional[str] = typer.Option(
        None,
        "--dir",
        "-d",
        help="Directory to install DjinnBot (default: ~/djinnbot or current dir if already a repo)",
    ),
    skip_ssl: bool = typer.Option(
        False,
        "--no-ssl",
        help="Skip the SSL setup prompt",
    ),
    skip_provider: bool = typer.Option(
        False,
        "--no-provider",
        help="Skip the provider API key prompt",
    ),
):
    """Interactive setup wizard for DjinnBot.

    Guides you through first-time configuration: cloning the repo,
    generating encryption keys, setting up a model provider,
    starting the Docker stack, and optional SSL with Traefik.

    Safe to re-run — detects existing configuration.
    """
    console.print("")
    console.print(
        Panel(
            "[bold cyan]DjinnBot Setup Wizard[/bold cyan]\n"
            "[dim]Autonomous AI Teams Platform[/dim]",
            border_style="cyan",
        )
    )
    console.print("")

    # ── Step 1: Find / clone repo ───────────────────────────────────
    repo_dir = step_locate_repo(install_dir)
    os.chdir(repo_dir)

    # ── Step 2: .env file ───────────────────────────────────────────
    env_path = step_configure_env(repo_dir)

    # ── Step 3: Secrets ─────────────────────────────────────────────
    step_generate_secrets(env_path)

    # ── Step 5: Network / IP detection ──────────────────────────────
    ip = step_detect_ip(env_path)

    # ── Step 7: SSL decision (ask early so we can set VITE_API_URL) ─
    ssl_enabled = False
    domain = None
    if not skip_ssl:
        ssl_enabled = step_ask_ssl()

    # ── Step 4: Port check ──────────────────────────────────────────
    step_check_ports(env_path, ssl_enabled)

    # ── SSL configuration (sets VITE_API_URL, BIND_HOST, etc.) ──────
    if ssl_enabled:
        domain = step_configure_ssl(env_path, repo_dir, ip)
        if not domain:
            ssl_enabled = False
            console.print("[yellow]SSL setup skipped. Continuing without SSL.[/yellow]")

    # Set VITE_API_URL for non-SSL case
    if not ssl_enabled:
        api_port = get_env_value(env_path, "API_PORT") or "8000"
        set_env_value(env_path, "VITE_API_URL", f"http://{ip}:{api_port}")
        set_env_value(env_path, "BIND_HOST", "0.0.0.0")

    # ── Step 6: Provider API key ────────────────────────────────────
    provider_id = None
    if not skip_provider:
        provider_id = step_provider_key(env_path)

    # ── Start everything ────────────────────────────────────────────
    step_start_stack(repo_dir, env_path, domain, ip)

    # ── Register provider with running API ──────────────────────────
    step_configure_provider_api(env_path, provider_id)

    # ── Summary ─────────────────────────────────────────────────────
    step_print_summary(env_path, repo_dir, ip, domain, ssl_enabled, provider_id)
