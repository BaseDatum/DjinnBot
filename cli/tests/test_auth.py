"""Tests for the auth module — credential storage, token management, login flows."""

import json
import time
from pathlib import Path
from unittest.mock import patch, MagicMock

import httpx
import pytest
import respx

from djinnbot import auth


# ── Fixtures ────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def isolated_auth_file(tmp_path, monkeypatch):
    """Redirect auth storage to a temp directory for every test."""
    config_dir = tmp_path / ".config" / "djinnbot"
    auth_file = config_dir / "auth.json"
    monkeypatch.setattr(auth, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(auth, "AUTH_FILE", auth_file)
    return auth_file


SERVER = "http://localhost:8000"

SAMPLE_TOKENS = {
    "accessToken": "eyJ.access.tok",
    "refreshToken": "rt_abc123",
    "tokenType": "Bearer",
    "expiresIn": 900,
    "user": {
        "id": "usr_abc",
        "email": "test@example.com",
        "displayName": "Tester",
        "isAdmin": True,
        "totpEnabled": False,
    },
}

SAMPLE_USER_ME = {
    "id": "usr_abc",
    "email": "test@example.com",
    "displayName": "Tester",
    "isAdmin": True,
    "isService": False,
    "totpEnabled": False,
}


# ═══════════════════════════════════════════════════════════════════════
#  Credential storage
# ═══════════════════════════════════════════════════════════════════════


class TestCredentialStorage:
    def test_save_and_load_jwt(self):
        auth.save_tokens(SERVER, "access", "refresh", 900, {"email": "a@b.com"})
        creds = auth.load_credentials(SERVER)
        assert creds is not None
        assert creds["type"] == "jwt"
        assert creds["accessToken"] == "access"
        assert creds["refreshToken"] == "refresh"
        assert creds["user"]["email"] == "a@b.com"

    def test_save_and_load_api_key(self):
        auth.save_api_key(SERVER, "djb_testkey123")
        creds = auth.load_credentials(SERVER)
        assert creds is not None
        assert creds["type"] == "api_key"
        assert creds["apiKey"] == "djb_testkey123"

    def test_clear_credentials(self):
        auth.save_api_key(SERVER, "djb_testkey123")
        assert auth.clear_credentials(SERVER) is True
        assert auth.load_credentials(SERVER) is None

    def test_clear_nonexistent(self):
        assert auth.clear_credentials(SERVER) is False

    def test_load_nonexistent(self):
        assert auth.load_credentials(SERVER) is None

    def test_url_normalisation(self):
        auth.save_api_key("http://LOCALHOST:8000/", "key1")
        creds = auth.load_credentials("http://localhost:8000")
        assert creds is not None
        assert creds["apiKey"] == "key1"

    def test_multiple_servers(self):
        auth.save_api_key("http://server1:8000", "key1")
        auth.save_api_key("http://server2:8000", "key2")
        assert auth.load_credentials("http://server1:8000")["apiKey"] == "key1"
        assert auth.load_credentials("http://server2:8000")["apiKey"] == "key2"

    def test_overwrite_credentials(self):
        auth.save_api_key(SERVER, "old_key")
        auth.save_api_key(SERVER, "new_key")
        creds = auth.load_credentials(SERVER)
        assert creds["apiKey"] == "new_key"

    def test_corrupt_file_handled(self, isolated_auth_file):
        isolated_auth_file.parent.mkdir(parents=True, exist_ok=True)
        isolated_auth_file.write_text("not json {{{")
        assert auth.load_credentials(SERVER) is None


# ═══════════════════════════════════════════════════════════════════════
#  Token resolution
# ═══════════════════════════════════════════════════════════════════════


class TestTokenResolution:
    def test_get_access_token_api_key(self):
        auth.save_api_key(SERVER, "djb_mykey")
        assert auth.get_access_token(SERVER) == "djb_mykey"

    def test_get_access_token_jwt_valid(self):
        auth.save_tokens(SERVER, "valid_access", "refresh", 3600)
        assert auth.get_access_token(SERVER) == "valid_access"

    def test_get_access_token_jwt_expired(self):
        auth.save_tokens(SERVER, "old_access", "refresh", -100)
        assert auth.get_access_token(SERVER) is None

    def test_needs_refresh_jwt_expired(self):
        auth.save_tokens(SERVER, "old_access", "refresh", -100)
        assert auth.needs_refresh(SERVER) is True

    def test_needs_refresh_jwt_valid(self):
        auth.save_tokens(SERVER, "access", "refresh", 3600)
        assert auth.needs_refresh(SERVER) is False

    def test_needs_refresh_api_key(self):
        auth.save_api_key(SERVER, "djb_key")
        assert auth.needs_refresh(SERVER) is False

    def test_needs_refresh_no_creds(self):
        assert auth.needs_refresh(SERVER) is False

    def test_get_refresh_token(self):
        auth.save_tokens(SERVER, "access", "my_refresh", 3600)
        assert auth.get_refresh_token(SERVER) == "my_refresh"

    def test_get_refresh_token_api_key(self):
        auth.save_api_key(SERVER, "djb_key")
        assert auth.get_refresh_token(SERVER) is None


class TestRefreshAccessToken:
    @respx.mock
    def test_refresh_success(self):
        auth.save_tokens(SERVER, "old_access", "old_refresh", -100)

        respx.post(f"{SERVER}/v1/auth/refresh").mock(
            return_value=httpx.Response(200, json=SAMPLE_TOKENS)
        )

        new_token = auth.refresh_access_token(SERVER)
        assert new_token == SAMPLE_TOKENS["accessToken"]

        # Verify new tokens were saved
        creds = auth.load_credentials(SERVER)
        assert creds["accessToken"] == SAMPLE_TOKENS["accessToken"]
        assert creds["refreshToken"] == SAMPLE_TOKENS["refreshToken"]

    @respx.mock
    def test_refresh_failure_clears_creds(self):
        auth.save_tokens(SERVER, "old_access", "old_refresh", -100)

        respx.post(f"{SERVER}/v1/auth/refresh").mock(
            return_value=httpx.Response(401, json={"detail": "Invalid refresh token"})
        )

        result = auth.refresh_access_token(SERVER)
        assert result is None
        assert auth.load_credentials(SERVER) is None  # Cleared

    def test_refresh_no_refresh_token(self):
        assert auth.refresh_access_token(SERVER) is None


class TestResolveToken:
    def test_resolve_api_key(self):
        auth.save_api_key(SERVER, "djb_key")
        assert auth.resolve_token(SERVER) == "djb_key"

    def test_resolve_valid_jwt(self):
        auth.save_tokens(SERVER, "valid_access", "refresh", 3600)
        assert auth.resolve_token(SERVER) == "valid_access"

    @respx.mock
    def test_resolve_expired_jwt_refreshes(self):
        auth.save_tokens(SERVER, "old_access", "old_refresh", -100)

        respx.post(f"{SERVER}/v1/auth/refresh").mock(
            return_value=httpx.Response(200, json=SAMPLE_TOKENS)
        )

        token = auth.resolve_token(SERVER)
        assert token == SAMPLE_TOKENS["accessToken"]

    def test_resolve_no_creds(self):
        assert auth.resolve_token(SERVER) is None


# ═══════════════════════════════════════════════════════════════════════
#  Login HTTP flows
# ═══════════════════════════════════════════════════════════════════════


class TestLoginFlows:
    @respx.mock
    def test_login_with_password_success(self):
        respx.post(f"{SERVER}/v1/auth/login").mock(
            return_value=httpx.Response(200, json=SAMPLE_TOKENS)
        )
        result = auth.login_with_password(SERVER, "test@example.com", "password123")
        assert result["accessToken"] == SAMPLE_TOKENS["accessToken"]

    @respx.mock
    def test_login_with_password_totp_challenge(self):
        totp_resp = {"requiresTOTP": True, "pendingToken": "pending_xyz"}
        respx.post(f"{SERVER}/v1/auth/login").mock(
            return_value=httpx.Response(200, json=totp_resp)
        )
        result = auth.login_with_password(SERVER, "test@example.com", "password123")
        assert result["requiresTOTP"] is True
        assert result["pendingToken"] == "pending_xyz"

    @respx.mock
    def test_login_with_password_bad_creds(self):
        respx.post(f"{SERVER}/v1/auth/login").mock(
            return_value=httpx.Response(
                401, json={"detail": "Invalid email or password"}
            )
        )
        with pytest.raises(httpx.HTTPStatusError):
            auth.login_with_password(SERVER, "bad@example.com", "wrong")

    @respx.mock
    def test_login_with_totp_success(self):
        respx.post(f"{SERVER}/v1/auth/login/totp").mock(
            return_value=httpx.Response(200, json=SAMPLE_TOKENS)
        )
        result = auth.login_with_totp(SERVER, "pending_xyz", "123456")
        assert result["accessToken"] == SAMPLE_TOKENS["accessToken"]

    @respx.mock
    def test_login_with_totp_bad_code(self):
        respx.post(f"{SERVER}/v1/auth/login/totp").mock(
            return_value=httpx.Response(401, json={"detail": "Invalid TOTP code"})
        )
        with pytest.raises(httpx.HTTPStatusError):
            auth.login_with_totp(SERVER, "pending_xyz", "000000")

    @respx.mock
    def test_login_with_recovery_success(self):
        resp = {**SAMPLE_TOKENS, "remainingRecoveryCodes": 5}
        respx.post(f"{SERVER}/v1/auth/login/recovery").mock(
            return_value=httpx.Response(200, json=resp)
        )
        result = auth.login_with_recovery(SERVER, "pending_xyz", "abcd-efgh")
        assert result["remainingRecoveryCodes"] == 5

    @respx.mock
    def test_get_auth_status(self):
        status = {"authEnabled": True, "setupComplete": True, "oidcProviders": []}
        respx.get(f"{SERVER}/v1/auth/status").mock(
            return_value=httpx.Response(200, json=status)
        )
        result = auth.get_auth_status(SERVER)
        assert result["authEnabled"] is True

    @respx.mock
    def test_get_current_user(self):
        respx.get(f"{SERVER}/v1/auth/me").mock(
            return_value=httpx.Response(200, json=SAMPLE_USER_ME)
        )
        result = auth.get_current_user(SERVER, "my_token")
        assert result["email"] == "test@example.com"

    @respx.mock
    def test_server_logout_success(self):
        respx.post(f"{SERVER}/v1/auth/logout").mock(
            return_value=httpx.Response(200, json={"status": "ok"})
        )
        assert auth.server_logout(SERVER, "access", "refresh") is True

    @respx.mock
    def test_server_logout_failure(self):
        respx.post(f"{SERVER}/v1/auth/logout").mock(
            return_value=httpx.Response(401, json={"detail": "Invalid"})
        )
        assert auth.server_logout(SERVER, "access", "refresh") is False


# ═══════════════════════════════════════════════════════════════════════
#  Client auth integration
# ═══════════════════════════════════════════════════════════════════════


class TestClientAuth:
    def test_client_sends_auth_header(self):
        from djinnbot.client import DjinnBotClient

        client = DjinnBotClient(base_url=SERVER, token="my_token")
        headers = client._build_headers()
        assert headers["Authorization"] == "Bearer my_token"

    def test_client_no_auth_header_without_token(self):
        from djinnbot.client import DjinnBotClient

        client = DjinnBotClient(base_url=SERVER)
        headers = client._build_headers()
        assert "Authorization" not in headers

    def test_client_token_setter_recreates_client(self):
        from djinnbot.client import DjinnBotClient

        client = DjinnBotClient(base_url=SERVER, token="old")
        _ = client.client  # Force lazy init
        assert client._client is not None

        client.token = "new"
        assert client._client is None  # Old client was closed
        assert client._token == "new"

    @respx.mock(base_url=SERVER)
    def test_client_request_includes_bearer(self, mock_api):
        from djinnbot.client import DjinnBotClient

        route = mock_api.get("/v1/status").mock(
            return_value=httpx.Response(200, json={"status": "ok"})
        )

        client = DjinnBotClient(base_url=SERVER, token="test_token")
        client.get_status()

        request = route.calls[0].request
        assert request.headers["authorization"] == "Bearer test_token"
