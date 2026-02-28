"""Text-to-speech service supporting multiple providers.

Supported providers:
- Fish Audio: Cloud TTS via Fish Audio Python SDK
- Voicebox: Local TTS via Voicebox REST API (Qwen3-TTS)

Provides server-side TTS generation for voice message replies.
Audio is generated via the configured provider and stored using
the existing file_storage service as ChatAttachments.

Channel-specific audio format conversion is handled automatically:
- Telegram: OGG/Opus (native voice message format)
- Signal: AAC/M4A
- WhatsApp: OGG/Opus
- Discord: OGG/Opus
- Slack: MP3
- Dashboard: MP3

Cost calculation (Fish Audio only): $15.00 / 1M UTF-8 bytes.
Voicebox is local/free — cost is always $0.
"""

import json
import time
import asyncio
import subprocess
import tempfile
import os
from typing import Optional

import httpx

from app.logging_config import get_logger
from app.utils import gen_id, now_ms

logger = get_logger(__name__)

# Fish Audio pricing: $15.00 per 1M UTF-8 bytes (all models)
FISH_AUDIO_PRICE_PER_M_BYTES = 15.00

# Default TTS model
DEFAULT_TTS_MODEL = "s1"

# Default Voicebox base URL
DEFAULT_VOICEBOX_URL = "http://localhost:8000"

# Target audio format per channel.
#
# Fish Audio natively supports: mp3, wav, pcm, opus (raw Opus frames).
# Telegram/WhatsApp/Discord voice notes require OGG-wrapped Opus
# (OGG container with Opus codec). Fish Audio's "opus" output is raw
# Opus packets — we just need to remux into an OGG container via ffmpeg
# which is essentially free (no transcoding, just container wrapping).
CHANNEL_FORMAT_MAP = {
    "telegram": "ogg_opus",  # Telegram sendVoice requires OGG/Opus
    "signal": "mp3",  # Signal handles MP3 attachments fine
    "whatsapp": "ogg_opus",  # WhatsApp ptt voice notes require OGG/Opus
    "discord": "ogg_opus",  # Discord voice messages use OGG/Opus
    "slack": "mp3",  # Slack — MP3 works natively
    "dashboard": "mp3",  # Dashboard web player — MP3 is universal
}

# What to request from Fish Audio for each target format.
# We request MP3 and convert to OGG/Opus via ffmpeg for channels that need it.
TARGET_TO_FISH_FORMAT = {
    "ogg_opus": "mp3",  # Request MP3, convert to OGG/Opus via ffmpeg
    "mp3": "mp3",
    "wav": "wav",
}

# Mime types for the final output formats
FORMAT_MIME_MAP = {
    "mp3": "audio/mpeg",
    "ogg_opus": "audio/ogg",
    "wav": "audio/wav",
    "pcm": "audio/pcm",
}

# File extensions
FORMAT_EXT_MAP = {
    "mp3": "mp3",
    "ogg_opus": "ogg",
    "wav": "wav",
    "pcm": "pcm",
}


async def get_tts_settings() -> dict:
    """Fetch TTS-related global settings (character threshold, rate limit, etc.)."""
    from app.database import AsyncSessionLocal
    from sqlalchemy import select
    from app.models.settings import GlobalSetting

    defaults = {
        "ttsCharacterThreshold": 1000,
        "ttsMaxConcurrentRequests": 5,
        "ttsEnabled": True,
        "defaultTtsProvider": "fish-audio",
        "voiceboxUrl": DEFAULT_VOICEBOX_URL,
    }

    try:
        async with AsyncSessionLocal() as session:
            result = await session.execute(select(GlobalSetting))
            rows = {r.key: r.value for r in result.scalars().all()}

        return {
            "ttsCharacterThreshold": int(
                rows.get(
                    "ttsCharacterThreshold", str(defaults["ttsCharacterThreshold"])
                )
            ),
            "ttsMaxConcurrentRequests": int(
                rows.get(
                    "ttsMaxConcurrentRequests",
                    str(defaults["ttsMaxConcurrentRequests"]),
                )
            ),
            "ttsEnabled": rows.get("ttsEnabled", "true").lower() == "true",
            "defaultTtsProvider": rows.get(
                "defaultTtsProvider", defaults["defaultTtsProvider"]
            ),
            "voiceboxUrl": rows.get("voiceboxUrl", defaults["voiceboxUrl"]),
        }
    except Exception as e:
        logger.warning(f"Failed to load TTS settings, using defaults: {e}")
        return defaults


# Semaphore for rate limiting — initialized lazily based on admin setting
_tts_semaphore: Optional[asyncio.Semaphore] = None
_tts_semaphore_limit: int = 0


