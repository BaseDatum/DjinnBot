"""TTS (Text-to-Speech) API endpoints.

Provides:
- Voice listing (proxy to Fish Audio API or Voicebox local API)
- TTS synthesis endpoint (internal, called by engine after agent response)
- TTS call log querying
- TTS provider configuration (instance + user + admin-shared)
- TTS admin settings (rate limit, character threshold, default provider)
- User TTS provider preference

TTS providers are stored in separate tables from LLM providers so they
appear on a dedicated tab in the dashboard, as requested.
"""

import json
import httpx
from typing import Optional, List, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response
from pydantic import BaseModel
from sqlalchemy import select, func, desc, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.auth.dependencies import get_current_admin, AuthUser
from app.models.tts_call_log import TtsCallLog
from app.models.tts_provider import TtsProvider, UserTtsProvider, AdminSharedTtsProvider
from app.models.agent_tts_settings import AgentTtsSettings
from app.models.settings import GlobalSetting
from app.models.base import now_ms
from app.logging_config import get_logger
from app.utils import gen_id

logger = get_logger(__name__)

router = APIRouter()


# ─── TTS Provider Catalog ────────────────────────────────────────────────────

TTS_PROVIDER_CATALOG: Dict[str, dict] = {
    "fish-audio": {
        "name": "Fish Audio",
        "description": "High-quality cloud text-to-speech with voice cloning — S1 model",
        "apiKeyEnvVar": "FISH_AUDIO_API_KEY",
        "docsUrl": "https://docs.fish.audio",
        "requiresApiKey": True,
        "models": [
            {
                "id": "s1",
                "name": "S1",
                "description": "Latest and recommended TTS model",
            },
            {
                "id": "speech-1.6",
                "name": "Speech 1.6",
                "description": "Previous generation model",
            },
            {"id": "speech-1.5", "name": "Speech 1.5", "description": "Legacy model"},
        ],
    },
    "voicebox": {
        "name": "Voicebox",
        "description": "Local voice synthesis powered by Qwen3-TTS — runs on your machine, no API key needed",
        "apiKeyEnvVar": "",
        "docsUrl": "https://github.com/jamiepine/voicebox",
        "requiresApiKey": False,
        "models": [
            {
                "id": "qwen3-tts",
                "name": "Qwen3-TTS",
                "description": "Local voice cloning and synthesis via Voicebox",
            },
        ],
    },
}


# ─── Pydantic schemas ────────────────────────────────────────────────────────


class TtsProviderConfig(BaseModel):
    providerId: str
    enabled: bool = True
    apiKey: Optional[str] = None


class TtsProviderResponse(BaseModel):
    providerId: str
    enabled: bool
    configured: bool
    maskedApiKey: Optional[str] = None
    name: str
    description: str
    apiKeyEnvVar: str
    docsUrl: str
    models: List[Dict]


class TtsVoice(BaseModel):
    id: str
    title: str
    description: str = ""
    coverImage: Optional[str] = None
    tags: List[str] = []
    languages: List[str] = []
    author: Optional[str] = None


class TtsSynthesizeRequest(BaseModel):
    """Internal synthesis request (called by engine or channel bridges)."""

    text: str
    agent_id: str
    session_id: Optional[str] = None
    user_id: Optional[str] = None
    channel: str = "dashboard"


class TtsCallResponse(BaseModel):
    id: str
    session_id: Optional[str] = None
    agent_id: str
    user_id: Optional[str] = None
    provider: str
    model: str
    key_source: Optional[str] = None
    input_text_bytes: int
    input_characters: int
    output_audio_bytes: int
    output_format: str
    voice_id: Optional[str] = None
    voice_name: Optional[str] = None
    cost_total: Optional[float] = None
    duration_ms: Optional[int] = None
    channel: Optional[str] = None
    created_at: int


class TtsCallListResponse(BaseModel):
    calls: List[TtsCallResponse]
    total: int
    hasMore: bool
    summary: Optional[dict] = None


