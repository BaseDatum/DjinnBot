"""Tests for login, logout, and whoami CLI commands."""

import json
from unittest.mock import patch, MagicMock

import httpx
import pytest
import respx
from typer.testing import CliRunner

from djinnbot.main import app
from djinnbot import auth

runner = CliRunner()

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


@pytest.fixture(autouse=True)
def isolated_auth(tmp_path, monkeypatch):
    """Redirect auth storage to temp directory."""
    config_dir = tmp_path / ".config" / "djinnbot"
    auth_file = config_dir / "auth.json"
    monkeypatch.setattr(auth, "CONFIG_DIR", config_dir)
    monkeypatch.setattr(auth, "AUTH_FILE", auth_file)


# ═══════════════════════════════════════════════════════════════════════
#  djinn login
# ═══════════════════════════════════════════════════════════════════════


class TestLoginCommand:
    @respx.mock
    def test_login_api_key(self):
        respx.get(f"{SERVER}/v1/auth/me").mock(
            return_value=httpx.Response(200, json=SAMPLE_USER_ME)
        )
        result = runner.invoke(app, ["login", "--api-key", "djb_testkey"])
        assert result.exit_code == 0
        assert "Logged in as Tester" in result.output
        assert "(API key)" in result.output

        # Verify key was stored
        creds = auth.load_credentials(SERVER)
        assert creds["type"] == "api_key"
        assert creds["apiKey"] == "djb_testkey"

    @respx.mock
    def test_login_api_key_invalid(self):
        respx.get(f"{SERVER}/v1/auth/me").mock(
            return_value=httpx.Response(401, json={"detail": "Invalid token"})
        )
        result = runner.invoke(app, ["login", "--api-key", "djb_badkey"])
        assert result.exit_code == 1
        assert "API key validation failed" in result.output

    @respx.mock
    def test_login_interactive_success(self):
        respx.get(f"{SERVER}/v1/auth/status").mock(
            return_value=httpx.Response(
                200,
                json={"authEnabled": True, "setupComplete": True, "oidcProviders": []},
            )
        )
        respx.post(f"{SERVER}/v1/auth/login").mock(
            return_value=httpx.Response(200, json=SAMPLE_TOKENS)
        )

        result = runner.invoke(app, ["login"], input="test@example.com\npassword123\n")
        assert result.exit_code == 0
        assert "Logged in as Tester" in result.output

        # Verify tokens were stored
        creds = auth.load_credentials(SERVER)
        assert creds["type"] == "jwt"
        assert creds["accessToken"] == SAMPLE_TOKENS["accessToken"]

    @respx.mock
    def test_login_with_totp(self):
        respx.get(f"{SERVER}/v1/auth/status").mock(
            return_value=httpx.Response(
                200,
                json={"authEnabled": True, "setupComplete": True, "oidcProviders": []},
            )
        )
        respx.post(f"{SERVER}/v1/auth/login").mock(
            return_value=httpx.Response(
                200, json={"requiresTOTP": True, "pendingToken": "pending_xyz"}
            )
        )
        respx.post(f"{SERVER}/v1/auth/login/totp").mock(
            return_value=httpx.Response(200, json=SAMPLE_TOKENS)
        )

        result = runner.invoke(
            app, ["login"], input="test@example.com\npassword123\n123456\n"
        )
        assert result.exit_code == 0
        assert "Two-factor" in result.output
        assert "Logged in as Tester" in result.output

    @respx.mock
    def test_login_with_recovery_code(self):
        respx.get(f"{SERVER}/v1/auth/status").mock(
            return_value=httpx.Response(
                200,
                json={"authEnabled": True, "setupComplete": True, "oidcProviders": []},
            )
        )
        respx.post(f"{SERVER}/v1/auth/login").mock(
            return_value=httpx.Response(
                200, json={"requiresTOTP": True, "pendingToken": "pending_xyz"}
            )
        )
        recovery_response = {**SAMPLE_TOKENS, "remainingRecoveryCodes": 2}
        respx.post(f"{SERVER}/v1/auth/login/recovery").mock(
            return_value=httpx.Response(200, json=recovery_response)
        )

        result = runner.invoke(
            app, ["login"], input="test@example.com\npassword123\nr\nabcd-efgh\n"
        )
        assert result.exit_code == 0
        assert "Logged in as Tester" in result.output
        assert "only 2 recovery codes remaining" in result.output

    @respx.mock
    def test_login_bad_password(self):
        respx.get(f"{SERVER}/v1/auth/status").mock(
            return_value=httpx.Response(
                200,
                json={"authEnabled": True, "setupComplete": True, "oidcProviders": []},
            )
        )
        respx.post(f"{SERVER}/v1/auth/login").mock(
            return_value=httpx.Response(
                401, json={"detail": "Invalid email or password"}
            )
        )

        result = runner.invoke(app, ["login"], input="test@example.com\nwrongpass\n")
        assert result.exit_code == 1
        assert "Login failed" in result.output

    @respx.mock
    def test_login_auth_disabled(self):
        respx.get(f"{SERVER}/v1/auth/status").mock(
            return_value=httpx.Response(
                200,
                json={
                    "authEnabled": False,
                    "setupComplete": True,
                    "oidcProviders": [],
                },
            )
        )

        result = runner.invoke(app, ["login"])
        assert result.exit_code == 0
        assert "not enabled" in result.output

    @respx.mock
    def test_login_setup_not_complete(self):
        respx.get(f"{SERVER}/v1/auth/status").mock(
            return_value=httpx.Response(
                200,
                json={
                    "authEnabled": True,
                    "setupComplete": False,
                    "oidcProviders": [],
                },
            )
        )

        result = runner.invoke(app, ["login"])
        assert result.exit_code == 1
        assert (
            "setup not complete" in result.output.lower()
            or "no users exist" in result.output.lower()
        )

    @respx.mock
    def test_login_server_unreachable(self):
        respx.get(f"{SERVER}/v1/auth/status").mock(
            side_effect=httpx.ConnectError("Connection refused")
        )

        result = runner.invoke(app, ["login"])
        assert result.exit_code == 1
        assert "Cannot reach server" in result.output


