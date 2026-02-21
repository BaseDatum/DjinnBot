"""Password hashing and verification using bcrypt."""

import hashlib
import hmac

import bcrypt


def hash_password(password: str) -> str:
    """Hash a password using bcrypt.

    Pre-hashes with SHA-256 to avoid bcrypt's 72-byte limit.
    """
    # SHA-256 prehash so passwords > 72 bytes still get full entropy.
    sha = hashlib.sha256(password.encode("utf-8")).hexdigest()
    hashed = bcrypt.hashpw(sha.encode("utf-8"), bcrypt.gensalt(rounds=12))
    return hashed.decode("utf-8")


def verify_password(password: str, password_hash: str) -> bool:
    """Verify a password against its bcrypt hash."""
    sha = hashlib.sha256(password.encode("utf-8")).hexdigest()
    try:
        return bcrypt.checkpw(sha.encode("utf-8"), password_hash.encode("utf-8"))
    except (ValueError, TypeError):
        return False
