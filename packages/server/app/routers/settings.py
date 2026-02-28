"""Global settings API for DjinnBot."""

import json
import re
import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from typing import Optional, Dict, List
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select

from app.database import get_async_session
from app.models.settings import ModelProvider, GlobalSetting
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

# ─── Default values ──────────────────────────────────────────────────────────

DEFAULT_SETTINGS: Dict[str, str] = {
    "defaultWorkingModel": "openrouter/moonshotai/kimi-k2.5",
    "defaultPlanningModel": "",
    "defaultExecutorModel": "",
    "defaultThinkingModel": "openrouter/minimax/minimax-m2.5",
    "defaultSlackDecisionModel": "openrouter/minimax/minimax-m2.5",
    "defaultWorkingModelThinkingLevel": "off",
    "defaultThinkingModelThinkingLevel": "medium",
    "defaultSlackDecisionModelThinkingLevel": "off",
    "pulseIntervalMinutes": "30",
    "pulseEnabled": "true",
    "userSlackId": "",
    "agentRuntimeImage": "",
    "ptcEnabled": "false",
    # ── Container Resources ──────────────────────────────────────────────────
    "containerMemoryLimitMb": "2048",
    "containerCpuLimit": "2",
    "containerShmSizeMb": "256",
    "jfsAgentCacheSizeMb": "2048",
    "containerReadyTimeoutSec": "30",
    # ── Pipeline Execution ───────────────────────────────────────────────────
    "defaultStepTimeoutSec": "300",
    # ── Chat Session Reaper ──────────────────────────────────────────────────
    "chatIdleTimeoutMin": "30",
    "reaperIntervalSec": "60",
    # ── Wake System Guardrails ───────────────────────────────────────────────
    "wakeEnabled": "true",
    "wakeCooldownSec": "300",
    "maxWakesPerDay": "12",
    "maxWakesPerPairPerDay": "5",
    # ── Pulse Execution ──────────────────────────────────────────────────────
    "maxConcurrentPulseSessions": "2",
    "defaultPulseTimeoutSec": "120",
}

# ─── Models known to support extended thinking/reasoning ─────────────────────
# Source: @mariozechner/pi-ai models.generated — reasoning: true
# Bare model IDs (without provider prefix) that support thinking levels.
REASONING_MODEL_IDS: set = {
    # Anthropic
    "claude-3-7-sonnet-20250219",
    "claude-3-7-sonnet-latest",
    "claude-haiku-4-5",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-0",
    "claude-opus-4-1",
    "claude-opus-4-1-20250805",
    "claude-opus-4-20250514",
    "claude-opus-4-5",
    "claude-opus-4-5-20251101",
    "claude-opus-4-6",
    "claude-sonnet-4-0",
    "claude-sonnet-4-20250514",
    "claude-sonnet-4-5",
    "claude-sonnet-4-5-20250929",
    "claude-sonnet-4-6",
    # OpenCode
    "big-pickle",
    "claude-haiku-4-5",
    "claude-opus-4-1",
    "claude-opus-4-5",
    "claude-opus-4-6",
    "claude-sonnet-4",
    "claude-sonnet-4-5",
    "claude-sonnet-4-6",
    "gemini-3-flash",
    "gemini-3-pro",
    "glm-4.6",
    "glm-4.7",
    "kimi-k2-thinking",
    "kimi-k2.5",
    "kimi-k2.5-free",
    "minimax-m2.1",
    "minimax-m2.5-free",
    "gpt-5",
    "gpt-5-codex",
    "gpt-5-nano",
    "gpt-5.1",
    "gpt-5.1-codex",
    "gpt-5.1-codex-max",
    "gpt-5.1-codex-mini",
    "gpt-5.2",
    "gpt-5.2-codex",
    # xAI — Grok 3+ supports thinking
    "grok-3",
    "grok-3-fast",
    "grok-3-mini",
    "grok-3-mini-fast",
    "grok-4",
    "grok-4-fast",
    # Google
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    # OpenAI
    "o3",
    "o3-mini",
    "o4-mini",
    "o1",
    "o1-mini",
    # Groq — Llama 4 variants with reasoning
    "meta-llama/llama-4-scout-17b-16e-instruct",
    # ZAI / Zhipu GLM
    "glm-4.5",
    "glm-4.6",
    "glm-4.7",
}


def _model_supports_reasoning(model_id: str) -> bool:
    """Return True if model_id (with or without provider prefix) supports thinking levels.

    Normalises dots to dashes so openrouter-style IDs (e.g. claude-sonnet-4.6)
    match the canonical dash-form entries in REASONING_MODEL_IDS.
    """
    bare = model_id.split("/")[-1] if "/" in model_id else model_id
    normalised = bare.replace(".", "-")
    return bare in REASONING_MODEL_IDS or normalised in REASONING_MODEL_IDS


# ─── Static model catalog per provider ───────────────────────────────────────
# Source: @mariozechner/pi-ai models.generated + env-api-keys.js
#
# Each entry may have an optional "extraFields" list describing additional
# environment variables the provider needs beyond the primary API key.
# These are stored in model_providers.extra_config (JSON) and injected into
# containers alongside the main api_key.
#
# Excluded from UI catalog (infrastructure/ADC-only, not single-key configurable):
#   - amazon-bedrock: AWS profile / IAM keys / bearer token — set via env vars
#   - google-vertex:  Application Default Credentials via gcloud — set via env vars

