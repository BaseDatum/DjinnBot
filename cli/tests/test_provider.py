"""Tests for provider management commands and client methods."""

import json
import httpx
import respx
from typer.testing import CliRunner

from djinnbot.client import DjinnBotClient
from djinnbot.main import app

runner = CliRunner()


# ── Sample data ─────────────────────────────────────────────────────

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
                "reasoning": True,
            },
        ],
        "maskedApiKey": "sk-ant-a...xyz",
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
        "models": [],  # Empty — live fetch needed
        "maskedApiKey": "sk-or-v1...abc",
        "extraFields": [],
        "isCustom": False,
    },
    {
        "providerId": "openai",
        "enabled": True,
        "configured": False,
        "name": "OpenAI",
        "description": "GPT models",
        "apiKeyEnvVar": "OPENAI_API_KEY",
        "docsUrl": "https://platform.openai.com/api-keys",
        "models": [],
        "maskedApiKey": None,
        "extraFields": [],
        "isCustom": False,
    },
]

SAMPLE_UPSERT_RESPONSE = {
    "providerId": "openai",
    "enabled": True,
    "configured": True,
    "maskedApiKey": "sk-proj-...789",
    "name": "OpenAI",
    "description": "GPT models",
    "apiKeyEnvVar": "OPENAI_API_KEY",
    "docsUrl": "https://platform.openai.com/api-keys",
    "models": [],
    "extraFields": [],
    "isCustom": False,
}

SAMPLE_LIVE_MODELS = {
    "models": [
        {
            "id": "openrouter/anthropic/claude-sonnet-4",
            "name": "Claude Sonnet 4",
            "reasoning": True,
        },
        {
            "id": "openrouter/google/gemini-2.5-pro",
            "name": "Gemini 2.5 Pro",
            "reasoning": True,
        },
    ],
    "source": "live",
}


# ── Client method tests ─────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_upsert_provider(respx_mock):
    respx_mock.put("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(200, json=SAMPLE_UPSERT_RESPONSE)
    )
    client = DjinnBotClient()
    result = client.upsert_provider("openai", api_key="sk-test-123")
    assert result["configured"] is True
    body = json.loads(respx_mock.calls[0].request.content)
    assert body["apiKey"] == "sk-test-123"
    assert body["enabled"] is True
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_upsert_provider_with_extra_config(respx_mock):
    respx_mock.put("/v1/settings/providers/azure-openai-responses").mock(
        return_value=httpx.Response(
            200, json={**SAMPLE_UPSERT_RESPONSE, "providerId": "azure-openai-responses"}
        )
    )
    client = DjinnBotClient()
    result = client.upsert_provider(
        "azure-openai-responses",
        api_key="my-key",
        extra_config={"AZURE_OPENAI_BASE_URL": "https://myresource.openai.azure.com"},
    )
    body = json.loads(respx_mock.calls[0].request.content)
    assert (
        body["extraConfig"]["AZURE_OPENAI_BASE_URL"]
        == "https://myresource.openai.azure.com"
    )
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_upsert_provider_disable(respx_mock):
    respx_mock.put("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(
            200, json={**SAMPLE_UPSERT_RESPONSE, "enabled": False}
        )
    )
    client = DjinnBotClient()
    result = client.upsert_provider("openai", enabled=False)
    body = json.loads(respx_mock.calls[0].request.content)
    assert body["enabled"] is False
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_delete_provider(respx_mock):
    respx_mock.delete("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(200, json={"status": "ok", "providerId": "openai"})
    )
    client = DjinnBotClient()
    result = client.delete_provider("openai")
    assert result["status"] == "ok"
    client.close()


@respx.mock(base_url="http://localhost:8000")
def test_get_available_models_fetches_live(respx_mock):
    """get_available_models calls get_provider_models for empty static lists."""
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    # OpenRouter is configured but has empty static models — should trigger live fetch
    respx_mock.get("/v1/settings/providers/openrouter/models").mock(
        return_value=httpx.Response(200, json=SAMPLE_LIVE_MODELS)
    )
    client = DjinnBotClient()
    models = client.get_available_models()
    # Should have 1 from anthropic (static) + 2 from openrouter (live)
    assert len(models) == 3
    provider_ids = {m["provider_id"] for m in models}
    assert "anthropic" in provider_ids
    assert "openrouter" in provider_ids
    assert "openai" not in provider_ids  # Not configured
    client.close()


# ── CLI command tests ───────────────────────────────────────────────


