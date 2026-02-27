"""Server-side audio transcription using faster-whisper.

Transcribes audio attachments (voice notes from Signal, Telegram, WhatsApp,
Discord) at upload time as a background task.  The transcript is stored as
`extracted_text` on the ChatAttachment record, so agent containers read it
via the standard /text endpoint — no special handling needed downstream.

Uses faster-whisper (CTranslate2 backend) which runs ~4x faster than
OpenAI's Python whisper on CPU.  The 'base' model (~150MB) provides good
accuracy for voice notes at ~3-5s per 30s clip.

Model is loaded lazily on first transcription request and cached in memory.
"""

import os
import tempfile
import subprocess
from typing import Optional

from app.logging_config import get_logger
from app.services.text_extraction import estimate_tokens

logger = get_logger(__name__)

# Model size — 'base' is the default (good accuracy, fast on CPU)
# Can be overridden via WHISPER_MODEL_SIZE env var
WHISPER_MODEL_SIZE = os.getenv("WHISPER_MODEL_SIZE", "base")

# Lazy-loaded model instance
_whisper_model = None
_whisper_load_failed = False


def _get_model():
    """Lazy-load the faster-whisper model (downloads on first use)."""
    global _whisper_model, _whisper_load_failed

    if _whisper_load_failed:
        return None

    if _whisper_model is not None:
        return _whisper_model

    try:
        from faster_whisper import WhisperModel

        logger.info(f"Loading faster-whisper model '{WHISPER_MODEL_SIZE}'...")
        _whisper_model = WhisperModel(
            WHISPER_MODEL_SIZE,
            device="cpu",
            compute_type="int8",  # Quantized for fast CPU inference
        )
        logger.info(f"faster-whisper model '{WHISPER_MODEL_SIZE}' loaded successfully")
        return _whisper_model
    except ImportError:
        logger.warning(
            "faster-whisper not installed — audio transcription unavailable. "
            "Install with: pip install faster-whisper"
        )
        _whisper_load_failed = True
        return None
    except Exception as e:
        logger.error(f"Failed to load faster-whisper model: {e}")
        _whisper_load_failed = True
        return None


def _convert_to_wav(input_path: str, output_path: str) -> bool:
    """Convert audio to 16kHz mono WAV using ffmpeg."""
    try:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                input_path,
                "-ar",
                "16000",  # 16kHz sample rate
                "-ac",
                "1",  # mono
                "-f",
                "wav",
                output_path,
            ],
            capture_output=True,
            timeout=30,
            check=True,
        )
        return True
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        FileNotFoundError,
    ) as e:
        logger.warning(f"ffmpeg conversion failed: {e}")
        return False


def transcribe_audio(
    data: bytes,
    mime_type: str,
    filename: str,
) -> tuple[Optional[str], int]:
    """Transcribe audio data to text.

    Returns (transcription_text, estimated_tokens).
    Returns (None, 0) if transcription fails or is unavailable.
    """
    model = _get_model()
    if model is None:
        logger.warning(f"Skipping transcription for {filename} — model not available")
        return None, 0

    try:
        with tempfile.TemporaryDirectory(prefix="djinnbot_audio_") as tmpdir:
            # Write audio to temp file
            input_path = os.path.join(tmpdir, filename)
            with open(input_path, "wb") as f:
                f.write(data)

            # Convert to WAV if not already WAV
            if "wav" in mime_type:
                audio_path = input_path
            else:
                audio_path = os.path.join(tmpdir, "input.wav")
                if not _convert_to_wav(input_path, audio_path):
                    logger.warning(f"Could not convert {filename} to WAV")
                    return None, 0

            # Transcribe with faster-whisper
            segments, info = model.transcribe(
                audio_path,
                beam_size=5,
                language=None,  # Auto-detect language
                vad_filter=True,  # Filter out silence
            )

            # Collect all segments
            text_parts = []
            for segment in segments:
                text_parts.append(segment.text.strip())

            transcription = " ".join(text_parts).strip()

            if not transcription:
                logger.info(f"No speech detected in {filename}")
                return f"[No speech detected in audio file {filename}]", 10

            logger.info(
                f"Transcribed {filename}: {len(transcription)} chars, "
                f"language={info.language} (prob={info.language_probability:.2f})"
            )

            return transcription, estimate_tokens(transcription)

    except Exception as e:
        logger.error(f"Audio transcription failed for {filename}: {e}")
        return None, 0