PROVIDER_CATALOG: Dict[str, dict] = {
    "opencode": {
        "name": "OpenCode",
        "description": "OpenCode's own AI models — access via opencode.ai API",
        "apiKeyEnvVar": "OPENCODE_API_KEY",
        "docsUrl": "https://opencode.ai",
        "models": [],  # Fetched live from https://opencode.ai/zen/v1/models
    },
    "xai": {
        "name": "xAI",
        "description": "Elon Musk's xAI — Grok models with real-time information access",
        "apiKeyEnvVar": "XAI_API_KEY",
        "docsUrl": "https://x.ai/api",
        "models": [],  # Fetched live from https://api.x.ai/v1/models
    },
    "openrouter": {
        "name": "OpenRouter",
        "description": "Single API to access 200+ models from Anthropic, OpenAI, Google, and more",
        "apiKeyEnvVar": "OPENROUTER_API_KEY",
        "docsUrl": "https://openrouter.ai/keys",
        "models": [],  # Fetched live from https://openrouter.ai/api/v1/models
    },
    "anthropic": {
        "name": "Anthropic",
        "description": "Claude models — state-of-the-art reasoning and code generation",
        "apiKeyEnvVar": "ANTHROPIC_API_KEY",
        "docsUrl": "https://console.anthropic.com/keys",
        "models": [
            {
                "id": "anthropic/claude-sonnet-4-6",
                "name": "Claude Sonnet 4.6",
                "description": "Frontier Sonnet performance — coding, agents, professional work",
            },
            {
                "id": "anthropic/claude-opus-4-6",
                "name": "Claude Opus 4.6",
                "description": "Strongest model for coding and long-running tasks",
            },
            {
                "id": "anthropic/claude-sonnet-4-5",
                "name": "Claude Sonnet 4.5",
                "description": "Fast and capable",
            },
            {
                "id": "anthropic/claude-opus-4-5",
                "name": "Claude Opus 4.5",
                "description": "High capability reasoning",
            },
            {
                "id": "anthropic/claude-sonnet-4",
                "name": "Claude Sonnet 4",
                "description": "Balanced performance",
            },
            {
                "id": "anthropic/claude-opus-4",
                "name": "Claude Opus 4",
                "description": "Previous generation flagship",
            },
            {
                "id": "anthropic/claude-haiku-4-5",
                "name": "Claude Haiku 4.5",
                "description": "Fast and lightweight",
            },
        ],
    },
    "openai": {
        "name": "OpenAI",
        "description": "GPT models — industry-standard language models from OpenAI",
        "apiKeyEnvVar": "OPENAI_API_KEY",
        "docsUrl": "https://platform.openai.com/api-keys",
        "models": [],  # Fetched live from https://api.openai.com/v1/models
    },
    "google": {
        "name": "Google AI",
        "description": "Gemini models — Google's multimodal AI with massive context windows",
        "apiKeyEnvVar": "GEMINI_API_KEY",
        "docsUrl": "https://aistudio.google.com/apikey",
        "models": [
            {
                "id": "google/gemini-2.5-pro",
                "name": "Gemini 2.5 Pro",
                "description": "Most capable Gemini model",
            },
            {
                "id": "google/gemini-2.5-flash",
                "name": "Gemini 2.5 Flash",
                "description": "Fast and efficient",
            },
            {
                "id": "google/gemini-2.0-flash",
                "name": "Gemini 2.0 Flash",
                "description": "Previous gen fast model",
            },
        ],
    },
    "groq": {
        "name": "Groq",
        "description": "Ultra-fast inference on open-source models via Groq's LPU hardware",
        "apiKeyEnvVar": "GROQ_API_KEY",
        "docsUrl": "https://console.groq.com/keys",
        "models": [],  # Fetched live from https://api.groq.com/openai/v1/models
    },
    "zai": {
        "name": "ZAI (Zhipu AI)",
        "description": "GLM models from Zhipu AI — powerful Chinese and multilingual models",
        "apiKeyEnvVar": "ZAI_API_KEY",
        "docsUrl": "https://bigmodel.cn",
        "models": [
            {"id": "zai/glm-4.7", "name": "GLM-4.7", "description": "Latest GLM model"},
            {
                "id": "zai/glm-4.7-flash",
                "name": "GLM-4.7 Flash",
                "description": "Fast GLM-4.7",
            },
            {"id": "zai/glm-4.6", "name": "GLM-4.6", "description": "GLM-4.6 series"},
            {"id": "zai/glm-4.5", "name": "GLM-4.5", "description": "GLM-4.5 series"},
            {"id": "zai/glm-5", "name": "GLM-5", "description": "GLM-5 flagship model"},
        ],
    },
    "mistral": {
        "name": "Mistral AI",
        "description": "Efficient European AI models — great for code and multilingual tasks",
        "apiKeyEnvVar": "MISTRAL_API_KEY",
        "docsUrl": "https://console.mistral.ai/api-keys",
        "models": [],  # Fetched live from https://api.mistral.ai/v1/models
    },
    "cerebras": {
        "name": "Cerebras",
        "description": "Extremely fast inference on Llama models via Cerebras wafer-scale chips",
        "apiKeyEnvVar": "CEREBRAS_API_KEY",
        "docsUrl": "https://cloud.cerebras.ai",
        "models": [],  # Fetched live from https://api.cerebras.ai/v1/models
    },
    "minimax": {
        "name": "MiniMax",
        "description": "MiniMax models — powerful reasoning and multimodal AI",
        "apiKeyEnvVar": "MINIMAX_API_KEY",
        "docsUrl": "https://www.minimax.io",
        "models": [
            {
                "id": "minimax/MiniMax-M2",
                "name": "MiniMax M2",
                "description": "MiniMax M2 flagship",
            },
            {
                "id": "minimax/MiniMax-M2.1",
                "name": "MiniMax M2.1",
                "description": "MiniMax M2.1",
            },
        ],
    },
    "kimi-coding": {
        "name": "Kimi for Coding",
        "description": "Moonshot AI's Kimi K2 — specialized for coding tasks",
        "apiKeyEnvVar": "KIMI_API_KEY",
        "docsUrl": "https://platform.moonshot.cn",
        "models": [
            {
                "id": "kimi-coding/kimi-k2",
                "name": "Kimi K2",
                "description": "Kimi K2 coding model",
            },
            {
                "id": "kimi-coding/kimi-k2-thinking",
                "name": "Kimi K2 Thinking",
                "description": "Kimi K2 with extended reasoning",
            },
        ],
    },
    "huggingface": {
        "name": "Hugging Face",
        "description": "Open-source models via Hugging Face Inference Providers API",
        "apiKeyEnvVar": "HF_TOKEN",
        "docsUrl": "https://huggingface.co/settings/tokens",
        "models": [],  # Fetched live from https://router.huggingface.co/v1/models
    },
    "azure-openai-responses": {
        "name": "Azure OpenAI",
        "description": "OpenAI models hosted on Azure — enterprise-grade with SLA and data residency",
        "apiKeyEnvVar": "AZURE_OPENAI_API_KEY",
        "docsUrl": "https://portal.azure.com",
        # Extra required fields beyond the primary API key.
        # The user must provide one of: base URL or resource name.
        "extraFields": [
            {
                "envVar": "AZURE_OPENAI_BASE_URL",
                "label": "Base URL",
                "placeholder": "https://YOUR-RESOURCE.openai.azure.com",
                "description": "Your Azure OpenAI resource endpoint URL",
                "required": False,
            },
            {
                "envVar": "AZURE_OPENAI_RESOURCE_NAME",
                "label": "Resource Name",
                "placeholder": "your-resource-name",
                "description": "Azure resource name (alternative to Base URL)",
                "required": False,
            },
        ],
        # Azure model availability depends on the user's deployment — static list only.
        "models": [
            {
                "id": "azure-openai-responses/gpt-4o",
                "name": "GPT-4o (Azure)",
                "description": "GPT-4o on Azure",
            },
            {
                "id": "azure-openai-responses/gpt-4",
                "name": "GPT-4 (Azure)",
                "description": "GPT-4 on Azure",
            },
            {
                "id": "azure-openai-responses/codex-mini-latest",
                "name": "Codex Mini (Azure)",
                "description": "Codex Mini via Azure",
            },
        ],
    },
    "minimax-cn": {
        "name": "MiniMax (China)",
        "description": "MiniMax models via China domestic endpoint (api.minimaxi.com)",
        "apiKeyEnvVar": "MINIMAX_CN_API_KEY",
        "docsUrl": "https://www.minimaxi.com",
        "models": [
            {
                "id": "minimax-cn/MiniMax-M2",
                "name": "MiniMax M2 (CN)",
                "description": "MiniMax M2 via China endpoint",
            },
        ],
    },
    "qmdr": {
        "name": "Memory Search (QMDR)",
        "description": "Vector embedding and reranking provider for agent memory search (ClawVault semantic recall). Uses an OpenAI-compatible embeddings API — OpenRouter is recommended.",
        "apiKeyEnvVar": "QMD_OPENAI_API_KEY",
        "docsUrl": "https://openrouter.ai/keys",
        "extraFields": [
            {
                "envVar": "QMD_OPENAI_BASE_URL",
                "label": "Embeddings Base URL",
                "placeholder": "https://openrouter.ai/api/v1",
                "description": "OpenAI-compatible API base URL for embeddings and reranking. Defaults to OpenRouter.",
                "required": False,
            },
            {
                "envVar": "QMD_EMBED_PROVIDER",
                "label": "Embed Provider",
                "placeholder": "openai",
                "description": "Embedding backend: 'openai' (OpenAI-compatible, default) or 'siliconflow'.",
                "required": False,
            },
            {
                "envVar": "QMD_OPENAI_EMBED_MODEL",
                "label": "Embed Model",
                "placeholder": "openai/text-embedding-3-small",
                "description": "Model ID for generating vector embeddings.",
                "required": False,
            },
            {
                "envVar": "QMD_RERANK_PROVIDER",
                "label": "Rerank Provider",
                "placeholder": "openai",
                "description": "Reranking backend: 'openai' (OpenAI-compatible, default), 'gemini', or 'siliconflow'.",
                "required": False,
            },
            {
                "envVar": "QMD_RERANK_MODE",
                "label": "Rerank Mode",
                "placeholder": "llm",
                "description": "'llm' uses a chat model for reranking (default). 'rerank' uses a dedicated rerank API.",
                "required": False,
            },
            {
                "envVar": "QMD_OPENAI_MODEL",
                "label": "Rerank / Query Expansion Model",
                "placeholder": "openai/gpt-4o-mini",
                "description": "Chat model used for reranking and query expansion.",
                "required": False,
            },
        ],
        "models": [],
    },
}

