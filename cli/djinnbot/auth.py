"""Authentication credential storage and token management.

Stores credentials per server URL in ~/.config/djinnbot/auth.json.
Supports JWT (access + refresh tokens) and API key auth.
"""

import json
import time
from pathlib import Path
from typing import Optional

import httpx

# Default config directory
CONFIG_DIR = Path.home() / ".config" / "djinnbot"
AUTH_FILE = CONFIG_DIR / "auth.json"


def _normalise_url(url: str) -> str:
    """Normalise a server URL for use as a storage key."""
    return url.rstrip("/").lower()


def _load_store() -> dict:
    """Load the auth store from disk."""
    if not AUTH_FILE.exists():
        return {}
    try:
        return json.loads(AUTH_FILE.read_text())
    except (json.JSONDecodeError, OSError):
        return {}


def _save_store(store: dict) -> None:
    """Write the auth store to disk."""
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    AUTH_FILE.write_text(json.dumps(store, indent=2))
    # Restrict permissions to owner only
    try:
        AUTH_FILE.chmod(0o600)
    except OSError:
        pass


def save_tokens(
    server_url: str,
    access_token: str,
    refresh_token: str,
    expires_in: int,
    user: Optional[dict] = None,
) -> None:
    """Persist JWT tokens for a server."""
    store = _load_store()
    key = _normalise_url(server_url)
    store[key] = {
        "type": "jwt",
        "accessToken": access_token,
        "refreshToken": refresh_token,
        "expiresAt": int(time.time()) + expires_in - 30,  # 30s buffer
        "user": user,
    }
    _save_store(store)


def save_api_key(server_url: str, api_key: str) -> None:
    """Persist an API key for a server."""
    store = _load_store()
    key = _normalise_url(server_url)
    store[key] = {
        "type": "api_key",
        "apiKey": api_key,
    }
    _save_store(store)


def load_credentials(server_url: str) -> Optional[dict]:
    """Load stored credentials for a server. Returns None if not found."""
    store = _load_store()
    key = _normalise_url(server_url)
    return store.get(key)


def clear_credentials(server_url: str) -> bool:
    """Remove stored credentials for a server. Returns True if anything was removed."""
    store = _load_store()
    key = _normalise_url(server_url)
    if key in store:
        del store[key]
        _save_store(store)
        return True
    return False


def get_access_token(server_url: str) -> Optional[str]:
    """Get the current access token or API key.

    For JWT credentials, returns the access token if still valid.
    For API key credentials, returns the API key.
    Returns None if no credentials or tokens expired.
    """
    creds = load_credentials(server_url)
    if not creds:
        return None

    if creds["type"] == "api_key":
        return creds["apiKey"]

    if creds["type"] == "jwt":
        expires_at = creds.get("expiresAt", 0)
        if time.time() < expires_at:
            return creds.get("accessToken")
        # Token expired — caller should refresh
        return None

    return None


def needs_refresh(server_url: str) -> bool:
    """Check if JWT tokens exist but access token is expired."""
    creds = load_credentials(server_url)
    if not creds or creds["type"] != "jwt":
        return False
    expires_at = creds.get("expiresAt", 0)
    return time.time() >= expires_at and bool(creds.get("refreshToken"))


def get_refresh_token(server_url: str) -> Optional[str]:
    """Get the stored refresh token."""
    creds = load_credentials(server_url)
    if not creds or creds["type"] != "jwt":
        return None
    return creds.get("refreshToken")


def refresh_access_token(server_url: str) -> Optional[str]:
    """Attempt to refresh the access token using the stored refresh token.

    On success, saves new tokens and returns the new access token.
    On failure, returns None (caller should re-authenticate).
    """
    refresh_tok = get_refresh_token(server_url)
    if not refresh_tok:
        return None

    try:
        resp = httpx.post(
            f"{server_url.rstrip('/')}/v1/auth/refresh",
            json={"refreshToken": refresh_tok},
            timeout=15.0,
        )
        if resp.status_code != 200:
            # Refresh token invalid/expired — clear credentials
            clear_credentials(server_url)
            return None

        data = resp.json()
        save_tokens(
            server_url=server_url,
            access_token=data["accessToken"],
            refresh_token=data["refreshToken"],
            expires_in=data.get("expiresIn", 900),
            user=data.get("user"),
        )
        return data["accessToken"]
    except Exception:
        return None


def resolve_token(server_url: str) -> Optional[str]:
    """Get a valid access token, refreshing if needed.

    Returns an access token or API key string, or None if not authenticated.
    """
    token = get_access_token(server_url)
    if token:
        return token

    if needs_refresh(server_url):
        return refresh_access_token(server_url)

    return None


# ── Login flows (HTTP calls to auth endpoints) ─────────────────────


def login_with_password(server_url: str, email: str, password: str) -> dict:
    """Perform password login. Returns the server response dict.

    On success without TOTP: {accessToken, refreshToken, expiresIn, user, ...}
    On TOTP challenge: {requiresTOTP: True, pendingToken: "..."}
    On failure: raises httpx.HTTPStatusError
    """
    resp = httpx.post(
        f"{server_url.rstrip('/')}/v1/auth/login",
        json={"email": email, "password": password},
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


def login_with_totp(server_url: str, pending_token: str, code: str) -> dict:
    """Complete TOTP challenge. Returns token response dict."""
    resp = httpx.post(
        f"{server_url.rstrip('/')}/v1/auth/login/totp",
        json={"pendingToken": pending_token, "code": code},
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


def login_with_recovery(server_url: str, pending_token: str, code: str) -> dict:
    """Complete login with a recovery code. Returns token response dict."""
    resp = httpx.post(
        f"{server_url.rstrip('/')}/v1/auth/login/recovery",
        json={"pendingToken": pending_token, "code": code},
        timeout=15.0,
    )
    resp.raise_for_status()
    return resp.json()


def get_auth_status(server_url: str) -> dict:
    """Check the server's auth status (public endpoint)."""
    resp = httpx.get(
        f"{server_url.rstrip('/')}/v1/auth/status",
        timeout=10.0,
    )
    resp.raise_for_status()
    return resp.json()


def get_current_user(server_url: str, token: str) -> dict:
    """Fetch /v1/auth/me with the given token."""
    resp = httpx.get(
        f"{server_url.rstrip('/')}/v1/auth/me",
        headers={"Authorization": f"Bearer {token}"},
        timeout=10.0,
    )
    resp.raise_for_status()
    return resp.json()


def server_logout(server_url: str, access_token: str, refresh_token: str) -> bool:
    """Call the server logout endpoint to invalidate the refresh session."""
    try:
        resp = httpx.post(
            f"{server_url.rstrip('/')}/v1/auth/logout",
            json={"refreshToken": refresh_token},
            headers={"Authorization": f"Bearer {access_token}"},
            timeout=10.0,
        )
        return resp.status_code == 200
    except Exception:
        return False