async def _get_semaphore() -> asyncio.Semaphore:
    """Get or create the TTS rate limiting semaphore."""
    global _tts_semaphore, _tts_semaphore_limit
    settings = await get_tts_settings()
    limit = settings["ttsMaxConcurrentRequests"]

    if _tts_semaphore is None or _tts_semaphore_limit != limit:
        _tts_semaphore = asyncio.Semaphore(limit)
        _tts_semaphore_limit = limit

    return _tts_semaphore


async def resolve_tts_api_key(
    user_id: Optional[str] = None,
) -> tuple[Optional[str], str]:
    """Resolve Fish Audio API key using the same priority chain as LLM keys.

    Priority:
      1. User's own key (from user_tts_providers)
      2. Admin-shared key (from admin_shared_tts_providers -> tts_providers)
      3. Instance-level key (from tts_providers)

    Returns: (api_key, key_source) where key_source is "personal"|"admin_shared"|"instance"
    """
    from app.database import AsyncSessionLocal
    from sqlalchemy import select, or_
    from app.models.tts_provider import (
        TtsProvider,
        UserTtsProvider,
        AdminSharedTtsProvider,
    )

    provider_id = "fish-audio"

    async with AsyncSessionLocal() as session:
        # Priority 1: User's own key
        if user_id:
            result = await session.execute(
                select(UserTtsProvider).where(
                    UserTtsProvider.user_id == user_id,
                    UserTtsProvider.provider_id == provider_id,
                )
            )
            user_row = result.scalar_one_or_none()
            if user_row and user_row.api_key:
                return user_row.api_key, "personal"

        # Priority 2: Admin-shared key
        if user_id:
            result = await session.execute(
                select(AdminSharedTtsProvider).where(
                    or_(
                        AdminSharedTtsProvider.target_user_id == user_id,
                        AdminSharedTtsProvider.target_user_id == None,
                    ),
                    AdminSharedTtsProvider.provider_id == provider_id,
                    or_(
                        AdminSharedTtsProvider.expires_at == None,
                        AdminSharedTtsProvider.expires_at > now_ms(),
                    ),
                )
            )
            shared = result.scalar_one_or_none()
            if shared:
                # Load instance key for the shared provider
                instance_row = await session.get(TtsProvider, provider_id)
                if instance_row and instance_row.api_key:
                    return instance_row.api_key, "admin_shared"

        # Priority 3: Instance-level key
        instance_row = await session.get(TtsProvider, provider_id)
        if instance_row and instance_row.api_key:
            return instance_row.api_key, "instance"

    return None, "none"


async def get_agent_tts_settings(agent_id: str) -> Optional[dict]:
    """Fetch per-agent TTS settings from the database.

    Returns a dict with tts_enabled, tts_provider, tts_voice_id, tts_voice_name
    or None if no settings exist for this agent.
    """
    from app.database import AsyncSessionLocal
    from app.models.agent_tts_settings import AgentTtsSettings

    try:
        async with AsyncSessionLocal() as session:
            row = await session.get(AgentTtsSettings, agent_id)
            if not row:
                return None
            return {
                "tts_enabled": row.tts_enabled,
                "tts_provider": row.tts_provider,
                "tts_voice_id": row.tts_voice_id,
                "tts_voice_name": row.tts_voice_name,
            }
    except Exception as e:
        logger.warning(f"Failed to load agent TTS settings for {agent_id}: {e}")
        return None


