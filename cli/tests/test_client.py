"""Tests for DjinnBotClient — verifies correct URL paths and HTTP methods."""

import httpx
import respx
import pytest

from djinnbot.client import DjinnBotClient
from tests.conftest import (
    SAMPLE_STATUS,
    SAMPLE_PIPELINES,
    SAMPLE_PIPELINE,
    SAMPLE_VALIDATE_OK,
    SAMPLE_RUN,
    SAMPLE_RUN_LIST,
    SAMPLE_RUN_LOGS,
    SAMPLE_RUN_OUTPUTS,
    SAMPLE_AGENTS,
    SAMPLE_AGENT,
    SAMPLE_AGENTS_STATUS,
    SAMPLE_AGENT_STATUS,
    SAMPLE_AGENT_RUNS,
    SAMPLE_AGENT_CONFIG,
    SAMPLE_AGENT_PROJECTS,
    SAMPLE_STEP,
    SAMPLE_STEP_LOGS,
    SAMPLE_RUN_STEPS,
    SAMPLE_VAULTS,
    SAMPLE_VAULT_FILES,
    SAMPLE_VAULT_FILE,
    SAMPLE_SEARCH_RESULTS,
)


# ── Status ──────────────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_get_status(respx_mock):
    respx_mock.get("/v1/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_STATUS)
    )
    client = DjinnBotClient()
    result = client.get_status()
    assert result["status"] == "ok"
    assert result["redis_connected"] is True
    assert result["total_agents"] == 4
    client.close()


# ── Pipelines ───────────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_list_pipelines(respx_mock):
    respx_mock.get("/v1/pipelines/").mock(
        return_value=httpx.Response(200, json=SAMPLE_PIPELINES)
    )
    client = DjinnBotClient()
    result = client.list_pipelines()
    assert len(result) == 1
    assert result[0]["id"] == "code-review"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_pipeline(respx_mock):
    respx_mock.get("/v1/pipelines/code-review").mock(
        return_value=httpx.Response(200, json=SAMPLE_PIPELINE)
    )
    client = DjinnBotClient()
    result = client.get_pipeline("code-review")
    assert result["name"] == "Code Review"
    assert len(result["steps"]) == 2
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_validate_pipeline(respx_mock):
    respx_mock.post("/v1/pipelines/code-review/validate").mock(
        return_value=httpx.Response(200, json=SAMPLE_VALIDATE_OK)
    )
    client = DjinnBotClient()
    result = client.validate_pipeline("code-review")
    assert result["valid"] is True
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_pipeline_raw(respx_mock):
    raw_data = {
        "pipeline_id": "code-review",
        "yaml": "id: code-review\nname: Test",
        "file": "code-review.yml",
    }
    respx_mock.get("/v1/pipelines/code-review/raw").mock(
        return_value=httpx.Response(200, json=raw_data)
    )
    client = DjinnBotClient()
    result = client.get_pipeline_raw("code-review")
    assert "yaml" in result
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_update_pipeline(respx_mock):
    respx_mock.put("/v1/pipelines/code-review").mock(
        return_value=httpx.Response(
            200, json={"status": "updated", "pipeline_id": "code-review"}
        )
    )
    client = DjinnBotClient()
    result = client.update_pipeline("code-review", "id: code-review\nname: Updated")
    assert result["status"] == "updated"
    client.close()


