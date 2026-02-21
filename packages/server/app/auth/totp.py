"""TOTP (Time-based One-Time Password) utilities for 2FA."""

import hashlib
import secrets
import uuid
from typing import Optional

import pyotp

from app.auth.config import auth_settings
from app.crypto import encrypt_secret, decrypt_secret


def generate_totp_secret() -> str:
    """Generate a new TOTP base32 secret."""
    return pyotp.random_base32()


def encrypt_totp_secret(secret: str) -> str:
    """Encrypt the TOTP secret for database storage."""
    return encrypt_secret(secret)


def decrypt_totp_secret(encrypted: str) -> str:
    """Decrypt a stored TOTP secret."""
    return decrypt_secret(encrypted)


def get_provisioning_uri(secret: str, email: str) -> str:
    """Generate the otpauth:// URI for QR code generation.

    The authenticator app scans this to add the account.
    """
    totp = pyotp.TOTP(secret)
    return totp.provisioning_uri(name=email, issuer_name=auth_settings.totp_issuer)


def verify_totp_code(secret: str, code: str) -> bool:
    """Verify a 6-digit TOTP code.

    Allows a 30-second window on each side (valid_window=1) to account for
    clock drift between server and authenticator app.
    """
    totp = pyotp.TOTP(secret)
    return totp.verify(code, valid_window=1)


def generate_recovery_codes(count: int = 10) -> list[tuple[str, str]]:
    """Generate a set of one-time recovery codes.

    Returns list of (plaintext_code, sha256_hash) tuples.
    The plaintext is shown to the user once; the hash is stored in the DB.
    """
    codes = []
    for _ in range(count):
        # 8-character alphanumeric codes, grouped for readability
        raw = secrets.token_hex(4).upper()  # 8 hex chars
        code = f"{raw[:4]}-{raw[4:]}"
        code_hash = hashlib.sha256(code.encode()).hexdigest()
        codes.append((code, code_hash))
    return codes


def verify_recovery_code(code: str, code_hash: str) -> bool:
    """Check if a recovery code matches its hash."""
    return hashlib.sha256(code.strip().encode()).hexdigest() == code_hash


def generate_recovery_code_id() -> str:
    """Generate a unique ID for a recovery code record."""
    return f"rc_{uuid.uuid4().hex[:12]}"
