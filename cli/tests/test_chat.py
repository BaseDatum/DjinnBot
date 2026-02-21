"""Tests for chat client methods and the chat command wiring."""

import httpx
import respx
from typer.testing import CliRunner

from djinnbot.client import DjinnBotClient
from djinnbot.main import app
from tests.conftest import (
    SAMPLE_AGENTS,
    SAMPLE_AGENT,
    SAMPLE_CHAT_START,
    SAMPLE_CHAT_STATUS_STARTING,
    SAMPLE_CHAT_STATUS_RUNNING,
    SAMPLE_CHAT_MESSAGE_SENT,
    SAMPLE_CHAT_STOP_RESPONSE,
    SAMPLE_CHAT_END,
    SAMPLE_CHAT_SESSIONS,
)

runner = CliRunner()


# ── Sample provider data matching /v1/settings/providers ────────────

SAMPLE_PROVIDERS = [
    {
        "providerId": "anthropic",
        "enabled": True,
        "configured": True,
        "name": "Anthropic",
        "description": "Claude models",
        "apiKeyEnvVar": "ANTHROPIC_API_KEY",
        "docsUrl": "https://console.anthropic.com/keys",
        "models": [
            {
                "id": "anthropic/claude-sonnet-4",
                "name": "Claude Sonnet 4",
                "reasoning": False,
            },
            {
                "id": "anthropic/claude-opus-4",
                "name": "Claude Opus 4",
                "reasoning": True,
            },
        ],
        "maskedApiKey": "sk-a...xyz",
        "extraFields": [],
        "isCustom": False,
    },
    {
        "providerId": "openai",
        "enabled": True,
        "configured": False,  # No API key
        "name": "OpenAI",
        "description": "GPT models",
        "apiKeyEnvVar": "OPENAI_API_KEY",
        "docsUrl": "https://platform.openai.com/api-keys",
        "models": [],
        "maskedApiKey": None,
        "extraFields": [],
        "isCustom": False,
    },
    {
        "providerId": "openrouter",
        "enabled": True,
        "configured": True,
        "name": "OpenRouter",
        "description": "Multi-provider routing",
        "apiKeyEnvVar": "OPENROUTER_API_KEY",
        "docsUrl": "https://openrouter.ai/keys",
        "models": [
            {
                "id": "openrouter/google/gemini-2.5-pro",
                "name": "Gemini 2.5 Pro",
                "reasoning": True,
            },
        ],
        "maskedApiKey": "sk-o...abc",
        "extraFields": [],
        "isCustom": False,
    },
]