# ── Runs ────────────────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_start_run(respx_mock):
    created = {
        "id": "run_new123",
        "pipeline_id": "code-review",
        "task": "Test task",
        "status": "pending",
        "created_at": 1700000000000,
        "updated_at": 1700000000000,
    }
    respx_mock.post("/v1/runs/").mock(return_value=httpx.Response(200, json=created))
    client = DjinnBotClient()
    result = client.start_run("code-review", "Test task")
    assert result["id"] == "run_new123"
    assert result["status"] == "pending"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_list_runs(respx_mock):
    respx_mock.get("/v1/runs/").mock(
        return_value=httpx.Response(200, json=SAMPLE_RUN_LIST)
    )
    client = DjinnBotClient()
    result = client.list_runs()
    assert len(result) == 1
    assert result[0]["pipeline_id"] == "code-review"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_list_runs_with_filters(respx_mock):
    respx_mock.get("/v1/runs/").mock(return_value=httpx.Response(200, json=[]))
    client = DjinnBotClient()
    result = client.list_runs(pipeline_id="code-review", status="running")
    assert result == []
    # Verify query params were sent
    request = respx_mock.calls[0].request
    assert "pipeline_id=code-review" in str(request.url)
    assert "status=running" in str(request.url)
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_run(respx_mock):
    respx_mock.get("/v1/runs/run_abc123def456").mock(
        return_value=httpx.Response(200, json=SAMPLE_RUN)
    )
    client = DjinnBotClient()
    result = client.get_run("run_abc123def456")
    assert result["status"] == "running"
    assert len(result["steps"]) == 2
    assert result["steps"][0]["agent_id"] == "reviewer"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_cancel_run(respx_mock):
    respx_mock.post("/v1/runs/run_abc123def456/cancel").mock(
        return_value=httpx.Response(
            200, json={"run_id": "run_abc123def456", "status": "cancelled"}
        )
    )
    client = DjinnBotClient()
    result = client.cancel_run("run_abc123def456")
    assert result["status"] == "cancelled"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_restart_run(respx_mock):
    respx_mock.post("/v1/runs/run_abc123def456/restart").mock(
        return_value=httpx.Response(200, json=SAMPLE_RUN)
    )
    client = DjinnBotClient()
    result = client.restart_run("run_abc123def456", context="Try again")
    assert result["id"] == "run_abc123def456"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_pause_run(respx_mock):
    respx_mock.post("/v1/runs/run_abc123def456/pause").mock(
        return_value=httpx.Response(
            200, json={"run_id": "run_abc123def456", "status": "paused"}
        )
    )
    client = DjinnBotClient()
    result = client.pause_run("run_abc123def456")
    assert result["status"] == "paused"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_resume_run(respx_mock):
    respx_mock.post("/v1/runs/run_abc123def456/resume").mock(
        return_value=httpx.Response(
            200,
            json={
                "run_id": "run_abc123def456",
                "status": "running",
                "requeued_steps": 1,
            },
        )
    )
    client = DjinnBotClient()
    result = client.resume_run("run_abc123def456")
    assert result["status"] == "running"
    assert result["requeued_steps"] == 1
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_delete_run(respx_mock):
    respx_mock.delete("/v1/runs/run_abc123def456").mock(
        return_value=httpx.Response(
            200, json={"status": "deleted", "run_id": "run_abc123def456"}
        )
    )
    client = DjinnBotClient()
    result = client.delete_run("run_abc123def456")
    assert result["status"] == "deleted"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_run_logs(respx_mock):
    respx_mock.get("/v1/runs/run_abc123def456/logs").mock(
        return_value=httpx.Response(200, json=SAMPLE_RUN_LOGS)
    )
    client = DjinnBotClient()
    result = client.get_run_logs("run_abc123def456")
    assert len(result) == 2
    assert result[0]["type"] == "RUN_CREATED"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_run_outputs(respx_mock):
    respx_mock.get("/v1/runs/run_abc123def456/outputs").mock(
        return_value=httpx.Response(200, json=SAMPLE_RUN_OUTPUTS)
    )
    client = DjinnBotClient()
    result = client.get_run_outputs("run_abc123def456")
    assert "analysis_result" in result
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_list_run_steps(respx_mock):
    respx_mock.get("/v1/runs/run_abc123def456/steps").mock(
        return_value=httpx.Response(200, json=SAMPLE_RUN_STEPS)
    )
    client = DjinnBotClient()
    result = client.list_run_steps("run_abc123def456")
    assert len(result) == 2
    client.close()


# ── Steps ───────────────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_get_step(respx_mock):
    respx_mock.get("/v1/steps/run_abc123def456/analyze").mock(
        return_value=httpx.Response(200, json=SAMPLE_STEP)
    )
    client = DjinnBotClient()
    result = client.get_step("run_abc123def456", "analyze")
    assert result["agent_id"] == "reviewer"
    assert result["status"] == "running"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_restart_step(respx_mock):
    respx_mock.post("/v1/steps/run_abc123def456/analyze/restart").mock(
        return_value=httpx.Response(
            200,
            json={
                "run_id": "run_abc123def456",
                "step_id": "analyze",
                "status": "restarting",
            },
        )
    )
    client = DjinnBotClient()
    result = client.restart_step(
        "run_abc123def456", "analyze", context="Fix the approach"
    )
    assert result["status"] == "restarting"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_step_logs(respx_mock):
    respx_mock.get("/v1/steps/run_abc123def456/analyze/logs").mock(
        return_value=httpx.Response(200, json=SAMPLE_STEP_LOGS)
    )
    client = DjinnBotClient()
    result = client.get_step_logs("run_abc123def456", "analyze")
    assert len(result) == 1
    assert result[0]["type"] == "STEP_STARTED"
    client.close()


