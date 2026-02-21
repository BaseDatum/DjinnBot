"""Tests for CLI commands — verifies typer commands produce correct output."""

import httpx
import respx
from typer.testing import CliRunner

from djinnbot.main import app
from tests.conftest import (
    SAMPLE_STATUS,
    SAMPLE_PIPELINES,
    SAMPLE_PIPELINE,
    SAMPLE_VALIDATE_OK,
    SAMPLE_VALIDATE_FAIL,
    SAMPLE_AGENTS,
    SAMPLE_AGENT,
    SAMPLE_AGENTS_STATUS,
    SAMPLE_AGENT_STATUS,
    SAMPLE_AGENT_RUNS,
    SAMPLE_AGENT_CONFIG,
    SAMPLE_AGENT_PROJECTS,
    SAMPLE_VAULTS,
    SAMPLE_VAULT_FILES,
    SAMPLE_VAULT_FILE,
    SAMPLE_SEARCH_RESULTS,
)

runner = CliRunner()


# ── Status ──────────────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_status_command(respx_mock):
    respx_mock.get("/v1/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_STATUS)
    )
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "ok" in result.output
    assert "0.1.0" in result.output
    assert "connected" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_status_command_with_github(respx_mock):
    respx_mock.get("/v1/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_STATUS)
    )
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 0
    assert "GitHub App" in result.output
    assert "healthy" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_status_command_server_error(respx_mock):
    respx_mock.get("/v1/status").mock(
        return_value=httpx.Response(500, json={"detail": "error"})
    )
    result = runner.invoke(app, ["status"])
    assert result.exit_code == 1
    assert "Error" in result.output


# ── Pipeline commands ───────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_pipeline_list(respx_mock):
    respx_mock.get("/v1/pipelines/").mock(
        return_value=httpx.Response(200, json=SAMPLE_PIPELINES)
    )
    result = runner.invoke(app, ["pipeline", "list"])
    assert result.exit_code == 0
    assert "code-review" in result.output
    assert "Code Review" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_pipeline_list_empty(respx_mock):
    respx_mock.get("/v1/pipelines/").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["pipeline", "list"])
    assert result.exit_code == 0
    assert "No pipelines found" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_pipeline_show(respx_mock):
    respx_mock.get("/v1/pipelines/code-review").mock(
        return_value=httpx.Response(200, json=SAMPLE_PIPELINE)
    )
    result = runner.invoke(app, ["pipeline", "show", "code-review"])
    assert result.exit_code == 0
    assert "Code Review" in result.output
    assert "analyze" in result.output
    assert "report" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_pipeline_validate_ok(respx_mock):
    respx_mock.post("/v1/pipelines/code-review/validate").mock(
        return_value=httpx.Response(200, json=SAMPLE_VALIDATE_OK)
    )
    result = runner.invoke(app, ["pipeline", "validate", "code-review"])
    assert result.exit_code == 0
    assert "valid" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_pipeline_validate_fail(respx_mock):
    respx_mock.post("/v1/pipelines/bad-pipeline/validate").mock(
        return_value=httpx.Response(200, json=SAMPLE_VALIDATE_FAIL)
    )
    result = runner.invoke(app, ["pipeline", "validate", "bad-pipeline"])
    assert result.exit_code == 1
    assert "invalid" in result.output
    assert "no steps" in result.output