class TtsSettingsRequest(BaseModel):
    ttsEnabled: Optional[bool] = None
    ttsCharacterThreshold: Optional[int] = None
    ttsMaxConcurrentRequests: Optional[int] = None
    defaultTtsProvider: Optional[str] = None
    voiceboxUrl: Optional[str] = None


class UserTtsPreferenceRequest(BaseModel):
    defaultTtsProvider: str


class AdminSharedTtsProviderRequest(BaseModel):
    provider_id: str
    target_user_id: Optional[str] = None  # NULL = broadcast to all
    expires_at: Optional[int] = None
    daily_limit: Optional[int] = None
    daily_cost_limit_usd: Optional[float] = None


# ─── Helpers ──────────────────────────────────────────────────────────────────


def _mask_api_key(key: str) -> str:
    if not key or len(key) < 8:
        return "***"
    return f"{key[:8]}...{key[-4:]}"


def _build_tts_provider_response(
    provider_id: str, row: Optional[TtsProvider]
) -> TtsProviderResponse:
    catalog = TTS_PROVIDER_CATALOG.get(provider_id, {})
    api_key = row.api_key if row else None
    enabled = row.enabled if row else False
    configured = bool(api_key)

    return TtsProviderResponse(
        providerId=provider_id,
        enabled=enabled,
        configured=configured,
        maskedApiKey=_mask_api_key(api_key) if api_key else None,
        name=catalog.get("name", provider_id),
        description=catalog.get("description", ""),
        apiKeyEnvVar=catalog.get("apiKeyEnvVar", ""),
        docsUrl=catalog.get("docsUrl", ""),
        models=catalog.get("models", []),
    )


# ─── TTS Provider Endpoints (Instance Level - Admin) ─────────────────────────


@router.get("/settings/tts-providers")
async def list_tts_providers(
    session: AsyncSession = Depends(get_async_session),
) -> List[TtsProviderResponse]:
    """List all available TTS providers and their configuration status."""
    result = await session.execute(select(TtsProvider))
    rows_by_id = {row.provider_id: row for row in result.scalars().all()}

    return [
        _build_tts_provider_response(provider_id, rows_by_id.get(provider_id))
        for provider_id in TTS_PROVIDER_CATALOG
    ]


@router.put("/settings/tts-providers/{provider_id}")
async def upsert_tts_provider(
    provider_id: str,
    config: TtsProviderConfig,
    session: AsyncSession = Depends(get_async_session),
) -> TtsProviderResponse:
    """Add or update a TTS provider configuration."""
    if provider_id not in TTS_PROVIDER_CATALOG:
        raise HTTPException(
            status_code=404, detail=f"Unknown TTS provider: {provider_id}"
        )

    now = now_ms()
    row = await session.get(TtsProvider, provider_id)
    if row:
        row.enabled = config.enabled
        if config.apiKey:
            row.api_key = config.apiKey
        row.updated_at = now
    else:
        row = TtsProvider(
            provider_id=provider_id,
            enabled=config.enabled,
            api_key=config.apiKey or None,
            created_at=now,
            updated_at=now,
        )
        session.add(row)

    await session.commit()
    await session.refresh(row)
    return _build_tts_provider_response(provider_id, row)