@respx.mock(base_url="http://localhost:8000")
def test_provider_list(respx_mock):
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    result = runner.invoke(app, ["provider", "list"])
    assert result.exit_code == 0
    assert "Anthropic" in result.output
    assert "OpenRouter" in result.output
    assert "OpenAI" in result.output
    assert "not configured" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_show(respx_mock):
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    respx_mock.get("/v1/settings/providers/anthropic/models").mock(
        return_value=httpx.Response(
            200,
            json={
                "models": [
                    {
                        "id": "anthropic/claude-sonnet-4",
                        "name": "Claude Sonnet 4",
                        "reasoning": True,
                    }
                ],
                "source": "static",
            },
        )
    )
    result = runner.invoke(app, ["provider", "show", "anthropic"])
    assert result.exit_code == 0
    assert "Anthropic" in result.output
    assert "claude-sonnet-4" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_show_not_found(respx_mock):
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    result = runner.invoke(app, ["provider", "show", "nonexistent"])
    assert result.exit_code == 1
    assert "not found" in result.output


@respx.mock(base_url="http://localhost:8000", assert_all_called=False)
def test_provider_set_key(respx_mock):
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    respx_mock.put("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(200, json=SAMPLE_UPSERT_RESPONSE)
    )
    result = runner.invoke(app, ["provider", "set-key", "openai", "sk-my-new-key-123"])
    assert result.exit_code == 0
    assert "API key set" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_set_key_prompt(respx_mock):
    """When key not given as argument, prompts for it."""
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    respx_mock.put("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(200, json=SAMPLE_UPSERT_RESPONSE)
    )
    result = runner.invoke(
        app, ["provider", "set-key", "openai"], input="sk-secret-key\n"
    )
    assert result.exit_code == 0
    assert "API key set" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_set_extra(respx_mock):
    respx_mock.put("/v1/settings/providers/azure-openai-responses").mock(
        return_value=httpx.Response(
            200, json={**SAMPLE_UPSERT_RESPONSE, "configured": True}
        )
    )
    result = runner.invoke(
        app,
        [
            "provider",
            "set-extra",
            "azure-openai-responses",
            "AZURE_OPENAI_BASE_URL",
            "https://myresource.openai.azure.com",
        ],
    )
    assert result.exit_code == 0
    assert "Set AZURE_OPENAI_BASE_URL" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_enable(respx_mock):
    respx_mock.put("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(200, json=SAMPLE_UPSERT_RESPONSE)
    )
    result = runner.invoke(app, ["provider", "enable", "openai"])
    assert result.exit_code == 0
    assert "enabled" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_disable(respx_mock):
    respx_mock.put("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(
            200, json={**SAMPLE_UPSERT_RESPONSE, "enabled": False}
        )
    )
    result = runner.invoke(app, ["provider", "disable", "openai"])
    assert result.exit_code == 0
    assert "disabled" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_remove(respx_mock):
    respx_mock.delete("/v1/settings/providers/openai").mock(
        return_value=httpx.Response(200, json={"status": "ok", "providerId": "openai"})
    )
    result = runner.invoke(app, ["provider", "remove", "openai"], input="y\n")
    assert result.exit_code == 0
    assert "removed" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_remove_cancelled(respx_mock):
    result = runner.invoke(app, ["provider", "remove", "openai"], input="n\n")
    assert result.exit_code == 0
    assert "Cancelled" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_models_single(respx_mock):
    respx_mock.get("/v1/settings/providers/anthropic/models").mock(
        return_value=httpx.Response(
            200,
            json={
                "models": [
                    {
                        "id": "anthropic/claude-sonnet-4",
                        "name": "Claude Sonnet 4",
                        "reasoning": True,
                    }
                ],
                "source": "static",
            },
        )
    )
    result = runner.invoke(app, ["provider", "models", "anthropic"])
    assert result.exit_code == 0
    assert "claude-sonnet-4" in result.output


@respx.mock(base_url="http://localhost:8000")
def test_provider_models_all(respx_mock):
    respx_mock.get("/v1/settings/providers").mock(
        return_value=httpx.Response(200, json=SAMPLE_PROVIDERS)
    )
    respx_mock.get("/v1/settings/providers/openrouter/models").mock(
        return_value=httpx.Response(200, json=SAMPLE_LIVE_MODELS)
    )
    result = runner.invoke(app, ["provider", "models"])
    assert result.exit_code == 0
    assert "claude-sonnet-4" in result.output
    assert "Anthropic" in result.output or "OpenRouter" in result.output