# ── Client method tests ─────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_start_chat(respx_mock):
    respx_mock.post("/v1/agents/reviewer/chat/start").mock(
        return_value=httpx.Response(200, json=SAMPLE_CHAT_START)
    )
    client = DjinnBotClient()
    result = client.start_chat("reviewer", model="anthropic/claude-sonnet-4")
    assert result["sessionId"] == "chat_reviewer_1700000000000"
    assert result["status"] == "starting"
    import json

    body = json.loads(respx_mock.calls[0].request.content)
    assert body["model"] == "anthropic/claude-sonnet-4"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_start_chat_no_model(respx_mock):
    respx_mock.post("/v1/agents/reviewer/chat/start").mock(
        return_value=httpx.Response(200, json=SAMPLE_CHAT_START)
    )
    client = DjinnBotClient()
    result = client.start_chat("reviewer")
    assert result["sessionId"] == "chat_reviewer_1700000000000"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_send_chat_message(respx_mock):
    respx_mock.post(
        "/v1/agents/reviewer/chat/chat_reviewer_1700000000000/message"
    ).mock(return_value=httpx.Response(200, json=SAMPLE_CHAT_MESSAGE_SENT))
    client = DjinnBotClient()
    result = client.send_chat_message(
        "reviewer", "chat_reviewer_1700000000000", "Hello!"
    )
    assert result["status"] == "queued"
    assert result["userMessageId"] == "msg_user_123"
    assert result["assistantMessageId"] == "msg_asst_456"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_send_chat_message_with_model(respx_mock):
    respx_mock.post(
        "/v1/agents/reviewer/chat/chat_reviewer_1700000000000/message"
    ).mock(return_value=httpx.Response(200, json=SAMPLE_CHAT_MESSAGE_SENT))
    client = DjinnBotClient()
    result = client.send_chat_message(
        "reviewer",
        "chat_reviewer_1700000000000",
        "Hello!",
        model="anthropic/claude-opus-4",
    )
    assert result["status"] == "queued"
    import json

    body = json.loads(respx_mock.calls[0].request.content)
    assert body["model"] == "anthropic/claude-opus-4"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_stop_chat_response(respx_mock):
    respx_mock.post("/v1/agents/reviewer/chat/chat_reviewer_1700000000000/stop").mock(
        return_value=httpx.Response(200, json=SAMPLE_CHAT_STOP_RESPONSE)
    )
    client = DjinnBotClient()
    result = client.stop_chat_response("reviewer", "chat_reviewer_1700000000000")
    assert result["status"] == "stopped"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_end_chat(respx_mock):
    respx_mock.post("/v1/agents/reviewer/chat/chat_reviewer_1700000000000/end").mock(
        return_value=httpx.Response(200, json=SAMPLE_CHAT_END)
    )
    client = DjinnBotClient()
    result = client.end_chat("reviewer", "chat_reviewer_1700000000000")
    assert result["status"] == "ended"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_chat_status(respx_mock):
    respx_mock.get("/v1/agents/reviewer/chat/chat_reviewer_1700000000000/status").mock(
        return_value=httpx.Response(200, json=SAMPLE_CHAT_STATUS_RUNNING)
    )
    client = DjinnBotClient()
    result = client.get_chat_status("reviewer", "chat_reviewer_1700000000000")
    assert result["status"] == "running"
    assert result["messageCount"] == 2
    assert result["model"] == "anthropic/claude-sonnet-4"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_list_chat_sessions(respx_mock):
    respx_mock.get("/v1/agents/reviewer/chat/sessions").mock(
        return_value=httpx.Response(200, json=SAMPLE_CHAT_SESSIONS)
    )
    client = DjinnBotClient()
    result = client.list_chat_sessions("reviewer")
    assert result["total"] == 1
    assert len(result["sessions"]) == 1
    assert result["sessions"][0]["status"] == "running"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_list_chat_sessions_with_filter(respx_mock):
    respx_mock.get("/v1/agents/reviewer/chat/sessions").mock(
        return_value=httpx.Response(200, json=SAMPLE_CHAT_SESSIONS)
    )
    client = DjinnBotClient()
    result = client.list_chat_sessions("reviewer", status="running", limit=5)
    request = respx_mock.calls[0].request
    assert "status=running" in str(request.url)
    assert "limit=5" in str(request.url)
    client.close()


# ── Provider / model client tests ───────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_list_providers(respx_mock):
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    client = DjinnBotClient()
    result = client.list_providers()
    assert len(result) == 3
    assert result[0]["providerId"] == "anthropic"
    assert result[0]["configured"] is True
    assert result[1]["configured"] is False  # OpenAI has no key
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_provider_models(respx_mock):
    respx_mock.get("/v1/settings/providers/anthropic/models").mock(
        return_value=httpx.Response(
            200,
            json={
                "models": [
                    {
                        "id": "anthropic/claude-sonnet-4",
                        "name": "Claude Sonnet 4",
                        "reasoning": False,
                    },
                ],
                "source": "static",
            },
        )
    )
    client = DjinnBotClient()
    result = client.get_provider_models("anthropic")
    assert len(result["models"]) == 1
    assert result["source"] == "static"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_available_models(respx_mock):
    """get_available_models only returns models from configured+enabled providers."""
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    client = DjinnBotClient()
    models = client.get_available_models()
    # Should include Anthropic (configured=True) and OpenRouter (configured=True)
    # but NOT OpenAI (configured=False)
    provider_ids = {m["provider_id"] for m in models}
    assert "anthropic" in provider_ids
    assert "openrouter" in provider_ids
    assert "openai" not in provider_ids
    # Should have 3 total models (2 from anthropic + 1 from openrouter)
    assert len(models) == 3
    # Each model should have expected fields
    for m in models:
        assert "id" in m
        assert "name" in m
        assert "provider" in m
        assert "reasoning" in m
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_available_models_none_configured(respx_mock):
    """Returns empty list when no providers are configured."""
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(
            200,
            json=[
                {**SAMPLE_PROVIDERS[0], "configured": False, "enabled": True},
            ],
        )
    )
    client = DjinnBotClient()
    models = client.get_available_models()
    assert models == []
    client.close()


# ── Chat command wiring tests ───────────────────────────────────────
# These mock the Textual pickers (pick_agent/pick_model) since they
# can't run inside the CLI test runner.


