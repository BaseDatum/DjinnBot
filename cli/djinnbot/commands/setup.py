"""Interactive setup wizard for DjinnBot.

Handles first-time configuration: cloning the repo, generating secrets,
configuring model providers, starting the Docker stack, and optional
SSL/TLS setup with Traefik.

Designed to be idempotent — safe to re-run.
"""

import os
import re
import secrets
import signal
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


def _handle_interrupt(signum, frame):
    """Handle Ctrl+C cleanly at any point during setup."""
    console.print("\n\n[yellow]Setup interrupted.[/yellow]")
    console.print(
        "[dim]No changes have been made to running services.\n"
        "Re-run setup anytime: djinn setup[/dim]"
    )
    sys.exit(130)


# Install the handler immediately on import so it's active for the entire setup
signal.signal(signal.SIGINT, _handle_interrupt)

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
GITHUB_API_RELEASES = "https://api.github.com/repos/BaseDatum/djinnbot/releases/latest"

GHCR_IMAGES = {
    "api": "ghcr.io/basedatum/djinnbot/api",
    "engine": "ghcr.io/basedatum/djinnbot/engine",
    "dashboard": "ghcr.io/basedatum/djinnbot/dashboard",
    "agent-runtime": "ghcr.io/basedatum/djinnbot/agent-runtime",
}

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