@router.delete("/settings/tts-providers/{provider_id}")
async def remove_tts_provider(
    provider_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove a TTS provider configuration."""
    row = await session.get(TtsProvider, provider_id)
    if row:
        await session.delete(row)
        await session.commit()
    return {"status": "ok", "providerId": provider_id}


# ─── User TTS Provider Endpoints ─────────────────────────────────────────────


@router.get("/settings/user-tts-providers")
async def list_user_tts_providers(
    user_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> List[dict]:
    """List a user's personal TTS provider configs."""
    result = await session.execute(
        select(UserTtsProvider).where(UserTtsProvider.user_id == user_id)
    )
    rows = result.scalars().all()

    providers = []
    for row in rows:
        catalog = TTS_PROVIDER_CATALOG.get(row.provider_id, {})
        providers.append(
            {
                "providerId": row.provider_id,
                "enabled": row.enabled,
                "configured": bool(row.api_key),
                "maskedApiKey": _mask_api_key(row.api_key) if row.api_key else None,
                "name": catalog.get("name", row.provider_id),
            }
        )

    # Include unconfigured providers from catalog
    configured_ids = {r.provider_id for r in rows}
    for pid, cat in TTS_PROVIDER_CATALOG.items():
        if pid not in configured_ids:
            providers.append(
                {
                    "providerId": pid,
                    "enabled": False,
                    "configured": False,
                    "maskedApiKey": None,
                    "name": cat["name"],
                }
            )

    return providers


@router.put("/settings/user-tts-providers/{provider_id}")
async def upsert_user_tts_provider(
    provider_id: str,
    config: TtsProviderConfig,
    user_id: str = Query(...),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Add or update a user's personal TTS provider key."""
    if provider_id not in TTS_PROVIDER_CATALOG:
        raise HTTPException(
            status_code=404, detail=f"Unknown TTS provider: {provider_id}"
        )

    now = now_ms()
    result = await session.execute(
        select(UserTtsProvider).where(
            UserTtsProvider.user_id == user_id,
            UserTtsProvider.provider_id == provider_id,
        )
    )
    row = result.scalar_one_or_none()

    if row:
        row.enabled = config.enabled
        if config.apiKey:
            row.api_key = config.apiKey
        row.updated_at = now
    else:
        row = UserTtsProvider(
            user_id=user_id,
            provider_id=provider_id,
            enabled=config.enabled,
            api_key=config.apiKey or None,
            created_at=now,
            updated_at=now,
        )
        session.add(row)

    await session.commit()
    return {"status": "ok", "providerId": provider_id}


@router.delete("/settings/user-tts-providers/{provider_id}")
async def remove_user_tts_provider(
    provider_id: str,
    user_id: str = Query(...),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove a user's personal TTS provider key."""
    result = await session.execute(
        select(UserTtsProvider).where(
            UserTtsProvider.user_id == user_id,
            UserTtsProvider.provider_id == provider_id,
        )
    )
    row = result.scalar_one_or_none()
    if row:
        await session.delete(row)
        await session.commit()
    return {"status": "ok", "providerId": provider_id}


# ─── Admin TTS Key Sharing ───────────────────────────────────────────────────


@router.get("/admin/tts-sharing")
async def list_tts_shares(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> List[dict]:
    """List all admin TTS key sharing grants."""
    result = await session.execute(select(AdminSharedTtsProvider))
    rows = result.scalars().all()
    return [
        {
            "id": row.id,
            "adminUserId": row.admin_user_id,
            "providerId": row.provider_id,
            "targetUserId": row.target_user_id,
            "createdAt": row.created_at,
            "expiresAt": row.expires_at,
            "dailyLimit": row.daily_limit,
            "dailyCostLimitUsd": row.daily_cost_limit_usd,
        }
        for row in rows
    ]


@router.post("/admin/tts-sharing")
async def create_tts_share(
    body: AdminSharedTtsProviderRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Create a new admin TTS key sharing grant."""
    share = AdminSharedTtsProvider(
        id=gen_id("ttsshare"),
        admin_user_id=admin.user_id,
        provider_id=body.provider_id,
        target_user_id=body.target_user_id,
        created_at=now_ms(),
        expires_at=body.expires_at,
        daily_limit=body.daily_limit,
        daily_cost_limit_usd=body.daily_cost_limit_usd,
    )
    session.add(share)
    await session.commit()
    return {"status": "ok", "id": share.id}


@router.delete("/admin/tts-sharing/{share_id}")
async def delete_tts_share(
    share_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Delete a TTS key sharing grant."""
    row = await session.get(AdminSharedTtsProvider, share_id)
    if row:
        await session.delete(row)
        await session.commit()
    return {"status": "ok"}


# ─── TTS Admin Settings ──────────────────────────────────────────────────────


@router.get("/admin/tts-settings")
async def get_tts_settings(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Get TTS admin settings (character threshold, rate limit, enabled, default provider)."""
    result = await session.execute(select(GlobalSetting))
    rows = {r.key: r.value for r in result.scalars().all()}

    return {
        "ttsEnabled": rows.get("ttsEnabled", "true").lower() == "true",
        "ttsCharacterThreshold": int(rows.get("ttsCharacterThreshold", "1000")),
        "ttsMaxConcurrentRequests": int(rows.get("ttsMaxConcurrentRequests", "5")),
        "defaultTtsProvider": rows.get("defaultTtsProvider", "fish-audio"),
        "voiceboxUrl": rows.get("voiceboxUrl", "http://localhost:8000"),
    }


@router.put("/admin/tts-settings")
async def update_tts_settings(
    body: TtsSettingsRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Update TTS admin settings."""
    now = now_ms()
    updates: Dict[str, str] = {}

    if body.ttsEnabled is not None:
        updates["ttsEnabled"] = str(body.ttsEnabled).lower()
    if body.ttsCharacterThreshold is not None:
        updates["ttsCharacterThreshold"] = str(body.ttsCharacterThreshold)
    if body.ttsMaxConcurrentRequests is not None:
        updates["ttsMaxConcurrentRequests"] = str(body.ttsMaxConcurrentRequests)
    if body.defaultTtsProvider is not None:
        updates["defaultTtsProvider"] = body.defaultTtsProvider
    if body.voiceboxUrl is not None:
        updates["voiceboxUrl"] = body.voiceboxUrl

    for key, value in updates.items():
        row = await session.get(GlobalSetting, key)
        if row:
            row.value = value
            row.updated_at = now
        else:
            session.add(GlobalSetting(key=key, value=value, updated_at=now))

    await session.commit()

    # Reset the TTS semaphore so the new limit takes effect
    from app.services.tts import _tts_semaphore
    import app.services.tts as tts_module

    tts_module._tts_semaphore = None

    return await get_tts_settings(admin=admin, session=session)


# ─── Voice Listing ────────────────────────────────────────────────────────────


@router.get("/tts/voices")
async def list_voices(
    language: Optional[str] = Query(None),
    tag: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    page: int = Query(1, ge=1),
    page_size: int = Query(20, ge=1, le=100),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """List available Fish Audio voice models.

    Proxies to the Fish Audio API. Requires a configured Fish Audio API key
    (instance or user level).
    """
    # Resolve API key (try instance level first for voice listing)
    from app.services.tts import resolve_tts_api_key

    api_key, _ = await resolve_tts_api_key()
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="No Fish Audio API key configured. Add one in Settings > TTS Providers.",
        )

    # Build query params for Fish Audio API
    params: Dict[str, str] = {
        "page_size": str(page_size),
        "page_number": str(page),
        "sort_by": "score",
    }
    if language:
        params["language"] = language
    if tag:
        params["tag"] = tag
    if search:
        params["title"] = search

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                "https://api.fish.audio/model",
                params=params,
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            data = resp.json()
    except httpx.HTTPStatusError as e:
        logger.warning(
            f"Fish Audio voice listing failed: HTTP {e.response.status_code}"
        )
        raise HTTPException(
            status_code=502, detail="Failed to fetch voices from Fish Audio"
        )
    except Exception as e:
        logger.warning(f"Fish Audio voice listing failed: {e}")
        raise HTTPException(
            status_code=502, detail="Failed to fetch voices from Fish Audio"
        )

    # Transform to our schema
    voices = []
    for item in data.get("items", []):
        voices.append(
            {
                "id": item.get("_id", ""),
                "title": item.get("title", ""),
                "description": item.get("description", ""),
                "coverImage": item.get("cover_image", ""),
                "tags": item.get("tags", []),
                "languages": item.get("languages", []),
                "author": item.get("author", {}).get("nickname", ""),
                "likeCount": item.get("like_count", 0),
                "taskCount": item.get("task_count", 0),
            }
        )

    return {
        "voices": voices,
        "total": data.get("total", 0),
        "page": page,
        "pageSize": page_size,
    }


@router.get("/tts/voices/{voice_id}")
async def get_voice(
    voice_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Get details for a specific Fish Audio voice model."""
    from app.services.tts import resolve_tts_api_key

    api_key, _ = await resolve_tts_api_key()
    if not api_key:
        raise HTTPException(status_code=503, detail="No Fish Audio API key configured")

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                f"https://api.fish.audio/model/{voice_id}",
                headers={"Authorization": f"Bearer {api_key}"},
            )
            resp.raise_for_status()
            item = resp.json()
    except httpx.HTTPStatusError as e:
        if e.response.status_code == 404:
            raise HTTPException(status_code=404, detail="Voice not found")
        raise HTTPException(
            status_code=502, detail="Failed to fetch voice from Fish Audio"
        )
    except Exception as e:
        raise HTTPException(
            status_code=502, detail="Failed to fetch voice from Fish Audio"
        )

    return {
        "id": item.get("_id", ""),
        "title": item.get("title", ""),
        "description": item.get("description", ""),
        "coverImage": item.get("cover_image", ""),
        "tags": item.get("tags", []),
        "languages": item.get("languages", []),
        "author": item.get("author", {}).get("nickname", ""),
        "samples": item.get("samples", []),
    }


# ─── Voicebox Voice Profiles ──────────────────────────────────────────────────


@router.get("/tts/voicebox/profiles")
async def list_voicebox_profiles(
    search: Optional[str] = Query(None),
) -> dict:
    """List available Voicebox voice profiles from the local instance.

    Proxies to the Voicebox API at the configured base URL.
    """
    from app.services.tts import get_voicebox_url

    base_url = await get_voicebox_url()

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(f"{base_url}/profiles")
            resp.raise_for_status()
            profiles = resp.json()
    except httpx.ConnectError:
        raise HTTPException(
            status_code=503,
            detail=f"Voicebox not reachable at {base_url}. Is it running?",
        )
    except Exception as e:
        logger.warning(f"Voicebox profile listing failed: {e}")
        raise HTTPException(
            status_code=502, detail="Failed to fetch profiles from Voicebox"
        )

    # Transform to match our voice schema
    voices = []
    for p in profiles:
        title = p.get("name", "")
        # Client-side search filter
        if search and search.lower() not in title.lower():
            continue
        voices.append(
            {
                "id": p.get("id", ""),
                "title": title,
                "description": p.get("description", ""),
                "coverImage": None,
                "tags": [],
                "languages": [p.get("language", "en")],
                "author": "Local",
            }
        )

    return {
        "voices": voices,
        "total": len(voices),
        "page": 1,
        "pageSize": len(voices),
    }


@router.get("/tts/voicebox/health")
async def voicebox_health(
    url: Optional[str] = Query(
        None, description="Override URL to test (uses saved setting if omitted)"
    ),
) -> dict:
    """Check if Voicebox is reachable.

    Pass ?url=... to test a specific URL before saving it.
    """
    if url:
        base_url = url.rstrip("/")
    else:
        from app.services.tts import get_voicebox_url

        base_url = await get_voicebox_url()

    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(f"{base_url}/health")
            resp.raise_for_status()
            data = resp.json()
            return {
                "reachable": True,
                "url": base_url,
                "modelLoaded": data.get("model_loaded", False),
                "gpuType": data.get("gpu_type"),
                "backendType": data.get("backend_type"),
            }
    except Exception as e:
        logger.debug(f"Voicebox health check failed for {base_url}: {e}")
        return {"reachable": False, "url": base_url}


# ─── User TTS Provider Preference ────────────────────────────────────────────


@router.get("/settings/user-tts-preference")
async def get_user_tts_preference(
    user_id: str = Query(...),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Get a user's preferred TTS provider."""
    key = f"userTtsProvider:{user_id}"
    row = await session.get(GlobalSetting, key)
    return {
        "defaultTtsProvider": row.value if row else None,
    }


@router.put("/settings/user-tts-preference")
async def set_user_tts_preference(
    body: UserTtsPreferenceRequest,
    user_id: str = Query(...),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Set a user's preferred TTS provider."""
    if body.defaultTtsProvider not in TTS_PROVIDER_CATALOG:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown TTS provider: {body.defaultTtsProvider}",
        )

    now = now_ms()
    key = f"userTtsProvider:{user_id}"
    row = await session.get(GlobalSetting, key)
    if row:
        row.value = body.defaultTtsProvider
        row.updated_at = now
    else:
        session.add(
            GlobalSetting(key=key, value=body.defaultTtsProvider, updated_at=now)
        )
    await session.commit()
    return {"status": "ok", "defaultTtsProvider": body.defaultTtsProvider}


@router.delete("/settings/user-tts-preference")
async def clear_user_tts_preference(
    user_id: str = Query(...),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Clear a user's TTS provider preference (fall back to admin default)."""
    key = f"userTtsProvider:{user_id}"
    row = await session.get(GlobalSetting, key)
    if row:
        await session.delete(row)
        await session.commit()
    return {"status": "ok"}


# ─── TTS Synthesis Endpoint (Internal) ───────────────────────────────────────


@router.post("/internal/tts/synthesize")
async def synthesize(body: TtsSynthesizeRequest) -> dict:
    """Generate TTS audio and store as a chat attachment.

    Called by the engine/channel bridges after an agent response is complete.
    Returns the attachment info needed to send the audio to the user.
    """
    from app.services.tts import generate_tts_for_response
    from app.services import file_storage

    result = await generate_tts_for_response(
        agent_id=body.agent_id,
        response_text=body.text,
        session_id=body.session_id,
        user_id=body.user_id,
        channel=body.channel,
    )

    if not result:
        return {"ok": False, "reason": "TTS generation failed or skipped"}

    # Store the audio file on disk (no DB foreign key dependency)
    attachment_id = gen_id("ttsatt")
    storage_session = body.session_id or f"tts_{body.agent_id}"
    storage_path = file_storage.store_file(
        session_id=storage_session,
        attachment_id=attachment_id,
        filename=result["filename"],
        data=result["audio_bytes"],
    )

    # Only create a ChatAttachment DB record if the session exists in the DB.
    # Channel bridges (Signal, Telegram, etc.) pass logical keys like
    # "signal_+1234_grace" which aren't real chat_sessions rows — they
    # download the audio directly from this response.
    if body.session_id:
        from app.database import AsyncSessionLocal
        from app.models.chat import ChatAttachment, ChatSession
        from app.utils import now_ms as _now_ms

        try:
            async with AsyncSessionLocal() as db:
                # Verify session exists before inserting attachment
                session_row = await db.get(ChatSession, body.session_id)
                if session_row:
                    att = ChatAttachment(
                        id=attachment_id,
                        session_id=body.session_id,
                        filename=result["filename"],
                        mime_type=result["mime_type"],
                        size_bytes=len(result["audio_bytes"]),
                        storage_path=storage_path,
                        processing_status="ready",
                        created_at=_now_ms(),
                    )
                    db.add(att)
                    await db.commit()
        except Exception as e:
            logger.error(f"Failed to create TTS attachment record: {e}")

    # Return audio bytes directly so channel bridges don't need a second
    # download request. Base64-encoded to fit in JSON.
    import base64

    audio_b64 = base64.b64encode(result["audio_bytes"]).decode("ascii")

    return {
        "ok": True,
        "attachmentId": attachment_id,
        "storagePath": storage_path,
        "filename": result["filename"],
        "mimeType": result["mime_type"],
        "format": result["format"],
        "sizeBytes": len(result["audio_bytes"]),
        "cost": result["cost"],
        "durationMs": result["duration_ms"],
        "audioBase64": audio_b64,
    }


# ─── TTS Call Log Endpoints ──────────────────────────────────────────────────


def _row_to_response(row: TtsCallLog) -> TtsCallResponse:
    return TtsCallResponse(
        id=row.id,
        session_id=row.session_id,
        agent_id=row.agent_id,
        user_id=row.user_id,
        provider=row.provider,
        model=row.model,
        key_source=row.key_source,
        input_text_bytes=row.input_text_bytes,
        input_characters=row.input_characters,
        output_audio_bytes=row.output_audio_bytes,
        output_format=row.output_format,
        voice_id=row.voice_id,
        voice_name=row.voice_name,
        cost_total=row.cost_total,
        duration_ms=row.duration_ms,
        channel=row.channel,
        created_at=row.created_at,
    )


@router.get("/tts-calls")
async def list_tts_calls(
    session_id: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_session),
) -> TtsCallListResponse:
    """List TTS calls, filterable by session or agent."""
    query = select(TtsCallLog)

    if session_id:
        query = query.where(TtsCallLog.session_id == session_id)
    if agent_id:
        query = query.where(TtsCallLog.agent_id == agent_id)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    # Summary
    sub = query.subquery()
    summary_query = select(
        func.count(sub.c.id).label("call_count"),
        func.sum(sub.c.input_text_bytes).label("total_input_bytes"),
        func.sum(sub.c.input_characters).label("total_input_chars"),
        func.sum(sub.c.output_audio_bytes).label("total_output_bytes"),
        func.sum(sub.c.cost_total).label("total_cost"),
        func.avg(sub.c.duration_ms).label("avg_duration_ms"),
    )
    summary_result = await db.execute(summary_query)
    srow = summary_result.one()
    summary = {
        "callCount": srow.call_count or 0,
        "totalInputBytes": srow.total_input_bytes or 0,
        "totalInputChars": srow.total_input_chars or 0,
        "totalOutputBytes": srow.total_output_bytes or 0,
        "totalCost": round(srow.total_cost or 0, 6),
        "avgDurationMs": round(srow.avg_duration_ms or 0),
    }

    result = await db.execute(
        query.order_by(desc(TtsCallLog.created_at)).limit(limit).offset(offset)
    )
    calls = [_row_to_response(r) for r in result.scalars().all()]

    return TtsCallListResponse(
        calls=calls,
        total=total,
        hasMore=(offset + len(calls)) < total,
        summary=summary,
    )


@router.get("/admin/tts-calls")
async def admin_list_tts_calls(
    admin: AuthUser = Depends(get_current_admin),
    session_id: Optional[str] = Query(None),
    agent_id: Optional[str] = Query(None),
    channel: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    db: AsyncSession = Depends(get_async_session),
) -> TtsCallListResponse:
    """Admin: list all TTS calls with additional filters."""
    query = select(TtsCallLog)

    if session_id:
        query = query.where(TtsCallLog.session_id == session_id)
    if agent_id:
        query = query.where(TtsCallLog.agent_id == agent_id)
    if channel:
        query = query.where(TtsCallLog.channel == channel)

    count_q = select(func.count()).select_from(query.subquery())
    total = (await db.execute(count_q)).scalar() or 0

    sub = query.subquery()
    summary_query = select(
        func.count(sub.c.id).label("call_count"),
        func.sum(sub.c.input_text_bytes).label("total_input_bytes"),
        func.sum(sub.c.cost_total).label("total_cost"),
        func.avg(sub.c.duration_ms).label("avg_duration_ms"),
    )
    summary_result = await db.execute(summary_query)
    srow = summary_result.one()
    summary = {
        "callCount": srow.call_count or 0,
        "totalInputBytes": srow.total_input_bytes or 0,
        "totalCost": round(srow.total_cost or 0, 6),
        "avgDurationMs": round(srow.avg_duration_ms or 0),
    }

    result = await db.execute(
        query.order_by(desc(TtsCallLog.created_at)).limit(limit).offset(offset)
    )
    calls = [_row_to_response(r) for r in result.scalars().all()]

    return TtsCallListResponse(
        calls=calls,
        total=total,
        hasMore=(offset + len(calls)) < total,
        summary=summary,
    )


# ─── Agent TTS Settings (DB-persisted, survives restarts) ────────────────


class AgentTtsSettingsRequest(BaseModel):
    tts_enabled: Optional[bool] = None
    tts_provider: Optional[str] = None
    tts_voice_id: Optional[str] = None
    tts_voice_name: Optional[str] = None


class AgentTtsSettingsResponse(BaseModel):
    agent_id: str
    tts_enabled: bool
    tts_provider: Optional[str] = None
    tts_voice_id: Optional[str] = None
    tts_voice_name: Optional[str] = None


@router.get("/agents/{agent_id}/tts-settings")
async def get_agent_tts_settings(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> AgentTtsSettingsResponse:
    """Get per-agent TTS settings from the database."""
    row = await session.get(AgentTtsSettings, agent_id)
    if not row:
        return AgentTtsSettingsResponse(
            agent_id=agent_id,
            tts_enabled=False,
        )
    return AgentTtsSettingsResponse(
        agent_id=agent_id,
        tts_enabled=row.tts_enabled,
        tts_provider=row.tts_provider,
        tts_voice_id=row.tts_voice_id,
        tts_voice_name=row.tts_voice_name,
    )


@router.put("/agents/{agent_id}/tts-settings")
async def update_agent_tts_settings(
    agent_id: str,
    body: AgentTtsSettingsRequest,
    session: AsyncSession = Depends(get_async_session),
) -> AgentTtsSettingsResponse:
    """Update per-agent TTS settings in the database.

    These settings persist across server restarts (unlike config.yml).
    """
    now = now_ms()
    row = await session.get(AgentTtsSettings, agent_id)

    if row:
        if body.tts_enabled is not None:
            row.tts_enabled = body.tts_enabled
        if body.tts_provider is not None:
            row.tts_provider = body.tts_provider if body.tts_provider else None
        # Allow explicit null to clear voice
        if "tts_voice_id" in (body.model_dump(exclude_unset=True)):
            row.tts_voice_id = body.tts_voice_id
        if "tts_voice_name" in (body.model_dump(exclude_unset=True)):
            row.tts_voice_name = body.tts_voice_name
        row.updated_at = now
    else:
        row = AgentTtsSettings(
            agent_id=agent_id,
            tts_enabled=body.tts_enabled if body.tts_enabled is not None else False,
            tts_provider=body.tts_provider if body.tts_provider else None,
            tts_voice_id=body.tts_voice_id,
            tts_voice_name=body.tts_voice_name,
            updated_at=now,
        )
        session.add(row)

    await session.commit()
    await session.refresh(row)

    return AgentTtsSettingsResponse(
        agent_id=agent_id,
        tts_enabled=row.tts_enabled,
        tts_provider=row.tts_provider,
        tts_voice_id=row.tts_voice_id,
        tts_voice_name=row.tts_voice_name,
    )


# ─── TTS Key Resolution (for engine/containers) ──────────────────────────────


@router.get("/settings/tts-providers/keys/all")
async def get_tts_provider_keys(
    user_id: Optional[str] = None,
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Return configured TTS API keys for engine/container injection.

    Uses the same resolution priority as LLM keys:
      1. User's own key
      2. Admin-shared key
      3. Instance key (only when no user_id)
    """
    if not user_id:
        # System mode
        result = await session.execute(select(TtsProvider))
        rows = result.scalars().all()
        keys = {row.provider_id: row.api_key for row in rows if row.api_key}
        return {"keys": keys}

    # Per-user mode
    keys: Dict[str, str] = {}

    # 1. User's own TTS keys
    result = await session.execute(
        select(UserTtsProvider).where(UserTtsProvider.user_id == user_id)
    )
    for row in result.scalars().all():
        if row.api_key:
            keys[row.provider_id] = row.api_key

    # 2. Admin-shared TTS keys (if user doesn't have their own)
    result = await session.execute(
        select(AdminSharedTtsProvider).where(
            or_(
                AdminSharedTtsProvider.target_user_id == user_id,
                AdminSharedTtsProvider.target_user_id == None,
            ),
            or_(
                AdminSharedTtsProvider.expires_at == None,
                AdminSharedTtsProvider.expires_at > now_ms(),
            ),
        )
    )
    shared_ids = {row.provider_id for row in result.scalars().all()}

    for provider_id in shared_ids:
        if provider_id not in keys:
            instance_row = await session.get(TtsProvider, provider_id)
            if instance_row and instance_row.api_key:
                keys[provider_id] = instance_row.api_key

    return {"keys": keys}