# ─── Custom provider helpers ──────────────────────────────────────────────────

# Prefix used in provider_id for all user-created custom providers.
CUSTOM_PROVIDER_PREFIX = "custom-"

# Regex for valid custom provider slugs: lowercase letters, digits, hyphens, 2-32 chars.
_CUSTOM_ID_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,31}$")


def _is_custom_provider(provider_id: str) -> bool:
    return provider_id.startswith(CUSTOM_PROVIDER_PREFIX)


def _validate_custom_slug(slug: str) -> None:
    """Raise HTTPException(422) if the slug portion of a custom provider id is invalid."""
    if not _CUSTOM_ID_RE.match(slug):
        raise HTTPException(
            status_code=422,
            detail=(
                f"Invalid custom provider slug '{slug}'. "
                "Use 2-32 lowercase letters, digits, or hyphens, starting with a letter or digit."
            ),
        )


def _custom_env_prefix(provider_id: str) -> str:
    """Return the env-var prefix for a custom provider, e.g. 'custom-ollama' → 'CUSTOM_OLLAMA'."""
    slug = provider_id[len(CUSTOM_PROVIDER_PREFIX) :]
    return f"CUSTOM_{slug.upper().replace('-', '_')}"


def _custom_api_key_env(provider_id: str) -> str:
    return f"{_custom_env_prefix(provider_id)}_API_KEY"


def _custom_base_url_env(provider_id: str) -> str:
    return f"{_custom_env_prefix(provider_id)}_BASE_URL"


def _build_custom_catalog_entry(provider_id: str, row: "ModelProvider") -> dict:
    """Reconstruct the PROVIDER_CATALOG-style dict for a custom provider from its DB row."""
    extra = _resolve_extra_config(row)
    display_name = extra.get("DISPLAY_NAME") or provider_id
    base_url = extra.get(_custom_base_url_env(provider_id), "")
    return {
        "name": display_name,
        "description": f"Custom OpenAI-compatible provider — {base_url or 'base URL not set'}",
        "apiKeyEnvVar": _custom_api_key_env(provider_id),
        "docsUrl": base_url or "",
        "extraFields": [
            {
                "envVar": _custom_base_url_env(provider_id),
                "label": "Base URL",
                "placeholder": "http://localhost:11434/v1",
                "description": "OpenAI-compatible API endpoint (e.g. Ollama, LM Studio, vLLM)",
                "required": True,
            },
        ],
        "models": [],
        "isCustom": True,
    }


# ─── Pydantic schemas ─────────────────────────────────────────────────────────