# ── Agent commands ──────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_agent_list(respx_mock):
    respx_mock.get("/v1/agents/").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS)
    )
    result = runner.invoke(app, ["agent", "list"])
    assert result.exit_code == 0
    assert "Reviewer Bot" in result.output
    assert "Writer Bot" in result.output
    assert "reviewer" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_agent_show(respx_mock):
    respx_mock.get("/v1/agents/reviewer").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT)
    )
    result = runner.invoke(app, ["agent", "show", "reviewer"])
    assert result.exit_code == 0
    assert "Reviewer Bot" in result.output
    assert "Code reviewer" in result.output
    assert "IDENTITY.md" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_agent_status_single(respx_mock):
    respx_mock.get("/v1/agents/reviewer/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_STATUS)
    )
    result = runner.invoke(app, ["agent", "status", "reviewer"])
    assert result.exit_code == 0
    assert "Reviewer Bot" in result.output
    assert "online" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_agent_status_fleet(respx_mock):
    respx_mock.get("/v1/agents/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS_STATUS)
    )
    result = runner.invoke(app, ["agent", "status"])
    assert result.exit_code == 0
    assert "Fleet Summary" in result.output
    assert "Total: 2" in result.output
    assert "Reviewer Bot" in result.output
    assert "Writer Bot" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_agent_runs(respx_mock):
    respx_mock.get("/v1/agents/reviewer/runs").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_RUNS)
    )
    result = runner.invoke(app, ["agent", "runs", "reviewer"])
    assert result.exit_code == 0
    assert "code-review" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_agent_config(respx_mock):
    respx_mock.get("/v1/agents/reviewer/config").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_CONFIG)
    )
    result = runner.invoke(app, ["agent", "config", "reviewer"])
    assert result.exit_code == 0
    assert "claude-sonnet-4-20250514" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_agent_projects(respx_mock):
    respx_mock.get("/v1/agents/reviewer/projects").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_PROJECTS)
    )
    result = runner.invoke(app, ["agent", "projects", "reviewer"])
    assert result.exit_code == 0
    assert "My Project" in result.output
    assert "lead" in result.output


# ── Memory commands ─────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_memory_vaults(respx_mock):
    respx_mock.get("/v1/memory/vaults").mock(
        return_value=httpx.Response(200, json=SAMPLE_VAULTS)
    )
    result = runner.invoke(app, ["memory", "vaults"])
    assert result.exit_code == 0
    assert "reviewer" in result.output
    assert "writer" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_memory_list(respx_mock):
    respx_mock.get("/v1/memory/vaults/reviewer").mock(
        return_value=httpx.Response(200, json=SAMPLE_VAULT_FILES)
    )
    result = runner.invoke(app, ["memory", "list", "reviewer"])
    assert result.exit_code == 0
    assert "session-log.md" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_memory_show(respx_mock):
    respx_mock.get("/v1/memory/vaults/reviewer/session-log.md").mock(
        return_value=httpx.Response(200, json=SAMPLE_VAULT_FILE)
    )
    result = runner.invoke(app, ["memory", "show", "reviewer", "session-log.md"])
    assert result.exit_code == 0
    assert "session-log.md" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_memory_search(respx_mock):
    respx_mock.get("/v1/memory/search").mock(
        return_value=httpx.Response(200, json=SAMPLE_SEARCH_RESULTS)
    )
    result = runner.invoke(app, ["memory", "search", "bug"])
    assert result.exit_code == 0
    assert "reviewer" in result.output
    assert "session-log.md" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_memory_delete(respx_mock):
    respx_mock.delete("/v1/agents/reviewer/memory/session-log.md").mock(
        return_value=httpx.Response(
            200,
            json={
                "agent_id": "reviewer",
                "filename": "session-log.md",
                "deleted": True,
            },
        )
    )
    result = runner.invoke(
        app, ["memory", "delete", "reviewer", "session-log.md"], input="y\n"
    )
    assert result.exit_code == 0
    assert "Deleted" in result.output


# ── URL override ────────────────────────────────────────────────────


@respx.mock(base_url="http://custom:9000")
def test_url_override(respx_mock):
    respx_mock.get("/v1/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_STATUS)
    )
    result = runner.invoke(app, ["--url", "http://custom:9000", "status"])
    assert result.exit_code == 0
    assert "ok" in result.output


# ── No-args shows help ──────────────────────────────────────────────


def test_no_args_shows_help():
    result = runner.invoke(app, [])
    # Typer returns exit code 0 or 2 for help display depending on version
    assert result.exit_code in (0, 2)
    assert (
        "DjinnBot CLI" in result.output
        or "Usage" in result.output
        or "agent" in result.output
    )
