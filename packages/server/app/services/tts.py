"""Text-to-speech service using Fish Audio.

Provides server-side TTS generation for voice message replies.
Audio is generated via the Fish Audio Python SDK and stored using
the existing file_storage service as ChatAttachments.

Channel-specific audio format conversion is handled automatically:
- Telegram: OGG/Opus (native voice message format)
- Signal: AAC/M4A
- WhatsApp: OGG/Opus
- Discord: OGG/Opus
- Slack: MP3
- Dashboard: MP3

Cost calculation: Fish Audio charges $15.00 / 1M UTF-8 bytes for all
TTS models (s1, speech-1.5, speech-1.6). The API response does not
include usage metadata, so we compute cost from input text size.
"""

import json
import time
import asyncio
import subprocess
import tempfile
import os
from typing import Optional

from app.logging_config import get_logger
from app.utils import gen_id, now_ms

logger = get_logger(__name__)

# Fish Audio pricing: $15.00 per 1M UTF-8 bytes (all models)
FISH_AUDIO_PRICE_PER_M_BYTES = 15.00

# Default TTS model
DEFAULT_TTS_MODEL = "s1"

# Audio format mapping per channel
# Fish Audio supports: mp3, wav, pcm, opus
# We request the closest native format and convert if needed.
CHANNEL_FORMAT_MAP = {
    "telegram": "opus",  # Telegram voice notes use OGG/Opus
    "signal": "mp3",  # Signal — convert to M4A post-generation
    "whatsapp": "opus",  # WhatsApp voice notes use OGG/Opus
    "discord": "opus",  # Discord voice messages use OGG/Opus
    "slack": "mp3",  # Slack audio — MP3 works natively
    "dashboard": "mp3",  # Dashboard web player — MP3 is universal
}

# Mime types for the output formats
FORMAT_MIME_MAP = {
    "mp3": "audio/mpeg",
    "opus": "audio/ogg",
    "wav": "audio/wav",
    "pcm": "audio/pcm",
    "m4a": "audio/mp4",
}

# File extensions
FORMAT_EXT_MAP = {
    "mp3": "mp3",
    "opus": "ogg",
    "wav": "wav",
    "pcm": "pcm",
    "m4a": "m4a",
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

    Only needed when Fish Audio can't produce the target format natively.
    Currently used for Signal (MP3 -> M4A).
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

            if output_format == "m4a":
                cmd.extend(["-c:a", "aac", "-b:a", "128k"])
            elif output_format == "ogg":
                cmd.extend(["-c:a", "libopus", "-b:a", "64k"])

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
    """Generate speech audio from text via Fish Audio.

    Returns a dict with:
      - audio_bytes: The generated audio data
      - mime_type: MIME type of the audio
      - filename: Suggested filename
      - format: Audio format (mp3, ogg, etc.)
      - cost: Estimated USD cost
      - duration_ms: API call latency
      - input_text_bytes: UTF-8 byte count of input
      - input_characters: Character count

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

    # Resolve API key
    api_key, key_source = await resolve_tts_api_key(user_id)
    if not api_key:
        logger.warning(
            f"TTS unavailable: no Fish Audio API key configured (user={user_id})"
        )
        return None

    # Determine output format for the channel
    output_format = _get_output_format(channel)

    # Fish Audio supports mp3, wav, pcm, opus directly
    # For Signal we need M4A, so request MP3 and convert
    fish_format = output_format
    needs_conversion = False
    if output_format == "m4a":
        fish_format = "mp3"
        needs_conversion = True

    # Acquire rate limiting semaphore
    semaphore = await _get_semaphore()

    start_time = time.monotonic()
    try:
        async with semaphore:
            # Use the Fish Audio async SDK
            from fishaudio import AsyncFishAudio

            client = AsyncFishAudio(api_key=api_key)

            # Generate speech
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
        converted = await _convert_audio_format(audio_bytes, fish_format, output_format)
        if converted:
            audio_bytes = converted
            # Update format to the converted one
        else:
            # Fallback: use the original format
            output_format = fish_format

    # Calculate cost
    cost = _calculate_cost(text)
    input_text_bytes = len(text.encode("utf-8"))
    input_characters = len(text)

    # Log the TTS call
    await _log_tts_call(
        session_id=session_id,
        agent_id=agent_id,
        user_id=user_id,
        model=DEFAULT_TTS_MODEL,
        key_source=key_source,
        key_masked=_mask_key(api_key),
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
        f"TTS complete: {input_characters} chars -> {len(audio_bytes)} bytes "
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
    }


async def _log_tts_call(
    session_id: Optional[str],
    agent_id: str,
    user_id: Optional[str],
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
                provider="fish-audio",
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
                    "provider": "fish-audio",
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
    1. The agent has tts_enabled: true in config
    2. The incoming message was a voice message
    3. The response text length is within the character threshold
    4. TTS is globally enabled
    5. A Fish Audio API key is available
    """
    if not is_voice_input:
        return False

    # Check agent config
    from app.services.agent_config import get_agent_config

    config = await get_agent_config(agent_id)
    if not config.get("tts_enabled", False):
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

    Reads voice configuration from agent config.yml and generates audio.
    Returns the result dict from synthesize_speech, or None.
    """
    from app.services.agent_config import get_agent_config

    config = await get_agent_config(agent_id)
    voice_id = config.get("tts_voice_id")
    voice_name = config.get("tts_voice_name")

    return await synthesize_speech(
        text=response_text,
        agent_id=agent_id,
        voice_id=voice_id,
        voice_name=voice_name,
        channel=channel,
        session_id=session_id,
        user_id=user_id,
    )