class GlobalSettings(BaseModel):
    defaultWorkingModel: str = "openrouter/moonshotai/kimi-k2.5"
    defaultPlanningModel: str = ""
    defaultExecutorModel: str = ""
    defaultThinkingModel: str = "openrouter/minimax/minimax-m2.5"
    defaultSlackDecisionModel: str = "openrouter/minimax/minimax-m2.5"
    defaultWorkingModelThinkingLevel: str = "off"
    defaultThinkingModelThinkingLevel: str = "medium"
    defaultSlackDecisionModelThinkingLevel: str = "off"
    pulseIntervalMinutes: int = 30
    pulseEnabled: bool = True
    userSlackId: str = ""
    agentRuntimeImage: str = ""
    ptcEnabled: bool = False
    # ── Container Resources ──────────────────────────────────────────────────
    containerMemoryLimitMb: int = 2048
    containerCpuLimit: float = 2.0
    containerShmSizeMb: int = 256
    jfsAgentCacheSizeMb: int = 2048
    containerReadyTimeoutSec: int = 30
    # ── Pipeline Execution ───────────────────────────────────────────────────
    defaultStepTimeoutSec: int = 300
    # ── Chat Session Reaper ──────────────────────────────────────────────────
    chatIdleTimeoutMin: int = 30
    reaperIntervalSec: int = 60
    # ── Wake System Guardrails ───────────────────────────────────────────────
    wakeEnabled: bool = True
    wakeCooldownSec: int = 300
    maxWakesPerDay: int = 12
    maxWakesPerPairPerDay: int = 5
    # ── Pulse Execution ──────────────────────────────────────────────────────
    maxConcurrentPulseSessions: int = 2
    defaultPulseTimeoutSec: int = 120


class ExtraFieldSpec(BaseModel):
    """Metadata for a supplemental env var this provider requires."""

    envVar: str
    label: str
    placeholder: str
    description: str
    required: bool = False


class CreateCustomProviderRequest(BaseModel):
    """Body for POST /settings/providers — creates a brand-new custom provider."""

    # Human-readable label shown in the UI.
    name: str
    # Slug used to build the provider_id: "custom-{slug}".
    # Must be 2-32 lowercase letters/digits/hyphens.
    slug: str
    # OpenAI-compatible base URL (required).
    baseUrl: str
    # Optional API key (many local providers need none).
    apiKey: Optional[str] = None


class ModelProviderConfig(BaseModel):
    providerId: str
    enabled: bool = True
    apiKey: Optional[str] = None
    # Extra env vars beyond the primary API key, keyed by env var name.
    # e.g. {"AZURE_OPENAI_BASE_URL": "https://myresource.openai.azure.com"}
    extraConfig: Optional[Dict[str, str]] = None


class ModelProviderResponse(BaseModel):
    providerId: str
    enabled: bool
    configured: bool
    maskedApiKey: Optional[str] = None
    # Masked values of configured extra fields, keyed by env var name.
    maskedExtraConfig: Optional[Dict[str, str]] = None
    # Plain (unmasked) values of configured extra fields — non-secret config.
    plainExtraConfig: Optional[Dict[str, str]] = None
    name: str
    description: str
    apiKeyEnvVar: str
    docsUrl: str
    models: List[Dict]
    # Declared extra fields for this provider (empty list for single-key providers).
    extraFields: List[ExtraFieldSpec] = []
    # True for user-created custom providers (as opposed to built-in catalog entries).
    isCustom: bool = False


def _mask_api_key(key: str) -> str:
    """Return a masked representation: first 8 chars + '...' + last 4 chars."""
    if not key or len(key) < 8:
        return "***"
    return f"{key[:8]}...{key[-4:]}"


def _resolve_api_key(provider_id: str, db_row) -> Optional[str]:
    """
    Return the effective API key for a provider from the DB row.
    The engine syncs env-var keys into the DB at startup, so the DB is
    always the authoritative source for the API server.
    """
    return db_row.api_key if db_row else None


def _resolve_extra_config(db_row) -> Dict[str, str]:
    """Return the extra config dict from the DB row (empty dict if unset)."""
    if not db_row or not db_row.extra_config:
        return {}
    try:
        return json.loads(db_row.extra_config)
    except (json.JSONDecodeError, TypeError):
        return {}


def _annotate_models(models: List[Dict]) -> List[Dict]:
    """Add reasoning boolean to each model dict based on known reasoning model IDs."""
    return [
        {**m, "reasoning": _model_supports_reasoning(m.get("id", ""))} for m in models
    ]


def _is_provider_fully_configured(
    provider_id: str, api_key: Optional[str], extra_config: Dict[str, str]
) -> bool:
    """
    Return True if the provider has all required credentials configured.

    For single-key providers (most): just needs api_key.
    For multi-field providers (azure): also needs at least one of the extra fields
    that together satisfy the provider's minimum requirements.
    Custom providers: configured when base URL is present (API key is optional).
    """
    # Custom providers: configured when the base URL is set (API key is optional)
    if _is_custom_provider(provider_id):
        base_url_env = _custom_base_url_env(provider_id)
        return bool(extra_config.get(base_url_env))

    if not api_key:
        return False

    catalog = PROVIDER_CATALOG.get(provider_id, {})
    extra_fields: List[dict] = catalog.get("extraFields", [])
    if not extra_fields:
        return True  # No extra fields needed

    # Azure OpenAI: requires api_key PLUS either base URL or resource name
    if provider_id == "azure-openai-responses":
        has_base_url = bool(extra_config.get("AZURE_OPENAI_BASE_URL"))
        has_resource = bool(extra_config.get("AZURE_OPENAI_RESOURCE_NAME"))
        return has_base_url or has_resource

    # Generic: all required extra fields must be present
    required_vars = [f["envVar"] for f in extra_fields if f.get("required")]
    return all(extra_config.get(var) for var in required_vars)