# ═══════════════════════════════════════════════════════════════════════
#  djinn logout
# ═══════════════════════════════════════════════════════════════════════


class TestLogoutCommand:
    @respx.mock
    def test_logout_jwt(self):
        auth.save_tokens(
            SERVER, "access_tok", "refresh_tok", 3600, {"email": "a@b.com"}
        )

        respx.post(f"{SERVER}/v1/auth/logout").mock(
            return_value=httpx.Response(200, json={"status": "ok"})
        )

        result = runner.invoke(app, ["logout"])
        assert result.exit_code == 0
        assert "Logged out" in result.output
        assert auth.load_credentials(SERVER) is None

    def test_logout_api_key(self):
        auth.save_api_key(SERVER, "djb_testkey")

        result = runner.invoke(app, ["logout"])
        assert result.exit_code == 0
        assert "Logged out" in result.output
        assert auth.load_credentials(SERVER) is None

    def test_logout_not_logged_in(self):
        result = runner.invoke(app, ["logout"])
        assert result.exit_code == 0
        assert "Not logged in" in result.output


# ═══════════════════════════════════════════════════════════════════════
#  djinn whoami
# ═══════════════════════════════════════════════════════════════════════


class TestWhoamiCommand:
    @respx.mock
    def test_whoami_jwt(self):
        auth.save_tokens(SERVER, "access_tok", "refresh_tok", 3600)

        respx.get(f"{SERVER}/v1/auth/me").mock(
            return_value=httpx.Response(200, json=SAMPLE_USER_ME)
        )

        result = runner.invoke(app, ["whoami"])
        assert result.exit_code == 0
        assert "Tester" in result.output
        assert "test@example.com" in result.output

    @respx.mock
    def test_whoami_api_key(self):
        auth.save_api_key(SERVER, "djb_testkey")

        respx.get(f"{SERVER}/v1/auth/me").mock(
            return_value=httpx.Response(200, json=SAMPLE_USER_ME)
        )

        result = runner.invoke(app, ["whoami"])
        assert result.exit_code == 0
        assert "Tester" in result.output

    def test_whoami_not_logged_in(self):
        result = runner.invoke(app, ["whoami"])
        assert result.exit_code == 1
        assert "Not logged in" in result.output

    @respx.mock
    def test_whoami_expired_session(self):
        auth.save_tokens(SERVER, "old_access", "old_refresh", -100)

        # Refresh also fails
        respx.post(f"{SERVER}/v1/auth/refresh").mock(
            return_value=httpx.Response(401, json={"detail": "expired"})
        )

        result = runner.invoke(app, ["whoami"])
        assert result.exit_code == 1
        assert "Not logged in" in result.output

    @respx.mock
    def test_whoami_with_totp(self):
        auth.save_api_key(SERVER, "djb_key")

        user_with_totp = {**SAMPLE_USER_ME, "totpEnabled": True}
        respx.get(f"{SERVER}/v1/auth/me").mock(
            return_value=httpx.Response(200, json=user_with_totp)
        )

        result = runner.invoke(app, ["whoami"])
        assert result.exit_code == 0
        assert "2FA" in result.output


# ═══════════════════════════════════════════════════════════════════════
#  --api-key global flag
# ═══════════════════════════════════════════════════════════════════════


class TestGlobalApiKeyFlag:
    @respx.mock(base_url=SERVER)
    def test_api_key_flag_used_for_requests(self, mock_api):
        route = mock_api.get("/v1/status").mock(
            return_value=httpx.Response(
                200, json={"status": "ok", "version": "1.0", "redis_connected": True}
            )
        )

        result = runner.invoke(app, ["--api-key", "djb_flagkey", "status"])
        assert result.exit_code == 0

        # Verify the Authorization header was sent
        request = route.calls[0].request
        assert request.headers["authorization"] == "Bearer djb_flagkey"

    @respx.mock(base_url=SERVER)
    def test_env_api_key_used(self, mock_api, monkeypatch):
        monkeypatch.setenv("DJINNBOT_API_KEY", "djb_envkey")

        route = mock_api.get("/v1/status").mock(
            return_value=httpx.Response(
                200, json={"status": "ok", "version": "1.0", "redis_connected": True}
            )
        )

        result = runner.invoke(app, ["status"])
        assert result.exit_code == 0

        request = route.calls[0].request
        assert request.headers["authorization"] == "Bearer djb_envkey"
