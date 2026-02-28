"""Resolve command — resolve a GitHub issue via the resolve pipeline."""

import json
from typing import Optional

import typer
from djinnbot.client import DjinnBotClient
from djinnbot.formatting import (
    console,
    print_status,
    colored_status,
    print_run_progress,
)

app = typer.Typer(help="Resolve GitHub issues")


def _get_client(ctx: typer.Context) -> DjinnBotClient:
    if ctx.obj and "client" in ctx.obj:
        return ctx.obj["client"]
    return DjinnBotClient()


def resolve(
    ctx: typer.Context,
    issue_url: str = typer.Argument(
        ...,
        help="GitHub issue URL (https://github.com/owner/repo/issues/123) or shorthand (owner/repo#123)",
    ),
    project_id: Optional[str] = typer.Option(
        None,
        "--project",
        "-p",
        help="Link to an existing DjinnBot project (auto-detected if repo matches)",
    ),
    model: Optional[str] = typer.Option(
        None,
        "--model",
        "-m",
        help="Override the default model for this run",
    ),
    follow: bool = typer.Option(
        False,
        "--follow",
        "-f",
        help="Stream run events in real-time after starting",
    ),
):
    """Resolve a GitHub issue end-to-end.

    Takes a GitHub issue URL, fetches the issue details, and starts the
    resolve pipeline which will:

      1. ANALYZE  — Read the codebase, understand the issue, plan a fix
      2. IMPLEMENT — Write code, tests, and commit
      3. VALIDATE — Run the test suite and verify correctness
      4. PR       — Open a pull request referencing the issue

    Examples:

        djinn resolve https://github.com/acme/app/issues/42

        djinn resolve acme/app#42 --follow

        djinn resolve acme/app#42 --project proj_abc123
    """
    client = _get_client(ctx)

    # ── Validate the URL first ──────────────────────────────────────────
    try:
        parsed = client.parse_issue_url(issue_url)
    except Exception as e:
        # Try to give a helpful error
        detail = ""
        if hasattr(e, "response"):
            try:
                detail = e.response.json().get("detail", "")
            except Exception:
                pass
        console.print(f"[red]Invalid issue reference: {detail or e}[/red]")
        console.print(
            "[dim]Use: https://github.com/owner/repo/issues/123 or owner/repo#123[/dim]"
        )
        raise typer.Exit(1)

    owner = parsed["owner"]
    repo = parsed["repo"]
    number = parsed["number"]

    console.print(f"\n[bold]Resolving issue:[/bold] {owner}/{repo}#{number}\n")

    # ── Start the resolve pipeline ──────────────────────────────────────
    try:
        result = client.resolve_issue(
            issue_url=issue_url,
            project_id=project_id,
            model=model,
        )
    except Exception as e:
        detail = ""
        if hasattr(e, "response"):
            try:
                detail = e.response.json().get("detail", "")
            except Exception:
                pass
        console.print(f"[red]Failed to start resolve: {detail or e}[/red]")
        raise typer.Exit(1)

    run_id = result["run_id"]
    issue_title = result.get("issue_title", f"Issue #{number}")

    print_status("Run ID", run_id)
    print_status("Pipeline", "resolve")
    print_status("Issue", f"#{number} — {issue_title}")
    print_status("Repository", result.get("repo_full_name", f"{owner}/{repo}"))
    print_status("Status", result.get("status", "pending"), "yellow")

    console.print(f"\n[dim]View in dashboard: /runs/{run_id}[/dim]")

    # ── Optionally stream events ────────────────────────────────────────
    if follow:
        console.print("\n[bold]Streaming events...[/bold] (Ctrl+C to detach)\n")
        try:
            for event in client.stream_run_events(run_id):
                event_type = event.get("type", "")

                if event_type == "STEP_STARTED":
                    step = event.get("stepId", "?")
                    agent = event.get("agentId", "?")
                    console.print(
                        f"  [yellow]>[/yellow] Step [bold]{step}[/bold] started (agent: {agent})"
                    )

                elif event_type == "STEP_COMPLETE":
                    step = event.get("stepId", "?")
                    console.print(
                        f"  [green]✓[/green] Step [bold]{step}[/bold] completed"
                    )

                elif event_type == "STEP_FAILED":
                    step = event.get("stepId", "?")
                    error = event.get("error", "")
                    console.print(
                        f"  [red]✗[/red] Step [bold]{step}[/bold] failed: {error[:100]}"
                    )

                elif event_type == "RUN_COMPLETE":
                    console.print(
                        f"\n[green bold]Run completed successfully.[/green bold]"
                    )
                    # Try to show PR URL from outputs
                    try:
                        run_data = client.get_run(run_id)
                        outputs = run_data.get("outputs", {})
                        pr_url = outputs.get("pr_url")
                        if pr_url:
                            console.print(f"\n[bold]Pull Request:[/bold] {pr_url}")
                    except Exception:
                        pass
                    break

                elif event_type == "RUN_FAILED":
                    console.print(f"\n[red bold]Run failed.[/red bold]")
                    break

                elif event_type == "output":
                    # Agent output chunks
                    text = event.get("text", "")
                    if text:
                        console.print(text, end="")

        except KeyboardInterrupt:
            console.print("\n[dim]Detached from event stream.[/dim]")
        except Exception as e:
            console.print(f"\n[yellow]Stream ended: {e}[/yellow]")

    else:
        console.print(
            f"\n[dim]Use --follow to stream events, or check the dashboard.[/dim]"
        )