# ── Agents ──────────────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_list_agents(respx_mock):
    respx_mock.get("/v1/agents/").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS)
    )
    client = DjinnBotClient()
    result = client.list_agents()
    assert len(result) == 2
    assert result[0]["id"] == "reviewer"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agent(respx_mock):
    respx_mock.get("/v1/agents/reviewer").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT)
    )
    client = DjinnBotClient()
    result = client.get_agent("reviewer")
    assert result["name"] == "Reviewer Bot"
    assert "files" in result
    assert "soul_preview" in result
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agents_status(respx_mock):
    respx_mock.get("/v1/agents/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS_STATUS)
    )
    client = DjinnBotClient()
    result = client.get_agents_status()
    assert "agents" in result
    assert "summary" in result
    assert result["summary"]["total"] == 2
    assert result["agents"][0]["state"] == "working"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agent_status(respx_mock):
    respx_mock.get("/v1/agents/reviewer/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_STATUS)
    )
    client = DjinnBotClient()
    result = client.get_agent_status("reviewer")
    assert result["status"] == "online"
    assert len(result["active_steps"]) == 1
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agent_runs(respx_mock):
    respx_mock.get("/v1/agents/reviewer/runs").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_RUNS)
    )
    client = DjinnBotClient()
    result = client.get_agent_runs("reviewer")
    assert len(result) == 1
    assert result[0]["pipeline_id"] == "code-review"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agent_config(respx_mock):
    respx_mock.get("/v1/agents/reviewer/config").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_CONFIG)
    )
    client = DjinnBotClient()
    result = client.get_agent_config("reviewer")
    assert result["model"] == "claude-sonnet-4-20250514"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_update_agent_config(respx_mock):
    respx_mock.put("/v1/agents/reviewer/config").mock(
        return_value=httpx.Response(
            200, json={"status": "updated", "config": {"model": "gpt-4o"}}
        )
    )
    client = DjinnBotClient()
    result = client.update_agent_config("reviewer", {"model": "gpt-4o"})
    assert result["status"] == "updated"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agent_projects(respx_mock):
    respx_mock.get("/v1/agents/reviewer/projects").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT_PROJECTS)
    )
    client = DjinnBotClient()
    result = client.get_agent_projects("reviewer")
    assert len(result) == 1
    assert result[0]["role"] == "lead"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agent_memory(respx_mock):
    respx_mock.get("/v1/agents/reviewer/memory").mock(
        return_value=httpx.Response(200, json=SAMPLE_VAULT_FILES)
    )
    client = DjinnBotClient()
    result = client.get_agent_memory("reviewer")
    assert len(result) == 1
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_agent_memory_file(respx_mock):
    respx_mock.get("/v1/agents/reviewer/memory/session-log.md").mock(
        return_value=httpx.Response(
            200, json={"filename": "session-log.md", "content": "test"}
        )
    )
    client = DjinnBotClient()
    result = client.get_agent_memory_file("reviewer", "session-log.md")
    assert result["content"] == "test"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_delete_agent_memory_file(respx_mock):
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
    client = DjinnBotClient()
    result = client.delete_agent_memory_file("reviewer", "session-log.md")
    assert result["deleted"] is True
    client.close()


# ── Memory ──────────────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_list_vaults(respx_mock):
    respx_mock.get("/v1/memory/vaults").mock(
        return_value=httpx.Response(200, json=SAMPLE_VAULTS)
    )
    client = DjinnBotClient()
    result = client.list_vaults()
    assert len(result) == 2
    assert result[0]["agent_id"] == "reviewer"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_list_vault_files(respx_mock):
    respx_mock.get("/v1/memory/vaults/reviewer").mock(
        return_value=httpx.Response(200, json=SAMPLE_VAULT_FILES)
    )
    client = DjinnBotClient()
    result = client.list_vault_files("reviewer")
    assert len(result) == 1
    assert result[0]["filename"] == "session-log.md"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_vault_file(respx_mock):
    respx_mock.get("/v1/memory/vaults/reviewer/session-log.md").mock(
        return_value=httpx.Response(200, json=SAMPLE_VAULT_FILE)
    )
    client = DjinnBotClient()
    result = client.get_vault_file("reviewer", "session-log.md")
    assert "content" in result
    assert "metadata" in result
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_search_memory(respx_mock):
    respx_mock.get("/v1/memory/search").mock(
        return_value=httpx.Response(200, json=SAMPLE_SEARCH_RESULTS)
    )
    client = DjinnBotClient()
    result = client.search_memory("bug", agent_id="reviewer", limit=10)
    assert len(result) == 1
    assert result[0]["agent_id"] == "reviewer"
    # Verify query params
    request = respx_mock.calls[0].request
    assert "q=bug" in str(request.url)
    assert "agent_id=reviewer" in str(request.url)
    assert "limit=10" in str(request.url)
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_delete_vault_file(respx_mock):
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
    client = DjinnBotClient()
    result = client.delete_vault_file("reviewer", "session-log.md")
    assert result["deleted"] is True
    client.close()


# ── Error handling ──────────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_404_raises(respx_mock):
    respx_mock.get("/v1/agents/nonexistent").mock(
        return_value=httpx.Response(404, json={"detail": "Not found"})
    )
    client = DjinnBotClient()
    with pytest.raises(httpx.HTTPStatusError) as exc_info:
        client.get_agent("nonexistent")
    assert exc_info.value.response.status_code == 404
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_500_raises(respx_mock):
    respx_mock.get("/v1/status").mock(
        return_value=httpx.Response(500, json={"detail": "Internal error"})
    )
    client = DjinnBotClient()
    with pytest.raises(httpx.HTTPStatusError):
        client.get_status()
    client.close()


# ── Client lifecycle ────────────────────────────────────────────────


def test_client_base_url_trailing_slash():
    """Trailing slashes should be stripped."""
    client = DjinnBotClient(base_url="http://example.com:8000/")
    assert client.base_url == "http://example.com:8000"
    client.close()


def test_client_lazy_init():
    """Client should not create httpx.Client until first use."""
    client = DjinnBotClient()
    assert client._client is None
    client.close()