def fetch_latest_release_tag() -> str:
    """Fetch the latest release tag from GitHub. Falls back to 'main'."""
    try:
        import json as _json

        result = subprocess.run(
            ["curl", "-sf", "--max-time", "10", GITHUB_API_RELEASES],
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.returncode == 0:
            data = _json.loads(result.stdout)
            tag = data.get("tag_name", "")
            if tag:
                # CI tags images as semver (without 'v' prefix) and also 'latest'
                # e.g. tag "v1.2.3" → image tag "1.2.3" and "latest"
                return "latest"
        return "main"
    except Exception:
        return "main"


# ── Setup steps ─────────────────────────────────────────────────────────────


def step_image_mode(env_path: Path) -> str:
    """Ask if user wants pre-built images or build from source.

    Returns 'prebuilt' or 'build'.
    """
    console.print(Panel("[bold]Step 2: Image Mode[/bold]"))

    console.print(
        "[bold]How would you like to run DjinnBot?[/bold]\n\n"
        "  [cyan]1.[/cyan] [bold]Pre-built images[/bold] (recommended)\n"
        "     Pull ready-to-run images from GitHub Container Registry.\n"
        "     Fastest startup — no compilation needed.\n\n"
        "  [cyan]2.[/cyan] [bold]Build from source[/bold]\n"
        "     Build all Docker images locally from the repository.\n"
        "     Takes 5-15 minutes. Choose this if you want to modify the code.\n"
    )

    choice = typer.prompt("Select mode (1 or 2)", default="1")

    if choice.strip() == "2":
        console.print("[green]Mode: Build from source[/green]")
        return "build"

    # Pre-built: fetch latest tag
    console.print("[dim]Checking for latest release...[/dim]")
    tag = fetch_latest_release_tag()
    set_env_value(env_path, "DJINNBOT_VERSION", tag)

    console.print(f"[green]Mode: Pre-built images (tag: {tag})[/green]")

    # Pre-built images require Traefik for routing (dashboard uses relative paths)
    console.print(
        "[dim]Pre-built images use Traefik for request routing "
        "(dashboard and API served through a single entry point).[/dim]"
    )

    return "prebuilt"


def step_locate_repo(install_dir: Optional[str]) -> Path:
    """Find or clone the DjinnBot repository."""
    console.print(Panel("[bold]Locate DjinnBot Repository[/bold]"))

    # Check if a directory was explicitly provided
    if install_dir:
        repo_dir = Path(install_dir).expanduser().resolve()
        if repo_dir.exists() and (repo_dir / "docker-compose.yml").exists():
            _update_existing_repo(repo_dir)
            return repo_dir
        # Clone to this directory
        return _clone_repo(repo_dir)

    # Check if CWD is a djinnbot repo
    cwd = Path.cwd()
    if (cwd / "docker-compose.yml").exists() and (cwd / ".env.example").exists():
        console.print(f"[green]Found DjinnBot repo in current directory: {cwd}[/green]")
        _update_existing_repo(cwd)
        return cwd

    # Ask user
    default_dir = Path.home() / "djinnbot"
    response = typer.prompt(
        "Where should DjinnBot be installed?",
        default=str(default_dir),
    )
    repo_dir = Path(response).expanduser().resolve()

    if repo_dir.exists() and (repo_dir / "docker-compose.yml").exists():
        _update_existing_repo(repo_dir)
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


def _update_existing_repo(repo_dir: Path) -> None:
    """Pull latest changes from git for an existing repo."""
    console.print(f"[green]Using existing repo at {repo_dir}[/green]")

    # Check if it's a git repo
    if not (repo_dir / ".git").exists():
        console.print("[dim]Not a git repo — skipping update[/dim]")
        return

    console.print("[dim]Pulling latest changes...[/dim]")
    try:
        result = run_cmd(
            ["git", "pull", "--ff-only"],
            cwd=repo_dir,
            check=False,
        )
        if result.returncode == 0:
            output = (result.stdout or "").strip()
            if "Already up to date" in output:
                console.print("[dim]Already up to date[/dim]")
            else:
                console.print("[green]Updated to latest version[/green]")
        else:
            # ff-only failed — local changes or diverged branch
            console.print(
                "[yellow]Could not fast-forward. You may have local changes.[/yellow]\n"
                "[dim]Continuing with current version.[/dim]"
            )
    except Exception:
        console.print(
            "[yellow]Could not pull updates (non-fatal). "
            "Continuing with current version.[/yellow]"
        )


def _detect_running_stack(repo_dir: Path) -> bool:
    """Check if there's a DjinnBot docker compose stack already running."""
    docker = docker_cmd()
    try:
        result = subprocess.run(
            [*docker, "compose", "ps", "--format", "json", "-q"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=15,
        )
        # If there are running container IDs, the stack is up
        return bool(result.stdout.strip())
    except Exception:
        return False


def _detect_running_proxy(repo_dir: Path) -> bool:
    """Check if the Traefik proxy stack is running."""
    proxy_dir = repo_dir / "proxy"
    if not proxy_dir.exists() or not (proxy_dir / "docker-compose.yml").exists():
        return False

    docker = docker_cmd()
    try:
        result = subprocess.run(
            [*docker, "compose", "ps", "--format", "json", "-q"],
            cwd=proxy_dir,
            capture_output=True,
            text=True,
            timeout=15,
        )
        return bool(result.stdout.strip())
    except Exception:
        return False


def step_stop_existing(repo_dir: Path) -> None:
    """Detect and stop any existing DjinnBot stacks before re-deploying."""
    proxy_running = _detect_running_proxy(repo_dir)
    stack_running = _detect_running_stack(repo_dir)

    if not stack_running and not proxy_running:
        return

    console.print(Panel("[bold]Existing Stack Detected[/bold]"))

    if stack_running:
        console.print("[yellow]DjinnBot services are currently running.[/yellow]")
    if proxy_running:
        console.print("[yellow]Traefik proxy is currently running.[/yellow]")

    console.print(
        "\n[dim]The existing stack will be stopped and re-created "
        "with the new configuration.[/dim]"
    )
    proceed = typer.confirm("Stop existing stack and continue?", default=True)
    if not proceed:
        console.print("[dim]Setup cancelled. Existing stack left running.[/dim]")
        raise typer.Exit(0)

    docker = docker_cmd()
    compose_cmd = [*docker, "compose"]

    if stack_running:
        console.print("[dim]Stopping DjinnBot services...[/dim]")
        try:
            run_cmd(
                [*compose_cmd, "down"],
                cwd=repo_dir,
                stream=True,
                check=False,
            )
            console.print("[green]DjinnBot services stopped[/green]")
        except Exception:
            console.print("[yellow]Warning: could not stop main stack cleanly[/yellow]")

    if proxy_running:
        console.print("[dim]Stopping Traefik proxy...[/dim]")
        proxy_dir = repo_dir / "proxy"
        try:
            run_cmd(
                [*compose_cmd, "down"],
                cwd=proxy_dir,
                stream=True,
                check=False,
            )
            console.print("[green]Traefik proxy stopped[/green]")
        except Exception:
            console.print("[yellow]Warning: could not stop proxy cleanly[/yellow]")


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


def _identify_port_owner(port: int) -> Optional[str]:
    """Try to identify what's using a port. Returns a description or None."""
    # Check if it's a djinnbot container
    try:
        result = subprocess.run(
            [
                "docker",
                "ps",
                "--filter",
                f"publish={port}",
                "--format",
                "{{{{.Names}}}}",
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        name = result.stdout.strip()
        if name:
            return f"docker: {name}"
    except Exception:
        pass

    # Try ss/lsof
    for cmd in [
        ["ss", "-tlnp", f"sport = :{port}"],
        ["lsof", "-i", f":{port}", "-sTCP:LISTEN", "-P", "-n"],
    ]:
        try:
            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                timeout=5,
            )
            if result.stdout.strip():
                # Grab just the process name from the output
                return result.stdout.strip().split("\n")[-1][:80]
        except Exception:
            continue

    return None


def step_check_ports(env_path: Path, use_proxy: bool, repo_dir: Path) -> None:
    """Check for port conflicts. Auto-handles conflicts from own stack."""
    console.print(Panel("[bold]Port Check[/bold]"))

    ports_to_check = {
        int(get_env_value(env_path, "API_PORT") or "8000"): "API",
        int(get_env_value(env_path, "DASHBOARD_PORT") or "3000"): "Dashboard",
        int(get_env_value(env_path, "REDIS_PORT") or "6379"): "Redis",
        5432: "PostgreSQL",
        int(get_env_value(env_path, "MCPO_PORT") or "8001"): "MCP Proxy",
    }

    if use_proxy:
        ports_to_check[80] = "HTTP (Traefik)"
        ports_to_check[443] = "HTTPS (Traefik)"

    # Known djinnbot container names — conflicts from these are expected
    # and handled by step_stop_existing
    own_containers = {
        "djinnbot-api",
        "djinnbot-postgres",
        "djinnbot-redis",
        "djinnbot-engine",
        "djinnbot-mcpo",
        "djinnbot-dashboard",
        "djinnbot-traefik",
    }

    external_conflicts = []
    own_conflicts = []

    for port, name in sorted(ports_to_check.items()):
        if check_port(port):
            console.print(f"  [green]:{port}[/green] {name} — available")
        else:
            owner = _identify_port_owner(port)
            # Check if the conflict is from our own stack
            is_own = False
            if owner:
                for cn in own_containers:
                    if cn in owner:
                        is_own = True
                        break

            if is_own:
                console.print(
                    f"  [yellow]:{port}[/yellow] {name} — used by existing DjinnBot stack"
                )
                own_conflicts.append((port, name))
            else:
                owner_str = f" ({owner})" if owner else ""
                console.print(f"  [red]:{port}[/red] {name} — IN USE{owner_str}")
                external_conflicts.append((port, name))

    if own_conflicts and not external_conflicts:
        console.print(
            f"\n[dim]All conflicts are from the existing DjinnBot stack — "
            f"these will be resolved when the stack restarts.[/dim]"
        )
        return

    if external_conflicts:
        console.print("")
        console.print(
            f"[yellow]{len(external_conflicts)} port(s) in use by other services.[/yellow]"
        )
        console.print("Options:")
        console.print("  1. Stop the conflicting services and re-run setup")
        console.print("  2. Change ports in .env (e.g. API_PORT=8080)")
        console.print("")
        proceed = typer.confirm("Continue anyway?", default=False)
        if not proceed:
            console.print("[dim]Fix port conflicts and re-run: djinn setup[/dim]")
            raise typer.Exit(1)

    if not own_conflicts and not external_conflicts:
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
    """Prompt for model provider API keys. OpenRouter is required."""
    console.print(Panel("[bold]Model Provider[/bold]"))

    # ── OpenRouter (required) ───────────────────────────────────────
    console.print(
        "[bold]An OpenRouter API key is required.[/bold]\n\n"
        "DjinnBot uses OpenRouter for:\n"
        "  - Semantic memory (embeddings via text-embedding-3-small)\n"
        "  - Query reranking (via gpt-4o-mini)\n"
        "  - Access to all major LLM models (Claude, GPT, Gemini, etc.)\n\n"
        "Get a key at: [cyan]https://openrouter.ai/keys[/cyan]\n"
    )

    existing_key = get_env_value(env_path, "OPENROUTER_API_KEY")
    if existing_key:
        console.print(
            f"[green]OpenRouter key already set in .env[/green] [dim]({existing_key[:8]}...)[/dim]"
        )
        change = typer.confirm("Replace existing key?", default=False)
        if not change:
            console.print("[dim]Keeping existing key[/dim]")
            return "openrouter"

    openrouter_key = typer.prompt(
        "Enter your OpenRouter API key",
        hide_input=True,
    )

    if not openrouter_key or not openrouter_key.strip():
        console.print(
            "[yellow]No key provided. The semantic memory system will not work "
            "without an OpenRouter key.[/yellow]\n"
            "[dim]Add one later: djinn provider set-key openrouter[/dim]"
        )
        return None

    openrouter_key = openrouter_key.strip()
    set_env_value(env_path, "OPENROUTER_API_KEY", openrouter_key)
    console.print("[green]OPENROUTER_API_KEY written to .env[/green]")

    # ── Additional provider (optional) ──────────────────────────────
    console.print(
        "\n[dim]OpenRouter already provides access to all major models.\n"
        "You can optionally add a direct API key for another provider\n"
        "if you prefer direct access (lower latency, no OpenRouter markup).[/dim]\n"
    )

    add_extra = typer.confirm("Add another provider API key?", default=False)
    if not add_extra:
        return "openrouter"

    # Show providers (skip OpenRouter since we already have it)
    extra_providers = [p for p in SUPPORTED_PROVIDERS if p[0] != "openrouter"]
    table = Table(box=box.SIMPLE, show_header=True, header_style="bold cyan")
    table.add_column("#", style="dim", width=3)
    table.add_column("Provider")
    table.add_column("Description")
    for i, (pid, name, desc) in enumerate(extra_providers, 1):
        table.add_row(str(i), name, desc)
    console.print(table)

    choice = typer.prompt("Select a provider (number)", default="1")

    try:
        idx = int(choice) - 1
        if idx < 0 or idx >= len(extra_providers):
            raise ValueError
        provider_id, provider_name, _ = extra_providers[idx]
    except (ValueError, IndexError):
        console.print("[yellow]Invalid choice, skipping[/yellow]")
        return "openrouter"

    extra_key = typer.prompt(
        f"Enter your {provider_name} API key",
        hide_input=True,
    )

    if extra_key and extra_key.strip():
        env_key = PROVIDER_ENV_KEYS.get(provider_id)
        if env_key:
            set_env_value(env_path, env_key, extra_key.strip())
            console.print(f"[green]{env_key} written to .env[/green]")

    return "openrouter"


def step_ask_ssl(ip: str) -> bool:
    """Ask if the user wants SSL setup. Gates on having a domain first."""
    console.print(Panel("[bold]SSL/TLS Configuration[/bold]"))

    console.print(
        "[bold]SSL is strongly recommended for production deployments.[/bold]\n\n"
        "SSL requires a domain name with a DNS A record pointing to this\n"
        f"server's public IP address ({ip}).\n\n"
        "For example, if you own [cyan]example.com[/cyan], you would create:\n"
        f"  [cyan]djinn.example.com[/cyan]  A  [cyan]{ip}[/cyan]\n\n"
        "You need access to your domain's DNS settings to do this.\n"
    )

    has_domain = typer.confirm(
        "Do you have a domain name pointed at this server?",
        default=False,
    )

    if not has_domain:
        console.print(
            "\n[dim]No problem — you can set up SSL later by re-running: "
            "djinn setup[/dim]\n"
            "[dim]DjinnBot will work over plain HTTP in the meantime.[/dim]"
        )
        return False

    console.print(
        "\nWith SSL enabled, DjinnBot will:\n"
        "  - Serve the dashboard and API over HTTPS\n"
        "  - Automatically obtain and renew certificates via Let's Encrypt\n"
        "  - Redirect all HTTP traffic to HTTPS\n"
    )

    return typer.confirm("Set up SSL with automatic certificates?", default=True)


def step_configure_ssl(
    env_path: Path, repo_dir: Path, ip: str
) -> tuple[Optional[str], Optional[str], str]:
    """Configure SSL with Traefik.

    Returns (domain, api_domain, routing_mode) where:
      - domain: the primary domain (dashboard)
      - api_domain: the API domain (same as domain for path mode, subdomain for subdomain mode)
      - routing_mode: "path" or "subdomain"
    """
    console.print(Panel("[bold]SSL Setup[/bold]"))

    # Get domain
    domain = (
        typer.prompt("Enter your domain name (e.g. djinn.example.com)").strip().lower()
    )

    if not domain or "." not in domain:
        console.print("[red]Invalid domain name[/red]")
        return None, None, "path"

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
            return None, None, "path"

    # ── API routing mode ────────────────────────────────────────────
    console.print(
        "\n[bold]How should the API be accessed?[/bold]\n\n"
        "  [cyan]1.[/cyan] [bold]Same domain, path prefix[/bold] (recommended)\n"
        f"     Dashboard: https://{domain}\n"
        f"     API:       https://{domain}/api/v1/...\n"
        "     Single certificate. Traefik rewrites /api → / for the API.\n\n"
        "  [cyan]2.[/cyan] [bold]Separate subdomain[/bold]\n"
        f"     Dashboard: https://{domain}\n"
        f"     API:       https://api.{domain}/v1/...\n"
        "     Two certificates. Requires a second DNS A record.\n"
    )

    mode_choice = typer.prompt("Select routing mode (1 or 2)", default="1").strip()

    if mode_choice == "2":
        routing_mode = "subdomain"
        # Derive api subdomain from the dashboard domain
        default_api_domain = f"api.{domain}"
        api_domain = (
            typer.prompt(
                "API subdomain",
                default=default_api_domain,
            )
            .strip()
            .lower()
        )

        # Verify DNS for api subdomain
        console.print(f"[dim]Checking DNS for {api_domain}...[/dim]")
        api_dns_ok = _verify_dns(api_domain, ip)
        if not api_dns_ok:
            console.print(
                f"[yellow]DNS for {api_domain} does not appear to resolve to {ip}[/yellow]\n"
                f"Make sure you have an A record: {api_domain} → {ip}\n"
            )
            proceed = typer.confirm("Continue anyway?", default=False)
            if not proceed:
                return None, None, "path"

        console.print(
            f"[green]Subdomain mode:[/green] API at [cyan]https://{api_domain}[/cyan]"
        )
    else:
        routing_mode = "path"
        api_domain = domain
        console.print(
            f"[green]Path mode:[/green] API at [cyan]https://{domain}/api[/cyan]"
        )

    # Get email for Let's Encrypt
    email = typer.prompt(
        "Email for Let's Encrypt notifications (cert expiry warnings)"
    ).strip()

    if not email or "@" not in email:
        console.print("[red]Valid email required for Let's Encrypt[/red]")
        return None, None, "path"

    # Set env values
    set_env_value(env_path, "DOMAIN", domain)
    set_env_value(env_path, "BIND_HOST", "127.0.0.1")
    set_env_value(env_path, "TRAEFIK_ENABLED", "true")

    # The dashboard origin is always https://<domain> regardless of routing mode.
    # CORS must allow this origin so the browser can call the API.
    dashboard_origin = f"https://{domain}"
    set_env_value(env_path, "CORS_ORIGINS", dashboard_origin)

    if routing_mode == "subdomain":
        set_env_value(env_path, "API_DOMAIN", api_domain)
        set_env_value(env_path, "VITE_API_URL", f"https://{api_domain}")
    else:
        # Path mode: dashboard calls /api/v1/..., Traefik strips /api
        set_env_value(env_path, "VITE_API_URL", f"https://{domain}/api")

    # Write proxy/.env
    proxy_dir = repo_dir / "proxy"
    proxy_env = proxy_dir / ".env"
    proxy_env_content = f"ACME_EMAIL={email}\nDOMAIN={domain}\n"
    if routing_mode == "subdomain":
        proxy_env_content += f"API_DOMAIN={api_domain}\n"
    proxy_env.write_text(proxy_env_content)
    console.print(f"[green]Proxy config written to proxy/.env[/green]")

    # Generate docker-compose.override.yml for Traefik integration
    _write_compose_override(
        repo_dir,
        domain=domain,
        api_domain=api_domain,
        routing_mode=routing_mode,
        ssl=True,
    )

    # Generate the SSL proxy compose (always write — never rely on static file)
    _write_proxy_compose(repo_dir, ssl=True)

    # Create the shared Docker network
    _setup_proxy_network()

    console.print(f"[green]SSL configured for {domain}[/green]")
    return domain, api_domain, routing_mode


def _verify_dns(domain: str, expected_ip: str) -> bool:
    """Check if domain resolves to expected IP."""
    try:
        resolved = socket.gethostbyname(domain)
        return resolved == expected_ip
    except socket.gaierror:
        return False


def _write_compose_override(
    repo_dir: Path,
    domain: Optional[str],
    ssl: bool = True,
    api_domain: Optional[str] = None,
    routing_mode: str = "path",
) -> None:
    """Generate docker-compose.override.yml for Traefik integration.

    Supports three routing modes:
      - "path" (SSL):       Same domain, /api/* → API with StripPrefix, /* → dashboard
      - "subdomain" (SSL):  api.domain → API, domain → dashboard, two certs
      - HTTP-only (no SSL): PathPrefix routing on port 80
    """
    override_path = repo_dir / "docker-compose.override.yml"

    if ssl and domain and routing_mode == "subdomain":
        # ── Subdomain mode: api.domain.com → API, domain.com → dashboard ──
        effective_api_domain = api_domain or f"api.{domain}"

        content = f"""# Generated by `djinn setup` — Traefik reverse proxy (subdomain mode)
# API:       https://{effective_api_domain}
# Dashboard: https://{domain}
# Delete this file to revert to direct port-binding mode.

services:
  api:
    networks:
      - djinnbot_default
      - djinnbot-proxy
    labels:
      - "traefik.enable=true"
      # Route all traffic for the API subdomain to the API
      - "traefik.http.routers.djinnbot-api.rule=Host(`{effective_api_domain}`)"
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
      - "traefik.http.routers.djinnbot-dashboard.rule=Host(`{domain}`)"
      - "traefik.http.routers.djinnbot-dashboard.entrypoints=websecure"
      - "traefik.http.routers.djinnbot-dashboard.tls.certresolver=letsencrypt"
      - "traefik.http.services.djinnbot-dashboard.loadbalancer.server.port=80"

networks:
  djinnbot-proxy:
    external: true
"""

    elif ssl and domain:
        # ── Path mode: domain.com/api/* → API, domain.com/* → dashboard ──
        content = f"""# Generated by `djinn setup` — Traefik reverse proxy (path mode)
# API:       https://{domain}/api/v1/...
# Dashboard: https://{domain}
# Traefik strips /api prefix before forwarding to the API container.
# Delete this file to revert to direct port-binding mode.

services:
  api:
    networks:
      - djinnbot_default
      - djinnbot-proxy
    labels:
      - "traefik.enable=true"
      # Route /api/* to the API container
      - "traefik.http.routers.djinnbot-api.rule=Host(`{domain}`) && PathPrefix(`/api`)"
      - "traefik.http.routers.djinnbot-api.entrypoints=websecure"
      - "traefik.http.routers.djinnbot-api.tls.certresolver=letsencrypt"
      # Strip /api prefix: /api/v1/status → /v1/status (what the API expects)
      - "traefik.http.routers.djinnbot-api.middlewares=strip-api@docker"
      - "traefik.http.middlewares.strip-api.stripprefix.prefixes=/api"
      - "traefik.http.services.djinnbot-api.loadbalancer.server.port=8000"
      # Flush immediately for SSE streaming
      - "traefik.http.services.djinnbot-api.loadbalancer.responseforwarding.flushinterval=-1"

  dashboard:
    networks:
      - djinnbot_default
      - djinnbot-proxy
    labels:
      - "traefik.enable=true"
      # Catch-all for the domain (lower priority than /api prefix)
      - "traefik.http.routers.djinnbot-dashboard.rule=Host(`{domain}`)"
      - "traefik.http.routers.djinnbot-dashboard.entrypoints=websecure"
      - "traefik.http.routers.djinnbot-dashboard.tls.certresolver=letsencrypt"
      - "traefik.http.services.djinnbot-dashboard.loadbalancer.server.port=80"
      - "traefik.http.routers.djinnbot-dashboard.priority=1"

networks:
  djinnbot-proxy:
    external: true
"""

    else:
        # ── HTTP-only mode (no SSL, pre-built images) ──
        content = """# Generated by `djinn setup` — Traefik reverse proxy (HTTP-only)
# Delete this file to revert to direct port-binding mode.

services:
  api:
    networks:
      - djinnbot_default
      - djinnbot-proxy
    labels:
      - "traefik.enable=true"
      # Route /v1/* to the API (higher priority due to longer rule)
      - "traefik.http.routers.djinnbot-api.rule=PathPrefix(`/v1`)"
      - "traefik.http.routers.djinnbot-api.entrypoints=web"
      - "traefik.http.services.djinnbot-api.loadbalancer.server.port=8000"
      # Flush immediately for SSE streaming
      - "traefik.http.services.djinnbot-api.loadbalancer.responseforwarding.flushinterval=-1"

  dashboard:
    networks:
      - djinnbot_default
      - djinnbot-proxy
    labels:
      - "traefik.enable=true"
      # Catch-all (lower priority than /v1 prefix)
      - "traefik.http.routers.djinnbot-dashboard.rule=PathPrefix(`/`)"
      - "traefik.http.routers.djinnbot-dashboard.entrypoints=web"
      - "traefik.http.services.djinnbot-dashboard.loadbalancer.server.port=80"
      - "traefik.http.routers.djinnbot-dashboard.priority=1"

networks:
  djinnbot-proxy:
    external: true
"""

    override_path.write_text(content)
    console.print(f"[green]Generated docker-compose.override.yml[/green]")


def _setup_proxy_network() -> None:
    """Create the shared djinnbot-proxy Docker network if it doesn't exist."""
    docker = docker_cmd()
    try:
        run_cmd([*docker, "network", "create", "djinnbot-proxy"], check=False)
        console.print("[green]Created djinnbot-proxy network[/green]")
    except Exception:
        console.print("[dim]djinnbot-proxy network already exists[/dim]")


def _write_proxy_compose(repo_dir: Path, ssl: bool = False) -> None:
    """Generate proxy/docker-compose.yml for the chosen mode.

    Always called by the setup wizard — never rely on the static file
    in the repo, since a previous run may have overwritten it.
    """
    proxy_dir = repo_dir / "proxy"
    proxy_dir.mkdir(exist_ok=True)
    compose_path = proxy_dir / "docker-compose.yml"

    if ssl:
        content = """# DjinnBot Reverse Proxy — Traefik with automatic SSL
# Generated by `djinn setup`. Re-run setup to change mode.

services:
  traefik:
    image: traefik:v3
    container_name: djinnbot-traefik
    restart: unless-stopped
    command:
      # Entrypoints
      - --entrypoints.web.address=:80
      - --entrypoints.websecure.address=:443
      # Redirect all HTTP to HTTPS
      - --entrypoints.web.http.redirections.entryPoint.to=websecure
      - --entrypoints.web.http.redirections.entryPoint.scheme=https
      # Let's Encrypt ACME
      - --certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL}
      - --certificatesresolvers.letsencrypt.acme.storage=/certs/acme.json
      - --certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web
      # Docker provider
      - --providers.docker=true
      - --providers.docker.network=djinnbot-proxy
      - --providers.docker.exposedbydefault=false
      # Logging
      - --log.level=WARN
      - --accesslog=false
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - traefik-certs:/certs
    networks:
      - djinnbot-proxy
    healthcheck:
      test: ["CMD", "traefik", "healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3

volumes:
  traefik-certs:

networks:
  djinnbot-proxy:
    external: true
"""
        console.print("[green]Generated SSL proxy config[/green]")
    else:
        content = """# DjinnBot Reverse Proxy — Traefik HTTP-only mode
# Generated by `djinn setup`. Re-run setup to upgrade to SSL.

services:
  traefik:
    image: traefik:v3
    container_name: djinnbot-traefik
    restart: unless-stopped
    command:
      - --entrypoints.web.address=:80
      - --providers.docker=true
      - --providers.docker.network=djinnbot-proxy
      - --providers.docker.exposedbydefault=false
      - --log.level=WARN
      - --accesslog=false
    ports:
      - "80:80"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - djinnbot-proxy
    healthcheck:
      test: ["CMD", "traefik", "healthcheck"]
      interval: 30s
      timeout: 5s
      retries: 3

networks:
  djinnbot-proxy:
    external: true
"""
        console.print("[green]Generated HTTP-only proxy config[/green]")

    compose_path.write_text(content)


def step_start_stack(
    repo_dir: Path,
    env_path: Path,
    image_mode: str,
    use_proxy: bool,
) -> None:
    """Start the Docker Compose stack."""
    console.print(Panel("[bold]Starting DjinnBot[/bold]"))

    docker = docker_cmd()
    compose_cmd = [*docker, "compose"]

    # Start proxy first if Traefik is being used (SSL or pre-built HTTP-only)
    if use_proxy:
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

    # Build the compose command for the main stack
    # When using ghcr images, tell compose which file to use via COMPOSE_FILE
    compose_file = get_env_value(env_path, "COMPOSE_FILE")
    main_cmd = [*compose_cmd]
    if compose_file:
        # COMPOSE_FILE env var is read automatically by docker compose from .env
        pass  # docker compose reads it from .env

    up_cmd = [*main_cmd, "up", "-d"]

    if image_mode == "build":
        console.print(
            "[bold]Building and starting DjinnBot services...[/bold]\n"
            "[dim]This may take 5-15 minutes on first run (building images)...[/dim]"
        )
        up_cmd.append("--build")

        # Also build the agent-runtime image (spawned dynamically by the engine, not in compose)
        console.print("[dim]Building agent-runtime image...[/dim]")
        try:
            run_cmd(
                [
                    *docker,
                    "build",
                    "-t",
                    "djinnbot/agent-runtime:latest",
                    "-f",
                    "Dockerfile.agent-runtime",
                    ".",
                ],
                cwd=repo_dir,
                stream=True,
                check=False,
            )
        except Exception:
            console.print(
                "[yellow]Could not build agent-runtime image. "
                "Agents may fail to start until it is built.[/yellow]\n"
                "[dim]Build manually: docker build -t djinnbot/agent-runtime:latest "
                "-f Dockerfile.agent-runtime .[/dim]"
            )
    else:
        console.print(
            "[bold]Pulling and starting DjinnBot services...[/bold]\n"
            "[dim]Downloading pre-built images...[/dim]"
        )
        # Pull compose services
        try:
            run_cmd(
                [*main_cmd, "pull"],
                cwd=repo_dir,
                stream=True,
                check=False,
            )
        except Exception:
            pass  # Pull failures are retried by up

        # Pull agent-runtime image (spawned dynamically by the engine, not in compose)
        version = get_env_value(env_path, "DJINNBOT_VERSION") or "latest"
        agent_image = f"ghcr.io/basedatum/djinnbot/agent-runtime:{version}"
        console.print(f"[dim]Pulling agent-runtime image ({version})...[/dim]")
        try:
            run_cmd(
                [*docker, "pull", agent_image],
                stream=True,
                check=False,
            )
            # Tag it as the name the engine expects (djinnbot/agent-runtime:latest)
            run_cmd(
                [*docker, "tag", agent_image, "djinnbot/agent-runtime:latest"],
                check=False,
            )
            console.print("[green]Agent-runtime image ready[/green]")
        except Exception:
            console.print(
                "[yellow]Could not pull agent-runtime image. "
                "Agents may fail to start until it is available.[/yellow]\n"
                f"[dim]Pull manually: docker pull {agent_image}[/dim]"
            )

    try:
        run_cmd(up_cmd, cwd=repo_dir, stream=True)
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


def step_verify_deployment(
    env_path: Path,
    repo_dir: Path,
    ip: str,
    domain: Optional[str],
    ssl_enabled: bool,
    use_proxy: bool,
) -> None:
    """Verify the dashboard is reachable and SSL is working if enabled."""
    console.print(Panel("[bold]Verifying Deployment[/bold]"))

    api_port = get_env_value(env_path, "API_PORT") or "8000"
    dash_port = get_env_value(env_path, "DASHBOARD_PORT") or "3000"
    docker = docker_cmd()
    all_ok = True

    # ── 1. Check API is healthy (internal) ──────────────────────────
    console.print("[dim]Checking API health (internal)...[/dim]")
    api_ok = wait_for_health(f"http://127.0.0.1:{api_port}/v1/status", timeout=30)
    if api_ok:
        console.print("  [green]API responding on localhost[/green]")
    else:
        console.print("  [red]API not responding on localhost[/red]")
        _troubleshoot_api(docker, repo_dir)
        all_ok = False

    # ── 2. Check dashboard is reachable at the configured URL ───────
    # Read VITE_API_URL from .env — this is the source of truth set by the
    # setup wizard for all modes (path, subdomain, direct, proxy).
    vite_api_url = get_env_value(env_path, "VITE_API_URL")

    if ssl_enabled and domain:
        dashboard_url = f"https://{domain}"
        api_url = (
            f"{vite_api_url}/v1/status"
            if vite_api_url
            else f"https://{domain}/v1/status"
        )
    elif use_proxy:
        dashboard_url = f"http://{ip}"
        api_url = (
            f"{vite_api_url}/v1/status" if vite_api_url else f"http://{ip}/v1/status"
        )
    else:
        dashboard_url = f"http://{ip}:{dash_port}"
        api_url = (
            f"{vite_api_url}/v1/status"
            if vite_api_url
            else f"http://{ip}:{api_port}/v1/status"
        )

    # Check dashboard
    console.print(f"[dim]Checking dashboard at {dashboard_url} ...[/dim]")
    dash_ok = _check_url(dashboard_url, timeout=20)
    if dash_ok:
        console.print(f"  [green]Dashboard reachable at {dashboard_url}[/green]")
    else:
        console.print(f"  [red]Dashboard not reachable at {dashboard_url}[/red]")
        all_ok = False

    # Check API through the public URL
    console.print(f"[dim]Checking API at {api_url} ...[/dim]")
    api_public_ok = _check_url(api_url, timeout=20)
    if api_public_ok:
        console.print(f"  [green]API reachable at {api_url}[/green]")
    else:
        console.print(f"  [red]API not reachable at {api_url}[/red]")
        all_ok = False

    # ── 3. SSL-specific checks ──────────────────────────────────────
    if ssl_enabled and domain:
        console.print(f"[dim]Verifying SSL certificate for {domain}...[/dim]")
        ssl_ok, ssl_detail = _check_ssl_cert(domain)
        if ssl_ok:
            console.print(f"  [green]SSL certificate valid ({ssl_detail})[/green]")
        else:
            console.print(f"  [red]SSL certificate issue: {ssl_detail}[/red]")
            all_ok = False

        # Check API subdomain cert if using subdomain routing
        api_domain = get_env_value(env_path, "API_DOMAIN")
        if api_domain and api_domain != domain:
            console.print(f"[dim]Verifying SSL certificate for {api_domain}...[/dim]")
            api_ssl_ok, api_ssl_detail = _check_ssl_cert(api_domain)
            if api_ssl_ok:
                console.print(
                    f"  [green]API SSL certificate valid ({api_ssl_detail})[/green]"
                )
            else:
                console.print(
                    f"  [red]API SSL certificate issue: {api_ssl_detail}[/red]"
                )
                all_ok = False

    # ── Troubleshooting ─────────────────────────────────────────────
    if not all_ok:
        console.print("")
        console.print(Panel("[bold yellow]Some checks failed[/bold yellow]"))
        _print_troubleshooting(
            env_path,
            repo_dir,
            ip,
            domain,
            ssl_enabled,
            use_proxy,
            api_ok,
            dash_ok if "dash_ok" in dir() else False,
        )

        retry = typer.confirm(
            "Would you like to view container logs to diagnose?",
            default=True,
        )
        if retry:
            console.print("")
            _show_diagnostic_logs(docker, repo_dir, ssl_enabled)

        console.print(
            "\n[dim]You can re-run setup after fixing issues: djinn setup[/dim]"
        )
    else:
        console.print("\n[green]All checks passed.[/green]")


def _check_url(url: str, timeout: int = 20) -> bool:
    """Check if a URL returns any HTTP response (2xx or 3xx)."""
    try:
        result = subprocess.run(
            [
                "curl",
                "-sfSL",
                "--max-time",
                str(timeout),
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                # Allow self-signed certs during initial setup
                "--insecure",
                url,
            ],
            capture_output=True,
            text=True,
            timeout=timeout + 5,
        )
        code = result.stdout.strip()
        return code.startswith("2") or code.startswith("3")
    except Exception:
        return False


def _check_ssl_cert(domain: str) -> tuple[bool, str]:
    """Verify the SSL certificate for a domain. Returns (ok, detail)."""
    try:
        result = subprocess.run(
            [
                "curl",
                "-svI",
                f"https://{domain}",
                "--max-time",
                "15",
                "-o",
                "/dev/null",
            ],
            capture_output=True,
            text=True,
            timeout=20,
        )
        stderr = result.stderr or ""

        # Check for successful TLS handshake
        if "SSL certificate verify ok" in stderr:
            # Extract issuer
            for line in stderr.splitlines():
                if "issuer:" in line.lower():
                    issuer = line.split(":", 1)[-1].strip()
                    return True, f"issued by {issuer}"
            return True, "verified"

        if "SSL certificate problem" in stderr:
            for line in stderr.splitlines():
                if "SSL certificate problem" in line:
                    return False, line.strip()
            return False, "certificate problem"

        # Traefik may still be provisioning the cert
        if "self-signed certificate" in stderr or "self signed" in stderr:
            return (
                False,
                "self-signed certificate (Let's Encrypt may still be provisioning)",
            )

        if result.returncode != 0:
            return False, "could not establish TLS connection"

        return True, "connected"
    except Exception as e:
        return False, str(e)


def _troubleshoot_api(docker: list[str], repo_dir: Path) -> None:
    """Print troubleshooting tips for API failures."""
    console.print("  [dim]Possible causes:[/dim]")
    console.print("    - Services still starting (database migrations)")
    console.print("    - Check API logs: docker compose logs api --tail=30")

    # Quick peek at API container status
    try:
        result = subprocess.run(
            [
                *docker,
                "compose",
                "ps",
                "api",
                "--format",
                "table {{.Name}}\t{{.Status}}",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.stdout.strip():
            console.print(f"  [dim]Container status:\n{result.stdout.strip()}[/dim]")
    except Exception:
        pass


def _print_troubleshooting(
    env_path: Path,
    repo_dir: Path,
    ip: str,
    domain: Optional[str],
    ssl_enabled: bool,
    use_proxy: bool,
    api_ok: bool,
    dash_ok: bool,
) -> None:
    """Print targeted troubleshooting based on which checks failed."""

    if not api_ok:
        console.print("[bold]API not responding:[/bold]")
        console.print("  - Wait 1-2 minutes for database migrations to complete")
        console.print("  - Check: docker compose logs api --tail=50")
        console.print("  - Check: docker compose logs postgres --tail=20")
        console.print("")

    if api_ok and not dash_ok:
        if use_proxy:
            console.print("[bold]Dashboard not reachable through Traefik:[/bold]")
            console.print(
                "  - Check Traefik is running: docker compose -f proxy/docker-compose.yml ps"
            )
            console.print(
                "  - Check Traefik logs: docker compose -f proxy/docker-compose.yml logs"
            )
            console.print("  - Verify ports 80/443 are not blocked by a firewall")
            if ssl_enabled and domain:
                console.print(f"  - Verify DNS: dig {domain} (should return {ip})")
                console.print("  - Traefik may need a minute to obtain the certificate")
        else:
            console.print("[bold]Dashboard not reachable:[/bold]")
            dash_port = get_env_value(env_path, "DASHBOARD_PORT") or "3000"
            console.print(f"  - Verify port {dash_port} is not blocked by a firewall")
            console.print(f"  - Check: docker compose logs dashboard --tail=20")
            console.print(f"  - Try locally: curl -I http://127.0.0.1:{dash_port}")
        console.print("")

    if ssl_enabled and domain:
        console.print("[bold]SSL troubleshooting:[/bold]")
        console.print(f"  - DNS must resolve: {domain} -> {ip}")
        api_domain = get_env_value(env_path, "API_DOMAIN")
        if api_domain and api_domain != domain:
            console.print(f"  - API DNS must also resolve: {api_domain} -> {ip}")
        console.print("  - Port 80 must be open (Let's Encrypt HTTP challenge)")
        console.print("  - Port 443 must be open")
        console.print(
            "  - Check firewall: ufw status / iptables -L / firewall-cmd --list-all"
        )
        console.print(
            "  - Traefik cert logs: docker compose -f proxy/docker-compose.yml logs traefik | grep -i acme"
        )
        console.print("  - Let's Encrypt rate limits: max 5 certs per domain per week")
        console.print("  - Certificate provisioning can take up to 2 minutes")
        console.print("")


def _show_diagnostic_logs(
    docker: list[str],
    repo_dir: Path,
    ssl_enabled: bool,
) -> None:
    """Show recent logs from key services for troubleshooting."""
    compose_cmd = [*docker, "compose"]

    services = [("api", 20), ("dashboard", 10), ("postgres", 10)]
    for svc, lines in services:
        console.print(f"\n[bold]--- {svc} logs (last {lines} lines) ---[/bold]")
        try:
            subprocess.run(
                [*compose_cmd, "logs", "--tail", str(lines), "--no-color", svc],
                cwd=repo_dir,
                timeout=10,
            )
        except Exception:
            console.print(f"  [dim]Could not retrieve {svc} logs[/dim]")

    if ssl_enabled:
        proxy_dir = repo_dir / "proxy"
        if proxy_dir.exists():
            console.print("\n[bold]--- traefik logs (last 20 lines) ---[/bold]")
            try:
                subprocess.run(
                    [*compose_cmd, "logs", "--tail", "20", "--no-color", "traefik"],
                    cwd=proxy_dir,
                    timeout=10,
                )
            except Exception:
                console.print("  [dim]Could not retrieve traefik logs[/dim]")


def step_print_summary(
    env_path: Path,
    repo_dir: Path,
    ip: str,
    domain: Optional[str],
    ssl_enabled: bool,
    use_proxy: bool,
    provider_id: Optional[str],
) -> None:
    """Print the final summary with access URLs and next steps."""
    api_port = get_env_value(env_path, "API_PORT") or "8000"
    dash_port = get_env_value(env_path, "DASHBOARD_PORT") or "3000"
    auth_enabled = get_env_value(env_path, "AUTH_ENABLED") == "true"

    # Read VITE_API_URL from .env — the source of truth for all routing modes
    vite_api_url = get_env_value(env_path, "VITE_API_URL")

    if ssl_enabled and domain:
        dashboard_url = f"https://{domain}"
        api_url = f"{vite_api_url}/v1" if vite_api_url else f"https://{domain}/v1"
    elif use_proxy:
        # HTTP-only Traefik (pre-built mode)
        dashboard_url = f"http://{ip}"
        api_url = f"{vite_api_url}/v1" if vite_api_url else f"http://{ip}/v1"
    else:
        dashboard_url = f"http://{ip}:{dash_port}"
        api_url = f"{vite_api_url}/v1" if vite_api_url else f"http://{ip}:{api_port}/v1"

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

    # ── Detect & stop existing stack ────────────────────────────────
    step_stop_existing(repo_dir)

    # ── Step 2: .env + image mode ───────────────────────────────────
    env_path = step_configure_env(repo_dir)
    image_mode = step_image_mode(env_path)

    # ── Step 3: Secrets ─────────────────────────────────────────────
    step_generate_secrets(env_path)

    # ── Step 4: Network / IP detection ──────────────────────────────
    ip = step_detect_ip(env_path)

    # ── Step 5: SSL decision (ask early so we can set VITE_API_URL) ─
    ssl_enabled = False
    domain = None
    # Pre-built always uses Traefik; still ask about SSL for certs
    use_proxy = image_mode == "prebuilt"

    if not skip_ssl:
        ssl_enabled = step_ask_ssl(ip)
    use_proxy = use_proxy or ssl_enabled

    # ── Step 6: Port check ──────────────────────────────────────────
    step_check_ports(env_path, use_proxy, repo_dir)

    # ── SSL configuration (sets VITE_API_URL, BIND_HOST, etc.) ──────
    if ssl_enabled:
        domain, _api_domain, _routing_mode = step_configure_ssl(env_path, repo_dir, ip)
        if not domain:
            ssl_enabled = False
            console.print("[yellow]SSL setup skipped. Continuing without SSL.[/yellow]")

    # ── Configure proxy / VITE_API_URL / CORS for the resolved mode ──
    if ssl_enabled and domain:
        # SSL already configured VITE_API_URL, BIND_HOST, and CORS_ORIGINS
        # in step_configure_ssl.
        pass
    elif use_proxy:
        # Pre-built without SSL — HTTP-only Traefik on port 80.
        # Dashboard and API share the same origin (http://ip),
        # so wildcard CORS is fine.
        set_env_value(env_path, "BIND_HOST", "127.0.0.1")
        set_env_value(env_path, "VITE_API_URL", f"http://{ip}")
        set_env_value(env_path, "CORS_ORIGINS", f"http://{ip}")
        _write_compose_override(repo_dir, domain=None, ssl=False)
        _setup_proxy_network()
        _write_proxy_compose(repo_dir, ssl=False)
    else:
        # Build from source, no proxy — direct port access.
        # Dashboard (:3000) and API (:8000) are on different ports = different
        # origins, so CORS must explicitly allow the dashboard origin.
        api_port = get_env_value(env_path, "API_PORT") or "8000"
        dash_port = get_env_value(env_path, "DASHBOARD_PORT") or "3000"
        dashboard_origin = f"http://{ip}:{dash_port}"
        set_env_value(env_path, "VITE_API_URL", f"http://{ip}:{api_port}")
        set_env_value(env_path, "CORS_ORIGINS", dashboard_origin)
        set_env_value(env_path, "BIND_HOST", "0.0.0.0")

    # ── Set COMPOSE_FILE for pre-built images ───────────────────────
    if image_mode == "prebuilt":
        compose_files = ["docker-compose.ghcr.yml"]
        override_path = repo_dir / "docker-compose.override.yml"
        if override_path.exists():
            compose_files.append("docker-compose.override.yml")
        set_env_value(env_path, "COMPOSE_FILE", ":".join(compose_files))
    else:
        # Build mode: docker compose auto-picks up override if it exists
        # Don't set COMPOSE_FILE — let docker compose use defaults
        pass

    # ── Step 7: Provider API key ────────────────────────────────────
    provider_id = None
    if not skip_provider:
        provider_id = step_provider_key(env_path)

    # ── Start everything ────────────────────────────────────────────
    step_start_stack(repo_dir, env_path, image_mode, use_proxy)

    # ── Register provider with running API ──────────────────────────
    step_configure_provider_api(env_path, provider_id)

    # ── Verify dashboard & SSL reachability ─────────────────────────
    step_verify_deployment(env_path, repo_dir, ip, domain, ssl_enabled, use_proxy)

    # ── Summary ─────────────────────────────────────────────────────
    step_print_summary(
        env_path,
        repo_dir,
        ip,
        domain,
        ssl_enabled,
        use_proxy,
        provider_id,
    )