def _build_provider_response(
    provider_id: str,
    row: Optional[ModelProvider],
    catalog: Optional[dict] = None,
) -> ModelProviderResponse:
    if catalog is None:
        catalog = PROVIDER_CATALOG[provider_id]
    is_custom = bool(catalog.get("isCustom", False))
    api_key = _resolve_api_key(provider_id, row)
    extra_config = _resolve_extra_config(row)
    enabled = row.enabled if row else False
    configured = _is_provider_fully_configured(provider_id, api_key, extra_config)

    # For custom providers an API key is optional (many local servers need none).
    # Treat them as configured as long as the base URL is present.
    if is_custom and not configured:
        base_url_env = _custom_base_url_env(provider_id)
        configured = bool(extra_config.get(base_url_env))

    # Build masked and plain extra config for display (only include keys that have values)
    masked_extra: Optional[Dict[str, str]] = None
    plain_extra: Optional[Dict[str, str]] = None
    if extra_config:
        # Exclude DISPLAY_NAME from masked display — it's not a secret
        displayable = {
            k: v for k, v in extra_config.items() if v and k != "DISPLAY_NAME"
        }
        if displayable:
            masked_extra = {k: _mask_api_key(v) for k, v in displayable.items()}
            plain_extra = {k: v for k, v in displayable.items()}

    extra_field_specs = [ExtraFieldSpec(**f) for f in catalog.get("extraFields", [])]

    return ModelProviderResponse(
        providerId=provider_id,
        enabled=enabled,
        configured=configured,
        maskedApiKey=_mask_api_key(api_key) if api_key else None,
        maskedExtraConfig=masked_extra if masked_extra else None,
        plainExtraConfig=plain_extra if plain_extra else None,
        name=catalog["name"],
        description=catalog["description"],
        apiKeyEnvVar=catalog["apiKeyEnvVar"],
        docsUrl=catalog["docsUrl"],
        models=_annotate_models(catalog["models"]),
        extraFields=extra_field_specs,
        isCustom=is_custom,
    )


# ─── Global settings endpoints ────────────────────────────────────────────────


@router.get("/")
async def get_settings(
    session: AsyncSession = Depends(get_async_session),
) -> GlobalSettings:
    """Get global settings from the database."""
    result = await session.execute(select(GlobalSetting))
    rows = {r.key: r.value for r in result.scalars().all()}

    def _get(key: str):
        return rows.get(key, DEFAULT_SETTINGS[key])

    return GlobalSettings(
        defaultWorkingModel=_get("defaultWorkingModel"),
        defaultPlanningModel=_get("defaultPlanningModel"),
        defaultExecutorModel=_get("defaultExecutorModel"),
        defaultThinkingModel=_get("defaultThinkingModel"),
        defaultSlackDecisionModel=_get("defaultSlackDecisionModel"),
        defaultWorkingModelThinkingLevel=_get("defaultWorkingModelThinkingLevel"),
        defaultThinkingModelThinkingLevel=_get("defaultThinkingModelThinkingLevel"),
        defaultSlackDecisionModelThinkingLevel=_get(
            "defaultSlackDecisionModelThinkingLevel"
        ),
        pulseIntervalMinutes=int(_get("pulseIntervalMinutes")),
        pulseEnabled=_get("pulseEnabled").lower() == "true",
        userSlackId=_get("userSlackId"),
        agentRuntimeImage=_get("agentRuntimeImage"),
        ptcEnabled=_get("ptcEnabled").lower() == "true",
        # ── Container Resources ──────────────────────────────────────────────
        containerMemoryLimitMb=int(_get("containerMemoryLimitMb")),
        containerCpuLimit=float(_get("containerCpuLimit")),
        containerShmSizeMb=int(_get("containerShmSizeMb")),
        jfsAgentCacheSizeMb=int(_get("jfsAgentCacheSizeMb")),
        containerReadyTimeoutSec=int(_get("containerReadyTimeoutSec")),
        # ── Pipeline Execution ───────────────────────────────────────────────
        defaultStepTimeoutSec=int(_get("defaultStepTimeoutSec")),
        # ── Chat Session Reaper ──────────────────────────────────────────────
        chatIdleTimeoutMin=int(_get("chatIdleTimeoutMin")),
        reaperIntervalSec=int(_get("reaperIntervalSec")),
        # ── Wake System Guardrails ───────────────────────────────────────────
        wakeEnabled=_get("wakeEnabled").lower() == "true",
        wakeCooldownSec=int(_get("wakeCooldownSec")),
        maxWakesPerDay=int(_get("maxWakesPerDay")),
        maxWakesPerPairPerDay=int(_get("maxWakesPerPairPerDay")),
        # ── Pulse Execution ──────────────────────────────────────────────────
        maxConcurrentPulseSessions=int(_get("maxConcurrentPulseSessions")),
        defaultPulseTimeoutSec=int(_get("defaultPulseTimeoutSec")),
    )


@router.put("/")
async def update_settings(
    settings: GlobalSettings,
    session: AsyncSession = Depends(get_async_session),
) -> GlobalSettings:
    """Persist global settings to the database."""
    now = now_ms()
    updates = {
        "defaultWorkingModel": settings.defaultWorkingModel,
        "defaultPlanningModel": settings.defaultPlanningModel,
        "defaultExecutorModel": settings.defaultExecutorModel,
        "defaultThinkingModel": settings.defaultThinkingModel,
        "defaultSlackDecisionModel": settings.defaultSlackDecisionModel,
        "pulseIntervalMinutes": str(settings.pulseIntervalMinutes),
        "pulseEnabled": str(settings.pulseEnabled).lower(),
        "userSlackId": settings.userSlackId,
        "agentRuntimeImage": settings.agentRuntimeImage,
        "ptcEnabled": str(settings.ptcEnabled).lower(),
        # ── Container Resources ──────────────────────────────────────────────
        "containerMemoryLimitMb": str(settings.containerMemoryLimitMb),
        "containerCpuLimit": str(settings.containerCpuLimit),
        "containerShmSizeMb": str(settings.containerShmSizeMb),
        "jfsAgentCacheSizeMb": str(settings.jfsAgentCacheSizeMb),
        "containerReadyTimeoutSec": str(settings.containerReadyTimeoutSec),
        # ── Pipeline Execution ───────────────────────────────────────────────
        "defaultStepTimeoutSec": str(settings.defaultStepTimeoutSec),
        # ── Chat Session Reaper ──────────────────────────────────────────────
        "chatIdleTimeoutMin": str(settings.chatIdleTimeoutMin),
        "reaperIntervalSec": str(settings.reaperIntervalSec),
        # ── Wake System Guardrails ───────────────────────────────────────────
        "wakeEnabled": str(settings.wakeEnabled).lower(),
        "wakeCooldownSec": str(settings.wakeCooldownSec),
        "maxWakesPerDay": str(settings.maxWakesPerDay),
        "maxWakesPerPairPerDay": str(settings.maxWakesPerPairPerDay),
        # ── Pulse Execution ──────────────────────────────────────────────────
        "maxConcurrentPulseSessions": str(settings.maxConcurrentPulseSessions),
        "defaultPulseTimeoutSec": str(settings.defaultPulseTimeoutSec),
    }
    for key, value in updates.items():
        row = await session.get(GlobalSetting, key)
        if row:
            row.value = value
            row.updated_at = now
        else:
            session.add(GlobalSetting(key=key, value=value, updated_at=now))
    await session.commit()
    return settings


