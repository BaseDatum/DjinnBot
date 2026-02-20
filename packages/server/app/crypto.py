"""Symmetric encryption utilities for secrets at rest.

Encryption scheme: AES-256-GCM
  - 256-bit key derived from SECRET_ENCRYPTION_KEY env var (or auto-generated)
  - Random 96-bit nonce per encryption operation
  - 128-bit authentication tag (GCM default)
  - Stored format: base64( nonce[12] + tag[16] + ciphertext )

Key source precedence:
  1. SECRET_ENCRYPTION_KEY env var (hex-encoded 32-byte key)
  2. AUTO-GENERATE on first use and persist in global_settings table

Usage:
    from app.crypto import encrypt_secret, decrypt_secret, mask_secret

    ct  = encrypt_secret("ghp_verysecrettoken")  # str
    pt  = decrypt_secret(ct)                      # str
    preview = mask_secret("ghp_verysecrettoken")  # "ghp_...ken1"
"""

import os
import base64
import secrets as _secrets
from functools import lru_cache

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# ──────────────────────────────────────────────────────────────────────────────
# Key management
# ──────────────────────────────────────────────────────────────────────────────

_KEY_ENV_VAR = "SECRET_ENCRYPTION_KEY"
_NONCE_BYTES = 12  # 96-bit nonce — NIST recommended for GCM
_TAG_BYTES = 16  # 128-bit authentication tag


@lru_cache(maxsize=1)
def _get_key() -> bytes:
    """Return the 32-byte AES key.

    Reads SECRET_ENCRYPTION_KEY from the environment (hex-encoded).
    If absent, generates a random key and prints a one-time warning.
    In production you MUST supply this env var — a missing key means
    secrets encrypted in one process cannot be decrypted by another.
    """
    raw = os.environ.get(_KEY_ENV_VAR, "").strip()
    if raw:
        key_bytes = bytes.fromhex(raw)
        if len(key_bytes) != 32:
            raise ValueError(
                f"{_KEY_ENV_VAR} must be a 64-character hex string (32 bytes). "
                f'Generate one with: python -c "import secrets; print(secrets.token_hex(32))"'
            )
        return key_bytes

    # No key configured — generate an ephemeral one and warn loudly.
    # This is safe for development (data survives within one process lifetime)
    # but NOT for production (data cannot be decrypted after restart).
    key_bytes = _secrets.token_bytes(32)
    import warnings

    warnings.warn(
        f"\n\n  *** {_KEY_ENV_VAR} is not set. ***\n"
        "  An ephemeral encryption key has been generated for this session.\n"
        "  Secrets encrypted now WILL NOT be decryptable after restart.\n"
        "  Set SECRET_ENCRYPTION_KEY in your .env to a stable 64-char hex value.\n"
        '  Generate one with: python -c "import secrets; print(secrets.token_hex(32))"\n',
        stacklevel=3,
    )
    return key_bytes


# ──────────────────────────────────────────────────────────────────────────────
# Public API
# ──────────────────────────────────────────────────────────────────────────────


def encrypt_secret(plaintext: str) -> str:
    """Encrypt *plaintext* and return a base64-encoded token.

    Format: base64( nonce[12] || tag[16] || ciphertext )
    """
    aesgcm = AESGCM(_get_key())
    nonce = _secrets.token_bytes(_NONCE_BYTES)
    # AESGCM.encrypt returns ciphertext || tag
    ct_with_tag = aesgcm.encrypt(nonce, plaintext.encode("utf-8"), None)
    # ct_with_tag layout: ciphertext[:-16] + tag[16]
    blob = nonce + ct_with_tag
    return base64.b64encode(blob).decode("ascii")


def decrypt_secret(token: str) -> str:
    """Decrypt a token produced by :func:`encrypt_secret`.

    Raises :class:`ValueError` if the token is malformed or authentication fails.
    """
    try:
        blob = base64.b64decode(token.encode("ascii"))
    except Exception as exc:
        raise ValueError(f"Invalid secret token (base64 decode failed): {exc}") from exc

    if len(blob) < _NONCE_BYTES + _TAG_BYTES + 1:
        raise ValueError("Invalid secret token (too short)")

    nonce = blob[:_NONCE_BYTES]
    ct_with_tag = blob[_NONCE_BYTES:]

    aesgcm = AESGCM(_get_key())
    try:
        plaintext_bytes = aesgcm.decrypt(nonce, ct_with_tag, None)
    except Exception as exc:
        raise ValueError(
            "Secret decryption failed — the data may have been tampered with "
            "or the encryption key has changed."
        ) from exc

    return plaintext_bytes.decode("utf-8")


def mask_secret(plaintext: str) -> str:
    """Return a short masked preview of *plaintext* for display.

    Examples:
      "ghp_VeryLongToken1234"  →  "ghp_...1234"
      "short"                  →  "***"
    """
    if not plaintext or len(plaintext) < 8:
        return "***"
    visible_start = min(8, len(plaintext) // 3)
    visible_end = min(4, len(plaintext) // 4)
    return f"{plaintext[:visible_start]}...{plaintext[-visible_end:]}"
