"""Update DjinnBot to the latest version.

Detects the installation directory, pulls the latest GHCR images,
and recreates all Docker Compose containers with the new images.
"""

import os
import subprocess
import sys
from pathlib import Path
from typing import Optional

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich import box

console = Console()

# Markers that identify a djinnbot installation directory
_DJINNBOT_MARKERS = ["docker-compose.ghcr.yml", "docker-compose.yml", ".env"]

# GHCR images managed by the compose stack (pulled via `docker compose pull`)
# plus the agent-runtime image which is spawned dynamically by the engine.
AGENT_RUNTIME_IMAGE = "ghcr.io/basedatum/djinnbot/agent-runtime"


# ── Helpers (duplicated minimally from setup to keep update self-contained) ──


def _get_env_value(env_path: Path, key: str) -> str:
    """Read a value from a .env file."""
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


def _docker_cmd() -> list[str]:
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

    try:
        subprocess.run(
            ["sudo", "docker", "ps"],
            capture_output=True,
            timeout=10,
            check=True,
        )
        console.print("[yellow]Using sudo for docker commands.[/yellow]")
        return ["sudo", "docker"]
    except Exception:
        pass

    console.print("[red]Cannot access Docker. Is Docker running?[/red]")
    raise typer.Exit(1)


def _run_cmd(
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
            result = subprocess.run(cmd, cwd=cwd, env=merged_env, check=check)
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


def _find_install_dir(hint: Optional[str] = None) -> Path:
    """Locate the djinnbot installation directory.

    Search order:
      1. Explicit --dir argument
      2. Current working directory
      3. ~/djinnbot (default install location)

    A valid installation must contain docker-compose.ghcr.yml or
    docker-compose.yml and a .env file.
    """
    candidates: list[Path] = []

    if hint:
        candidates.append(Path(hint).expanduser().resolve())

    candidates.append(Path.cwd())
    candidates.append(Path.home() / "djinnbot")

    for path in candidates:
        if not path.is_dir():
            continue
        # Must have at least a compose file and .env
        has_compose = (path / "docker-compose.ghcr.yml").exists() or (
            path / "docker-compose.yml"
        ).exists()
        has_env = (path / ".env").exists()
        if has_compose and has_env:
            return path

    # Nothing found
    searched = ", ".join(str(p) for p in candidates)
    console.print(
        f"[red]Could not find a DjinnBot installation.[/red]\n"
        f"[dim]Searched: {searched}[/dim]\n"
        f"[dim]Specify the path with --dir, or run from the install directory.[/dim]"
    )
    raise typer.Exit(1)


def _detect_image_mode(env_path: Path) -> str:
    """Detect whether the installation uses pre-built (ghcr) or build-from-source images."""
    compose_file = _get_env_value(env_path, "COMPOSE_FILE")
    if "ghcr" in compose_file:
        return "prebuilt"
    return "build"


def _get_compose_services(docker: list[str], repo_dir: Path) -> list[str]:
    """Return list of running compose service names."""
    try:
        result = subprocess.run(
            [*docker, "compose", "ps", "--services"],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=15,
        )
        return [s.strip() for s in result.stdout.strip().splitlines() if s.strip()]
    except Exception:
        return []


# ── Update command ──────────────────────────────────────────────────────────


def update(
    install_dir: Optional[str] = typer.Option(
        None,
        "--dir",
        "-d",
        help="DjinnBot installation directory (auto-detected if omitted)",
    ),
    skip_restart: bool = typer.Option(
        False,
        "--no-restart",
        help="Pull images but do not recreate containers",
    ),
    version: Optional[str] = typer.Option(
        None,
        "--version",
        "-v",
        help="Specific image tag to pull (default: uses DJINNBOT_VERSION from .env or 'latest')",
    ),
):
    """Update DjinnBot to the latest container images.

    Detects the installation, pulls the latest GHCR images for all
    services, and recreates the containers so they run the new versions.

    Data volumes (postgres, redis, djinnbot-data) are preserved.
    """
    console.print("")
    console.print(
        Panel(
            "[bold cyan]DjinnBot Update[/bold cyan]",
            border_style="cyan",
        )
    )

    # ── 1. Locate installation ──────────────────────────────────────
    repo_dir = _find_install_dir(install_dir)
    env_path = repo_dir / ".env"
    console.print(f"[green]Installation found:[/green] {repo_dir}")

    docker = _docker_cmd()
    compose_cmd = [*docker, "compose"]

    image_mode = _detect_image_mode(env_path)
    current_version = _get_env_value(env_path, "DJINNBOT_VERSION") or "latest"
    target_version = version or current_version

    console.print(f"[dim]Image mode: {image_mode}[/dim]")
    console.print(f"[dim]Target version: {target_version}[/dim]")

    if image_mode == "build":
        console.print(
            "[yellow]This installation is configured to build from source.[/yellow]\n"
            "[dim]To update, pull the latest code and rebuild:[/dim]\n"
            "[dim]  cd {repo_dir} && git pull && docker compose up -d --build[/dim]\n\n"
            "[dim]To switch to pre-built images, re-run: djinn setup[/dim]"
        )
        raise typer.Exit(1)

    # ── 2. Pull compose service images ──────────────────────────────
    console.print(Panel("[bold]Pulling latest images[/bold]"))

    # If user specified a version, update .env so compose picks it up
    if version:
        from djinnbot.commands.setup import set_env_value

        set_env_value(env_path, "DJINNBOT_VERSION", version)
        console.print(f"[green]Set DJINNBOT_VERSION={version} in .env[/green]")

    console.print("[bold]Pulling compose service images...[/bold]")
    try:
        _run_cmd(
            [*compose_cmd, "pull"],
            cwd=repo_dir,
            stream=True,
        )
        console.print("[green]Compose images pulled successfully[/green]")
    except Exception:
        console.print("[red]Failed to pull some compose images[/red]")
        console.print("[dim]Check your network connection and try again.[/dim]")
        raise typer.Exit(1)

    # Pull agent-runtime image (not in compose, spawned dynamically by engine)
    agent_image = f"{AGENT_RUNTIME_IMAGE}:{target_version}"
    console.print(f"\n[bold]Pulling agent-runtime image ({target_version})...[/bold]")
    try:
        _run_cmd([*docker, "pull", agent_image], stream=True)
        # Tag as the fallback name the engine uses
        _run_cmd(
            [*docker, "tag", agent_image, "djinnbot/agent-runtime:latest"],
            check=False,
        )
        console.print("[green]Agent-runtime image pulled[/green]")
    except Exception:
        console.print(
            "[yellow]Could not pull agent-runtime image (non-fatal).[/yellow]\n"
            f"[dim]Pull manually: docker pull {agent_image}[/dim]"
        )

    if skip_restart:
        console.print(
            "\n[green]Images pulled. Skipping container restart (--no-restart).[/green]\n"
            "[dim]Restart manually: docker compose up -d[/dim]"
        )
        return

    # ── 3. Recreate containers with new images ──────────────────────
    console.print(Panel("[bold]Recreating containers[/bold]"))

    # Check if proxy stack is running and update it too
    proxy_dir = repo_dir / "proxy"
    proxy_running = False
    if proxy_dir.exists() and (proxy_dir / "docker-compose.yml").exists():
        try:
            result = subprocess.run(
                [*docker, "compose", "ps", "-q"],
                cwd=proxy_dir,
                capture_output=True,
                text=True,
                timeout=15,
            )
            proxy_running = bool(result.stdout.strip())
        except Exception:
            pass

    if proxy_running:
        console.print("[dim]Updating Traefik proxy...[/dim]")
        try:
            _run_cmd(
                [*compose_cmd, "pull"],
                cwd=proxy_dir,
                stream=True,
                check=False,
            )
            _run_cmd(
                [*compose_cmd, "up", "-d", "--force-recreate"],
                cwd=proxy_dir,
                stream=True,
                check=False,
            )
            console.print("[green]Traefik proxy updated[/green]")
        except Exception:
            console.print("[yellow]Could not update proxy (non-fatal)[/yellow]")

    console.print("[bold]Recreating DjinnBot services...[/bold]")
    try:
        _run_cmd(
            [*compose_cmd, "up", "-d", "--force-recreate"],
            cwd=repo_dir,
            stream=True,
        )
        console.print("[green]All containers recreated with new images[/green]")
    except Exception:
        console.print("[red]Failed to recreate containers[/red]")
        console.print("[dim]Check logs: docker compose logs --tail=50[/dim]")
        raise typer.Exit(1)

    # ── 4. Wait for API health ──────────────────────────────────────
    api_port = _get_env_value(env_path, "API_PORT") or "8000"
    health_url = f"http://127.0.0.1:{api_port}/v1/status"

    console.print(f"\n[bold]Waiting for API to become healthy...[/bold]")
    import time

    start = time.time()
    healthy = False
    while time.time() - start < 120:
        try:
            result = subprocess.run(
                ["curl", "-sf", "--max-time", "3", health_url],
                capture_output=True,
                timeout=10,
            )
            if result.returncode == 0:
                healthy = True
                break
        except Exception:
            pass
        time.sleep(3)

    if healthy:
        console.print("[green]API is healthy[/green]")
    else:
        console.print(
            "[yellow]API did not become healthy within 2 minutes.[/yellow]\n"
            "[dim]It may still be starting. Check: djinn status[/dim]"
        )

    # ── 5. Summary ──────────────────────────────────────────────────
    console.print("")

    # Show running container versions
    console.print(Panel("[bold]Update complete[/bold]", border_style="green"))

    try:
        result = subprocess.run(
            [
                *docker,
                "compose",
                "ps",
                "--format",
                "table {{.Name}}\t{{.Image}}\t{{.Status}}",
            ],
            cwd=repo_dir,
            capture_output=True,
            text=True,
            timeout=15,
        )
        if result.stdout.strip():
            console.print(result.stdout.strip())
    except Exception:
        pass

    console.print(
        f"\n[dim]Installation: {repo_dir}[/dim]\n[dim]Version: {target_version}[/dim]"
    )
    console.print("[dim]Data volumes have been preserved.[/dim]")