@router.get("/favorites")
async def get_favorites(
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Get favorited models."""
    row = await session.get(GlobalSetting, "model_favorites")
    if not row:
        return {"favorites": []}
    try:
        return {"favorites": json.loads(row.value)}
    except Exception:
        return {"favorites": []}


@router.put("/favorites")
async def save_favorites(
    body: dict,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Persist favorited models."""
    favorites = body.get("favorites", [])
    now = now_ms()
    row = await session.get(GlobalSetting, "model_favorites")
    if row:
        row.value = json.dumps(favorites)
        row.updated_at = now
    else:
        session.add(
            GlobalSetting(
                key="model_favorites", value=json.dumps(favorites), updated_at=now
            )
        )
    await session.commit()
    return {"favorites": favorites}


@router.get("/models/suggestions")
async def get_model_suggestions():
    """Return commonly used model suggestions for autocomplete."""
    return {
        "working": [
            "openrouter/anthropic/claude-sonnet-4",
            "openrouter/anthropic/claude-opus-4",
            "openrouter/moonshotai/kimi-k2.5",
            "anthropic/claude-opus-4.6",
            "openrouter/google/gemini-2.0-flash-001",
        ],
        "thinking": [
            "openrouter/minimax/minimax-m2.5",
            "openrouter/google/gemini-2.0-flash-001",
            "openrouter/anthropic/claude-3.5-haiku",
            "zai/glm-5",
        ],
    }


# ─── Model provider endpoints ─────────────────────────────────────────────────


@router.get("/providers")
async def list_providers(
    session: AsyncSession = Depends(get_async_session),
) -> List[ModelProviderResponse]:
    """List all available providers and their configuration status."""
    result = await session.execute(select(ModelProvider))
    rows_by_id = {row.provider_id: row for row in result.scalars().all()}

    responses: List[ModelProviderResponse] = [
        _build_provider_response(provider_id, rows_by_id.get(provider_id))
        for provider_id in PROVIDER_CATALOG
    ]

    # Append custom providers stored in the DB (those not in PROVIDER_CATALOG)
    for provider_id, row in rows_by_id.items():
        if _is_custom_provider(provider_id) and provider_id not in PROVIDER_CATALOG:
            catalog_entry = _build_custom_catalog_entry(provider_id, row)
            responses.append(
                _build_provider_response(provider_id, row, catalog=catalog_entry)
            )

    return responses


@router.post("/providers")
async def create_custom_provider(
    body: CreateCustomProviderRequest,
    session: AsyncSession = Depends(get_async_session),
) -> ModelProviderResponse:
    """Create a new custom OpenAI-compatible provider."""
    slug = body.slug.strip().lower()
    _validate_custom_slug(slug)

    provider_id = f"{CUSTOM_PROVIDER_PREFIX}{slug}"

    if provider_id in PROVIDER_CATALOG:
        raise HTTPException(
            status_code=409,
            detail=f"'{provider_id}' conflicts with a built-in provider name.",
        )

    existing = await session.get(ModelProvider, provider_id)
    if existing:
        raise HTTPException(
            status_code=409,
            detail=f"A custom provider with slug '{slug}' already exists.",
        )

    base_url_env = _custom_base_url_env(provider_id)
    extra: Dict[str, str] = {
        "DISPLAY_NAME": body.name.strip(),
        base_url_env: body.baseUrl.strip(),
    }

    now = now_ms()
    row = ModelProvider(
        provider_id=provider_id,
        enabled=True,
        api_key=body.apiKey.strip() if body.apiKey and body.apiKey.strip() else None,
        extra_config=json.dumps(extra),
        created_at=now,
        updated_at=now,
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)

    catalog_entry = _build_custom_catalog_entry(provider_id, row)
    return _build_provider_response(provider_id, row, catalog=catalog_entry)


@router.put("/providers/{provider_id:path}")
async def upsert_provider(
    provider_id: str,
    config: ModelProviderConfig,
    session: AsyncSession = Depends(get_async_session),
) -> ModelProviderResponse:
    """Add or update a model provider configuration."""
    is_custom = _is_custom_provider(provider_id)
    if not is_custom and provider_id not in PROVIDER_CATALOG:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")

    now = now_ms()
    row = await session.get(ModelProvider, provider_id)
    if row:
        row.enabled = config.enabled
        # Only overwrite the stored key if a new non-empty key is provided
        if config.apiKey:
            row.api_key = config.apiKey
        # Merge extra config — only update keys that are explicitly provided
        if config.extraConfig:
            existing_extra = _resolve_extra_config(row)
            # Merge: new values overwrite, empty-string values remove the key
            merged = {**existing_extra}
            for k, v in config.extraConfig.items():
                if v:
                    merged[k] = v
                elif k in merged:
                    del merged[k]
            row.extra_config = json.dumps(merged) if merged else None
        row.updated_at = now
    else:
        row = ModelProvider(
            provider_id=provider_id,
            enabled=config.enabled,
            api_key=config.apiKey or None,
            extra_config=json.dumps(config.extraConfig) if config.extraConfig else None,
            created_at=now,
            updated_at=now,
        )
        session.add(row)

    await session.commit()
    await session.refresh(row)

    if is_custom:
        catalog_entry = _build_custom_catalog_entry(provider_id, row)
        return _build_provider_response(provider_id, row, catalog=catalog_entry)
    return _build_provider_response(provider_id, row)


@router.delete("/providers/{provider_id:path}")
async def remove_provider(
    provider_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove a provider configuration (clears stored API key).
    For custom providers this permanently deletes the provider record."""
    row = await session.get(ModelProvider, provider_id)
    if row:
        await session.delete(row)
        await session.commit()
    return {"status": "ok", "providerId": provider_id}


def _mask_key(api_key: str) -> str:
    """Return a masked version of an API key showing only prefix and last 4 chars.

    Examples:
        sk-abc...7xQ2
        key-...mN9p   (if key is very short)
    """
    if not api_key or len(api_key) < 8:
        return "****"
    # Show first chars up to the first dash or 4 chars, then last 4
    prefix_end = api_key.find("-", 0, 8)
    if prefix_end > 0:
        prefix = api_key[: prefix_end + 1]
    else:
        prefix = api_key[:4]
    return f"{prefix}...{api_key[-4:]}"


@router.get("/providers/keys/all")
async def get_all_provider_keys(
    user_id: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """
    Return configured API keys and extra env vars for engine/container injection.

    When ``user_id`` is provided, applies **strict** per-user key resolution:
      1. User's own key (from ``user_model_providers``)
      2. Admin-shared key (from ``admin_shared_providers`` → ``model_providers``)
      3. Nothing — no fallback to global instance keys

    When ``user_id`` is omitted (system/webhook triggers), returns all
    instance-level keys from ``model_providers`` (backward-compatible).

    Returns:
      keys: { provider_id: api_key } — primary API keys
      extra: { ENV_VAR_NAME: value } — flat map of all extra env vars across all providers
    """
    from sqlalchemy import or_
    from app.models.user_provider import UserModelProvider, AdminSharedProvider

    _INTERNAL_EXTRA_KEYS = {"DISPLAY_NAME"}

    if not user_id:
        # ── System mode: return all instance-level keys (backward compat) ──
        result = await session.execute(select(ModelProvider))
        rows = result.scalars().all()

        keys = {row.provider_id: row.api_key for row in rows if row.api_key}
        extra: Dict[str, str] = {}
        for row in rows:
            if row.extra_config:
                try:
                    ec = json.loads(row.extra_config)
                    for k, v in ec.items():
                        if v and k not in _INTERNAL_EXTRA_KEYS:
                            extra[k] = v
                except (json.JSONDecodeError, TypeError):
                    pass
        return {
            "keys": keys,
            "extra": extra,
            "key_sources": {
                pid: {"source": "instance", "masked_key": _mask_key(api_key)}
                for pid, api_key in keys.items()
            },
        }

    # ── Per-user mode: strict resolution ──────────────────────────────────

    # 1. Load user's own provider configs
    result = await session.execute(
        select(UserModelProvider).where(UserModelProvider.user_id == user_id)
    )
    user_providers = {row.provider_id: row for row in result.scalars().all()}

    # 2. Load admin-shared provider grants for this user (specific + broadcast)
    #    Filter out expired shares.
    from app.utils import now_ms as _now_ms

    _now = _now_ms()
    result = await session.execute(
        select(AdminSharedProvider).where(
            or_(
                AdminSharedProvider.target_user_id == user_id,
                AdminSharedProvider.target_user_id == None,  # broadcast
            ),
            or_(
                AdminSharedProvider.expires_at == None,
                AdminSharedProvider.expires_at > _now,
            ),
        )
    )
    shared_rows = list(result.scalars().all())
    shared_provider_ids = {row.provider_id for row in shared_rows}

    # 3. Load instance-level provider configs (needed for admin-shared keys)
    result = await session.execute(select(ModelProvider))
    instance_providers = {row.provider_id: row for row in result.scalars().all()}

    # 4. Enforce daily usage limits on admin-shared providers
    #    This checks daily_limit (request count) and daily_cost_limit_usd
    #    against today's llm_call_logs for this user.
    from app.share_limits import check_share_limits

    share_usage = await check_share_limits(session, user_id, shared_rows)

    # Remove providers that have exceeded their limits from the shared set
    blocked_providers: Dict[str, str] = {}  # provider_id → reason
    for provider_id, usage_info in share_usage.items():
        if usage_info.limit_exceeded:
            shared_provider_ids.discard(provider_id)
            blocked_providers[provider_id] = (
                usage_info.exceeded_reason or "Limit exceeded"
            )
            logger.info(
                f"Share limit exceeded for user {user_id}, "
                f"provider {provider_id}: {usage_info.exceeded_reason}"
            )

    keys: Dict[str, str] = {}
    extra: Dict[str, str] = {}
    # Track per-provider key source: "personal", "admin_shared", or "instance"
    key_sources: Dict[str, Dict[str, str]] = {}

    # Collect all provider IDs the user has access to
    all_provider_ids = set(user_providers.keys()) | shared_provider_ids

    for provider_id in all_provider_ids:
        # Priority 1: user's own key
        user_row = user_providers.get(provider_id)
        if user_row and user_row.api_key:
            keys[provider_id] = user_row.api_key
            key_sources[provider_id] = {
                "source": "personal",
                "masked_key": _mask_key(user_row.api_key),
            }
            if user_row.extra_config:
                try:
                    ec = json.loads(user_row.extra_config)
                    for k, v in ec.items():
                        if v and k not in _INTERNAL_EXTRA_KEYS:
                            extra[k] = v
                except (json.JSONDecodeError, TypeError):
                    pass
            continue

        # Priority 2: admin-shared instance key
        if provider_id in shared_provider_ids:
            instance_row = instance_providers.get(provider_id)
            if instance_row and instance_row.api_key:
                keys[provider_id] = instance_row.api_key
                key_sources[provider_id] = {
                    "source": "admin_shared",
                    "masked_key": _mask_key(instance_row.api_key),
                }
                if instance_row.extra_config:
                    try:
                        ec = json.loads(instance_row.extra_config)
                        for k, v in ec.items():
                            if v and k not in _INTERNAL_EXTRA_KEYS:
                                extra[k] = v
                    except (json.JSONDecodeError, TypeError):
                        pass

        # Priority 3: NOTHING — strict mode, no instance fallback

    # Build model restriction map from shared grants that have allowed_models set
    model_restrictions: Dict[str, list] = {}
    for provider_id, usage_info in share_usage.items():
        if usage_info.allowed_models and provider_id in keys:
            model_restrictions[provider_id] = usage_info.allowed_models

    # Build per-provider usage info for transparency (engine can surface this)
    share_usage_info: Dict[str, dict] = {}
    for provider_id, usage_info in share_usage.items():
        if provider_id in keys or provider_id in blocked_providers:
            share_usage_info[provider_id] = usage_info.to_dict()

    return {
        "keys": keys,
        "extra": extra,
        "model_restrictions": model_restrictions,
        "key_sources": key_sources,
        "blocked_providers": blocked_providers,
        "share_usage": share_usage_info,
    }


# Providers with a live /v1/models endpoint (OpenAI-compatible).
# Maps provider_id -> base URL for the models list.
# Providers NOT listed here use their static catalog models[] list.
_LIVE_MODELS_URLS: Dict[str, str] = {
    "opencode": "https://opencode.ai/zen/v1/models",
    "openrouter": "https://openrouter.ai/api/v1/models",
    "xai": "https://api.x.ai/v1/models",
    "openai": "https://api.openai.com/v1/models",
    "groq": "https://api.groq.com/openai/v1/models",
    "cerebras": "https://api.cerebras.ai/v1/models",
    "mistral": "https://api.mistral.ai/v1/models",
    # huggingface uses OpenAI-compatible router with standard /v1/models endpoint
    "huggingface": "https://router.huggingface.co/v1/models",
    # minimax and minimax-cn use Anthropic-compatible API — no standard /v1/models
    # kimi-coding — no standard /v1/models endpoint
    # azure-openai-responses — model availability is per-deployment, not listable
}


@router.get("/providers/{provider_id:path}/models")
async def get_provider_models(
    provider_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """
    Fetch the live model list for a provider by proxying its /v1/models endpoint.

    Falls back to the static catalog if the provider doesn't expose a live list
    or if the API key isn't configured.
    """
    is_custom = _is_custom_provider(provider_id)
    if not is_custom and provider_id not in PROVIDER_CATALOG:
        raise HTTPException(status_code=404, detail=f"Unknown provider: {provider_id}")

    # Custom providers: attempt live fetch from their base URL
    if is_custom:
        row = await session.get(ModelProvider, provider_id)
        if not row:
            return {"models": [], "source": "static"}
        extra = _resolve_extra_config(row)
        base_url = extra.get(_custom_base_url_env(provider_id), "").rstrip("/")
        if not base_url:
            return {"models": [], "source": "static"}
        api_key = _resolve_api_key(provider_id, row)
        headers: Dict[str, str] = {}
        if api_key:
            headers["Authorization"] = f"Bearer {api_key}"
        try:
            async with httpx.AsyncClient(timeout=8.0) as client:
                resp = await client.get(f"{base_url}/models", headers=headers)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            logger.warning(
                f"Failed to fetch live models for custom provider {provider_id}: {e}"
            )
            return {"models": [], "source": "static"}
        raw_models = data.get("data") or data.get("models") or []
        normalised = []
        for m in raw_models:
            model_id = m.get("id", "")
            if not model_id:
                continue
            # Always use the raw model_id as the display name, then prefix with
            # provider_id/ regardless of whether the raw ID contains slashes.
            # Local servers (LM Studio, Ollama, vLLM) use IDs like "openai/gpt-oss-20b"
            # or "qwen/qwen3-coder-30b" — these are their own internal naming and must
            # be preserved verbatim as the model sub-id so the request reaches the right
            # model, but the routing prefix must be our custom-<slug> provider id.
            full_id = f"{provider_id}/{model_id}"
            normalised.append(
                {
                    "id": full_id,
                    "name": m.get("name") or model_id,
                }
            )
        return {
            "models": _annotate_models(normalised),
            "source": "live" if normalised else "static",
        }

    catalog_models = PROVIDER_CATALOG[provider_id]["models"]

    # If no live endpoint exists, return static catalog
    models_url = _LIVE_MODELS_URLS.get(provider_id)
    if not models_url:
        return {"models": _annotate_models(catalog_models), "source": "static"}

    # Look up the API key — DB row first, env var fallback
    row = await session.get(ModelProvider, provider_id)
    api_key = _resolve_api_key(provider_id, row)

    if not api_key:
        # No key — return static catalog without erroring
        return {"models": _annotate_models(catalog_models), "source": "static"}

    headers = {"Authorization": f"Bearer {api_key}"}
    # OpenRouter also wants these headers
    if provider_id == "openrouter":
        headers["HTTP-Referer"] = "https://djinnbot.ai"
        headers["X-Title"] = "DjinnBot"

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(models_url, headers=headers)
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        logger.warning(
            f"Failed to fetch live models for {provider_id}: {e.response.status_code}"
        )
        return {"models": _annotate_models(catalog_models), "source": "static"}
    except Exception as e:
        logger.warning(f"Failed to fetch live models for {provider_id}: {e}")
        return {"models": _annotate_models(catalog_models), "source": "static"}

    # Normalise the response — providers return either data[] or models[]
    raw_models = data.get("data") or data.get("models") or []

    # Convert to our standard {id, name} shape.
    # For opencode/xai/openai-compatible: id is bare (e.g. "grok-4"), we prefix it.
    # For openrouter: id already includes provider prefix (e.g. "anthropic/claude-sonnet-4").
    normalised = []
    for m in raw_models:
        model_id = m.get("id", "")
        if not model_id:
            continue
        # Prefix with provider.
        # For openrouter: IDs arrive as "anthropic/claude-sonnet-4" — prefix
        # with "openrouter/" so the model resolver knows to route via OpenRouter
        # instead of trying the upstream provider directly (which would fail
        # if that provider's API key isn't configured).
        if "/" not in model_id:
            full_id = f"{provider_id}/{model_id}"
        elif provider_id == "openrouter":
            full_id = f"openrouter/{model_id}"
        else:
            full_id = model_id
        normalised.append(
            {
                "id": full_id,
                "name": m.get("name") or m.get("id") or model_id,
            }
        )

    if not normalised:
        return {"models": _annotate_models(catalog_models), "source": "static"}

    return {"models": _annotate_models(normalised), "source": "live"}