@respx.mock(base_url="http://localhost:8000")
def test_chat_command_help(respx_mock):
    result = runner.invoke(app, ["chat", "--help"])
    assert result.exit_code == 0
    assert "--agent" in result.output
    assert "--model" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_chat_with_flags(respx_mock, mocker):
    """When --agent and --model are both given, skip pickers entirely."""
    respx_mock.get("/v1/agents/reviewer").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT)
    )
    mock_run = mocker.patch("djinnbot.chat.run_chat")

    result = runner.invoke(
        app, ["chat", "--agent", "reviewer", "--model", "anthropic/claude-opus-4"]
    )
    assert result.exit_code == 0

    mock_run.assert_called_once()
    call_kwargs = mock_run.call_args
    assert call_kwargs.kwargs["agent_id"] == "reviewer"
    assert call_kwargs.kwargs["model"] == "anthropic/claude-opus-4"


@respx.mock(base_url="http://localhost:8000")
def test_chat_picker_agent_then_model(respx_mock, mocker):
    """When neither flag given, pick_agent and pick_model are called."""
    respx_mock.get("/v1/agents/").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS)
    )
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    respx_mock.get("/v1/agents/reviewer").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT)
    )

    mock_pick_agent = mocker.patch(
        "djinnbot.picker.pick_agent", return_value="reviewer"
    )
    mock_pick_model = mocker.patch(
        "djinnbot.picker.pick_model", return_value="anthropic/claude-sonnet-4"
    )
    mock_run = mocker.patch("djinnbot.chat.run_chat")

    result = runner.invoke(app, ["chat"])
    assert result.exit_code == 0

    mock_pick_agent.assert_called_once_with(SAMPLE_AGENTS)
    mock_pick_model.assert_called_once()
    # Verify models passed to picker only contain configured providers
    models_arg = mock_pick_model.call_args[0][0]
    provider_ids = {m["provider_id"] for m in models_arg}
    assert "openai" not in provider_ids  # OpenAI not configured

    mock_run.assert_called_once()
    assert mock_run.call_args.kwargs["agent_id"] == "reviewer"
    assert mock_run.call_args.kwargs["model"] == "anthropic/claude-sonnet-4"


@respx.mock(base_url="http://localhost:8000")
def test_chat_agent_flag_model_picker(respx_mock, mocker):
    """When --agent given but not --model, only model picker is shown."""
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    respx_mock.get("/v1/agents/reviewer").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENT)
    )

    mock_pick_agent = mocker.patch("djinnbot.picker.pick_agent")
    mock_pick_model = mocker.patch(
        "djinnbot.picker.pick_model", return_value="anthropic/claude-opus-4"
    )
    mock_run = mocker.patch("djinnbot.chat.run_chat")

    result = runner.invoke(app, ["chat", "--agent", "reviewer"])
    assert result.exit_code == 0

    mock_pick_agent.assert_not_called()
    mock_pick_model.assert_called_once()
    mock_run.assert_called_once()
    assert mock_run.call_args.kwargs["model"] == "anthropic/claude-opus-4"


@respx.mock(base_url="http://localhost:8000")
def test_chat_cancelled_agent_picker(respx_mock, mocker):
    """Cancelling agent picker exits cleanly."""
    respx_mock.get("/v1/agents/").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS)
    )
    mocker.patch("djinnbot.picker.pick_agent", return_value=None)

    result = runner.invoke(app, ["chat"])
    assert result.exit_code == 0
    assert "Cancelled" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_chat_cancelled_model_picker(respx_mock, mocker):
    """Cancelling model picker exits cleanly."""
    respx_mock.get("/v1/agents/").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS)
    )
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    mocker.patch("djinnbot.picker.pick_agent", return_value="reviewer")
    mocker.patch("djinnbot.picker.pick_model", return_value=None)

    result = runner.invoke(app, ["chat"])
    assert result.exit_code == 0
    assert "Cancelled" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_chat_no_agents_error(respx_mock):
    """Error if no agents available and --agent not given."""
    respx_mock.get("/v1/agents/").mock(return_value=httpx.Response(200, json=[]))
    result = runner.invoke(app, ["chat"])
    assert result.exit_code == 1
    assert "No agents found" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_chat_no_models_error(respx_mock, mocker):
    """Error if no models available (no configured providers)."""
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(
            200,
            json=[
                {**SAMPLE_PROVIDERS[1]},  # OpenAI, not configured
            ],
        )
    )
    mocker.patch("djinnbot.picker.pick_agent", return_value="reviewer")

    respx_mock.get("/v1/agents/").mock(
        return_value=httpx.Response(200, json=SAMPLE_AGENTS)
    )

    result = runner.invoke(app, ["chat"])
    assert result.exit_code == 1
    assert "No models available" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_chat_server_error(respx_mock):
    """Error if server unreachable during agent listing."""
    respx_mock.get("/v1/agents/").mock(
        return_value=httpx.Response(500, json={"detail": "error"})
    )
    result = runner.invoke(app, ["chat"])
    assert result.exit_code == 1
    assert "Error" in result.output
