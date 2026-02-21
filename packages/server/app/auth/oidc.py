"""Generic OIDC client — provider-agnostic OpenID Connect flows."""

import hashlib
import base64
import secrets
import json
from typing import Optional
from urllib.parse import urlencode

import httpx
import jwt as pyjwt
from jwt import PyJWKClient

from app.logging_config import get_logger

logger = get_logger(__name__)


class OIDCClient:
    """Handles a complete OIDC authorization code flow with PKCE."""

    def __init__(
        self,
        *,
        issuer_url: str,
        client_id: str,
        client_secret: str,
        scopes: str = "openid email profile",
        authorization_endpoint: Optional[str] = None,
        token_endpoint: Optional[str] = None,
        userinfo_endpoint: Optional[str] = None,
        jwks_uri: Optional[str] = None,
        auto_discovery: bool = True,
    ):
        self.issuer_url = issuer_url.rstrip("/")
        self.client_id = client_id
        self.client_secret = client_secret
        self.scopes = scopes
        self.authorization_endpoint = authorization_endpoint
        self.token_endpoint = token_endpoint
        self.userinfo_endpoint = userinfo_endpoint
        self.jwks_uri = jwks_uri
        self.auto_discovery = auto_discovery
        self._discovered = False

    async def discover(self) -> dict:
        """Fetch the .well-known/openid-configuration document.

        Populates endpoints from discovery if auto_discovery is enabled and
        individual endpoints were not explicitly provided.
        """
        url = f"{self.issuer_url}/.well-known/openid-configuration"
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            config = resp.json()

        if not self.authorization_endpoint:
            self.authorization_endpoint = config.get("authorization_endpoint")
        if not self.token_endpoint:
            self.token_endpoint = config.get("token_endpoint")
        if not self.userinfo_endpoint:
            self.userinfo_endpoint = config.get("userinfo_endpoint")
        if not self.jwks_uri:
            self.jwks_uri = config.get("jwks_uri")

        self._discovered = True
        return config

    async def ensure_discovered(self) -> None:
        """Run discovery if needed and not already done."""
        if self.auto_discovery and not self._discovered:
            await self.discover()

    @staticmethod
    def generate_pkce() -> tuple[str, str]:
        """Generate a PKCE code_verifier and code_challenge (S256).

        Returns (code_verifier, code_challenge).
        """
        code_verifier = secrets.token_urlsafe(64)
        digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
        code_challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
        return code_verifier, code_challenge

    async def get_authorization_url(
        self,
        redirect_uri: str,
        state: str,
        code_challenge: str,
        extra_params: Optional[dict] = None,
    ) -> str:
        """Build the authorization URL to redirect the user to.

        Args:
            redirect_uri: The callback URL on our server.
            state: Opaque state string for CSRF protection.
            code_challenge: PKCE S256 challenge.
            extra_params: Any additional query params.
        """
        await self.ensure_discovered()
        if not self.authorization_endpoint:
            raise ValueError(
                "authorization_endpoint not configured and discovery failed"
            )

        params = {
            "response_type": "code",
            "client_id": self.client_id,
            "redirect_uri": redirect_uri,
            "scope": self.scopes,
            "state": state,
            "code_challenge": code_challenge,
            "code_challenge_method": "S256",
        }
        if extra_params:
            params.update(extra_params)
        return f"{self.authorization_endpoint}?{urlencode(params)}"

    async def exchange_code(
        self,
        code: str,
        redirect_uri: str,
        code_verifier: str,
    ) -> dict:
        """Exchange an authorization code for tokens.

        Returns the raw token response dict (contains access_token, id_token, etc).
        """
        await self.ensure_discovered()
        if not self.token_endpoint:
            raise ValueError("token_endpoint not configured and discovery failed")

        data = {
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": redirect_uri,
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "code_verifier": code_verifier,
        }
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                self.token_endpoint,
                data=data,
                headers={"Accept": "application/json"},
            )
            resp.raise_for_status()
            return resp.json()

    async def fetch_userinfo(self, access_token: str) -> dict:
        """Fetch the user's profile from the userinfo endpoint."""
        await self.ensure_discovered()
        if not self.userinfo_endpoint:
            raise ValueError("userinfo_endpoint not configured and discovery failed")

        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                self.userinfo_endpoint,
                headers={"Authorization": f"Bearer {access_token}"},
            )
            resp.raise_for_status()
            return resp.json()

    async def decode_id_token(self, id_token: str) -> dict:
        """Decode and validate the OIDC id_token using the provider's JWKS.

        Returns the decoded claims dict.
        """
        await self.ensure_discovered()
        if not self.jwks_uri:
            raise ValueError("jwks_uri not configured and discovery failed")

        jwk_client = PyJWKClient(self.jwks_uri)
        signing_key = jwk_client.get_signing_key_from_jwt(id_token)

        return pyjwt.decode(
            id_token,
            signing_key.key,
            algorithms=["RS256", "RS384", "RS512", "ES256", "ES384", "ES512"],
            audience=self.client_id,
            issuer=self.issuer_url,
            options={"verify_exp": True},
        )


async def test_oidc_discovery(issuer_url: str) -> dict:
    """Test that an issuer URL has a valid .well-known/openid-configuration.

    Returns the discovery document on success.
    Raises on failure.
    """
    url = f"{issuer_url.rstrip('/')}/.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        config = resp.json()

    # Validate required fields
    required = ["authorization_endpoint", "token_endpoint", "issuer"]
    missing = [f for f in required if f not in config]
    if missing:
        raise ValueError(f"Discovery document missing required fields: {missing}")

    return config