async def resolve_tts_provider(
    agent_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> str:
    """Resolve which TTS provider to use.

    Priority:
      1. Agent DB settings `tts_provider` (per-agent override)
      2. User preference (from global_settings key `userTtsProvider:{user_id}`)
      3. Admin default (from global_settings key `defaultTtsProvider`)
      4. Fallback: "fish-audio"
    """
    # 1. Agent DB settings override
    if agent_id:
        try:
            agent_settings = await get_agent_tts_settings(agent_id)
            if agent_settings and agent_settings.get("tts_provider"):
                return agent_settings["tts_provider"]
        except Exception:
            pass

    # 2. User preference
    if user_id:
        try:
            from app.database import AsyncSessionLocal
            from sqlalchemy import select
            from app.models.settings import GlobalSetting

            async with AsyncSessionLocal() as session:
                row = await session.get(GlobalSetting, f"userTtsProvider:{user_id}")
                if row and row.value:
                    return row.value
        except Exception:
            pass

    # 3 + 4. Admin default (falls back inside get_tts_settings)
    settings = await get_tts_settings()
    return settings.get("defaultTtsProvider", "fish-audio")


async def get_voicebox_url() -> str:
    """Get the configured Voicebox base URL."""
    settings = await get_tts_settings()
    return settings.get("voiceboxUrl", DEFAULT_VOICEBOX_URL)


async def _synthesize_voicebox(
    text: str,
    voice_id: Optional[str],
    output_format: str,
    language: str = "en",
) -> Optional[bytes]:
    """Generate speech via the local Voicebox API.

    Voicebox generates WAV audio. If a different output format is needed,
    the caller handles conversion via _convert_audio_format.

    Returns raw audio bytes (WAV) or None on failure.
    """
    base_url = await get_voicebox_url()

    payload: dict = {
        "text": text,
        "language": language,
    }
    if voice_id:
        payload["profile_id"] = voice_id

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            # Step 1: Generate speech — returns a GenerationResponse with an id
            resp = await client.post(
                f"{base_url}/generate",
                json=payload,
            )
            resp.raise_for_status()
            data = resp.json()
            generation_id = data.get("id")
            if not generation_id:
                logger.warning("Voicebox /generate returned no id")
                return None

            # Step 2: Fetch the audio file
            audio_resp = await client.get(f"{base_url}/audio/{generation_id}")
            audio_resp.raise_for_status()
            return audio_resp.content
    except httpx.ConnectError:
        logger.warning(f"Voicebox not reachable at {base_url} — is it running?")
        return None
    except Exception as e:
        logger.error(f"Voicebox TTS failed: {e}")
        return None


def _mask_key(api_key: str) -> str:
    """Mask an API key for logging."""
    if not api_key or len(api_key) < 8:
        return "****"
    return f"{api_key[:8]}...{api_key[-4:]}"


def _calculate_cost(text: str) -> float:
    """Calculate Fish Audio TTS cost from input text.

    Fish Audio charges $15.00 per 1M UTF-8 bytes.
    """
    utf8_bytes = len(text.encode("utf-8"))
    return utf8_bytes / 1_000_000 * FISH_AUDIO_PRICE_PER_M_BYTES


def _get_output_format(channel: str) -> str:
    """Get the optimal audio output format for a channel."""
    return CHANNEL_FORMAT_MAP.get(channel, "mp3")


async def _convert_audio_format(
    input_data: bytes,
    input_format: str,
    output_format: str,
) -> Optional[bytes]:
    """Convert audio between formats using ffmpeg.

    Primary use case: raw Opus from Fish Audio -> OGG/Opus for Telegram,
    WhatsApp, and Discord voice notes. This is just a container remux
    (no transcoding) — wraps raw Opus frames in an OGG container.
    """
    if input_format == output_format:
        return input_data

    try:
        with tempfile.TemporaryDirectory(prefix="djinnbot_tts_") as tmpdir:
            input_path = os.path.join(
                tmpdir, f"input.{FORMAT_EXT_MAP.get(input_format, input_format)}"
            )
            output_path = os.path.join(
                tmpdir, f"output.{FORMAT_EXT_MAP.get(output_format, output_format)}"
            )

            with open(input_path, "wb") as f:
                f.write(input_data)

            cmd = ["ffmpeg", "-y", "-i", input_path]

            if output_format == "ogg_opus":
                # Wrap into OGG container. If input is already Opus, just
                # remux (copy). Otherwise transcode to Opus.
                if input_format in ("opus", "ogg_opus"):
                    cmd.extend(["-c:a", "copy"])
                else:
                    cmd.extend(["-c:a", "libopus", "-b:a", "64k"])
            elif output_format == "m4a":
                cmd.extend(["-c:a", "aac", "-b:a", "128k"])

            cmd.append(output_path)

            result = await asyncio.get_event_loop().run_in_executor(
                None,
                lambda: subprocess.run(
                    cmd, capture_output=True, timeout=30, check=True
                ),
            )

            with open(output_path, "rb") as f:
                return f.read()
    except Exception as e:
        logger.warning(
            f"Audio format conversion {input_format} -> {output_format} failed: {e}"
        )
        return None


async def synthesize_speech(
    text: str,
    agent_id: str,
    voice_id: Optional[str] = None,
    voice_name: Optional[str] = None,
    channel: str = "dashboard",
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
) -> Optional[dict]:
    """Generate speech audio from text via the resolved TTS provider.

    Supports Fish Audio (cloud) and Voicebox (local).

    Returns a dict with:
      - audio_bytes: The generated audio data
      - mime_type: MIME type of the audio
      - filename: Suggested filename
      - format: Audio format (mp3, ogg, etc.)
      - cost: Estimated USD cost
      - duration_ms: API call latency
      - input_text_bytes: UTF-8 byte count of input
      - input_characters: Character count
      - provider: Which TTS provider was used

    Returns None if TTS is unavailable or fails.
    """
    # Check global TTS settings
    settings = await get_tts_settings()
    if not settings["ttsEnabled"]:
        logger.info("TTS is globally disabled")
        return None

    # Check character threshold
    if len(text) > settings["ttsCharacterThreshold"]:
        logger.info(
            f"TTS skipped: text length {len(text)} exceeds threshold "
            f"{settings['ttsCharacterThreshold']}"
        )
        return None

    # Resolve which provider to use
    provider = await resolve_tts_provider(agent_id=agent_id, user_id=user_id)

    # Determine output format for the channel
    output_format = _get_output_format(channel)

    start_time = time.monotonic()
    audio_bytes: Optional[bytes] = None
    cost = 0.0
    key_source = "none"
    key_masked = "****"
    model = DEFAULT_TTS_MODEL

    if provider == "voicebox":
        # ── Voicebox (local) ─────────────────────────────────────────────
        model = "qwen3-tts"

        # Acquire rate limiting semaphore
        semaphore = await _get_semaphore()
        try:
            async with semaphore:
                raw_wav = await _synthesize_voicebox(
                    text=text,
                    voice_id=voice_id,
                    output_format=output_format,
                )
                duration_ms = int((time.monotonic() - start_time) * 1000)
        except Exception as e:
            duration_ms = int((time.monotonic() - start_time) * 1000)
            logger.error(f"Voicebox TTS failed ({duration_ms}ms): {e}")
            return None

        if not raw_wav:
            logger.warning("Voicebox returned no audio")
            return None

        # Voicebox returns WAV — convert to target format if needed
        if output_format != "wav":
            converted = await _convert_audio_format(raw_wav, "wav", output_format)
            if converted:
                audio_bytes = converted
            else:
                # Fallback: serve as WAV
                audio_bytes = raw_wav
                output_format = "wav"
        else:
            audio_bytes = raw_wav

        cost = 0.0  # Local — free
        key_source = "local"
        key_masked = "local"

    else:
        # ── Fish Audio (cloud) ───────────────────────────────────────────
        # Resolve API key
        api_key, key_source = await resolve_tts_api_key(user_id)
        if not api_key:
            logger.warning(
                f"TTS unavailable: no Fish Audio API key configured (user={user_id})"
            )
            return None
        key_masked = _mask_key(api_key)

        # Determine what to request from Fish Audio and whether conversion
        # is needed afterward.
        fish_format = TARGET_TO_FISH_FORMAT.get(output_format, "mp3")
        # Fish Audio's "opus" output is OGG/Opus — no conversion needed
        # for ogg_opus targets. Only convert if formats truly differ.
        needs_conversion = fish_format != output_format and not (
            fish_format == "opus" and output_format == "ogg_opus"
        )

        # Acquire rate limiting semaphore
        semaphore = await _get_semaphore()
        try:
            async with semaphore:
                from fishaudio import AsyncFishAudio

                client = AsyncFishAudio(api_key=api_key)
                audio_bytes = await client.tts.convert(
                    text=text,
                    reference_id=voice_id,
                    format=fish_format,
                )
                duration_ms = int((time.monotonic() - start_time) * 1000)
        except Exception as e:
            duration_ms = int((time.monotonic() - start_time) * 1000)
            logger.error(f"Fish Audio TTS failed ({duration_ms}ms): {e}")
            return None

        if not audio_bytes:
            logger.warning("Fish Audio returned empty audio")
            return None

        # Convert format if needed (e.g., MP3 -> M4A for Signal)
        if needs_conversion:
            converted = await _convert_audio_format(
                audio_bytes, fish_format, output_format
            )
            if converted:
                audio_bytes = converted
            else:
                output_format = fish_format

        cost = _calculate_cost(text)

    input_text_bytes = len(text.encode("utf-8"))
    input_characters = len(text)

    # Log the TTS call
    await _log_tts_call(
        session_id=session_id,
        agent_id=agent_id,
        user_id=user_id,
        provider=provider,
        model=model,
        key_source=key_source,
        key_masked=key_masked,
        input_text_bytes=input_text_bytes,
        input_characters=input_characters,
        output_audio_bytes=len(audio_bytes),
        output_format=output_format,
        voice_id=voice_id,
        voice_name=voice_name,
        cost_total=cost,
        duration_ms=duration_ms,
        channel=channel,
    )

    ext = FORMAT_EXT_MAP.get(output_format, output_format)
    mime = FORMAT_MIME_MAP.get(output_format, "audio/mpeg")
    filename = f"tts_{agent_id}_{gen_id()}.{ext}"

    logger.info(
        f"TTS complete ({provider}): {input_characters} chars -> {len(audio_bytes)} bytes "
        f"({output_format}), cost=${cost:.6f}, {duration_ms}ms, "
        f"voice={voice_id or 'default'}, channel={channel}"
    )

    return {
        "audio_bytes": audio_bytes,
        "mime_type": mime,
        "filename": filename,
        "format": output_format,
        "cost": cost,
        "duration_ms": duration_ms,
        "input_text_bytes": input_text_bytes,
        "input_characters": input_characters,
        "provider": provider,
    }


async def _log_tts_call(
    session_id: Optional[str],
    agent_id: str,
    user_id: Optional[str],
    provider: str,
    model: str,
    key_source: str,
    key_masked: str,
    input_text_bytes: int,
    input_characters: int,
    output_audio_bytes: int,
    output_format: str,
    voice_id: Optional[str],
    voice_name: Optional[str],
    cost_total: float,
    duration_ms: int,
    channel: str,
) -> None:
    """Persist a TTS call log record and publish to Redis for real-time SSE."""
    from app.database import AsyncSessionLocal
    from app.models.tts_call_log import TtsCallLog
    from app import dependencies

    call_id = gen_id("ttscall")
    created_at = now_ms()

    try:
        async with AsyncSessionLocal() as db:
            call = TtsCallLog(
                id=call_id,
                session_id=session_id,
                agent_id=agent_id,
                user_id=user_id,
                provider=provider,
                model=model,
                key_source=key_source,
                key_masked=key_masked,
                input_text_bytes=input_text_bytes,
                input_characters=input_characters,
                output_audio_bytes=output_audio_bytes,
                output_format=output_format,
                voice_id=voice_id,
                voice_name=voice_name,
                cost_total=cost_total,
                duration_ms=duration_ms,
                channel=channel,
                created_at=created_at,
            )
            db.add(call)
            await db.commit()
    except Exception as e:
        logger.error(f"Failed to log TTS call: {e}")

    # Publish to Redis for real-time SSE streaming
    if dependencies.redis_client:
        try:
            payload = json.dumps(
                {
                    "type": "tts_call",
                    "id": call_id,
                    "session_id": session_id,
                    "agent_id": agent_id,
                    "user_id": user_id,
                    "provider": provider,
                    "model": model,
                    "input_text_bytes": input_text_bytes,
                    "input_characters": input_characters,
                    "output_audio_bytes": output_audio_bytes,
                    "cost_total": cost_total,
                    "duration_ms": duration_ms,
                    "channel": channel,
                    "created_at": created_at,
                }
            )
            await dependencies.redis_client.publish("djinnbot:tts-calls:live", payload)
        except Exception as e:
            logger.warning(f"Failed to publish TTS call event: {e}")


async def should_generate_tts(
    agent_id: str,
    response_text: str,
    is_voice_input: bool,
) -> bool:
    """Determine whether to generate TTS audio for this response.

    TTS is generated when:
    1. The agent has tts_enabled: true in DB settings
    2. The incoming message was a voice message
    3. The response text length is within the character threshold
    4. TTS is globally enabled
    """
    if not is_voice_input:
        return False

    # Check agent DB settings
    agent_settings = await get_agent_tts_settings(agent_id)
    if not agent_settings or not agent_settings.get("tts_enabled", False):
        return False

    # Check global settings
    settings = await get_tts_settings()
    if not settings["ttsEnabled"]:
        return False

    if len(response_text) > settings["ttsCharacterThreshold"]:
        return False

    return True


async def generate_tts_for_response(
    agent_id: str,
    response_text: str,
    session_id: Optional[str] = None,
    user_id: Optional[str] = None,
    channel: str = "dashboard",
) -> Optional[dict]:
    """Generate TTS audio for an agent's response.

    Reads voice configuration from agent_tts_settings DB table.
    Returns the result dict from synthesize_speech, or None.
    """
    agent_settings = await get_agent_tts_settings(agent_id)

    # Check agent-level TTS enabled
    if not agent_settings or not agent_settings.get("tts_enabled", False):
        logger.info(f"TTS skipped for agent {agent_id}: not enabled in agent settings")
        return None

    voice_id = agent_settings.get("tts_voice_id")
    voice_name = agent_settings.get("tts_voice_name")

    return await synthesize_speech(
        text=response_text,
        agent_id=agent_id,
        voice_id=voice_id,
        voice_name=voice_name,
        channel=channel,
        session_id=session_id,
        user_id=user_id,
    )
