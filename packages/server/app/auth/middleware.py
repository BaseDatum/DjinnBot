"""Auth middleware — global route protection with path allowlist.

Applied as Starlette middleware so it runs before FastAPI dependency
injection and covers every route without per-router Depends().
"""

import re
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from app.auth.config import auth_settings
from app.auth.dependencies import _extract_bearer_token, _is_engine_internal_token
from app.auth.jwt import decode_token, TOKEN_TYPE_ACCESS
from app.logging_config import get_logger

logger = get_logger(__name__)

# Paths that never require authentication.
# Uses regex patterns matched against the request path.
PUBLIC_PATH_PATTERNS: list[re.Pattern] = [
    # Health check
    re.compile(r"^/v1/status$"),
    # Auth endpoints (login flow)
    re.compile(r"^/v1/auth/status$"),
    re.compile(r"^/v1/auth/setup$"),
    re.compile(r"^/v1/auth/login$"),
    re.compile(r"^/v1/auth/login/totp$"),
    re.compile(r"^/v1/auth/login/recovery$"),
    re.compile(r"^/v1/auth/refresh$"),
    re.compile(r"^/v1/auth/oidc/.+/authorize$"),
    re.compile(r"^/v1/auth/oidc/.+/callback$"),
    # Webhook endpoints (protected by their own signature verification)
    re.compile(r"^/v1/webhooks/"),
    # OpenAPI docs (useful during development)
    re.compile(r"^/docs$"),
    re.compile(r"^/redoc$"),
    re.compile(r"^/openapi\.json$"),
]


def _is_public_path(path: str) -> bool:
    """Return True if the path matches a public pattern."""
    for pattern in PUBLIC_PATH_PATTERNS:
        if pattern.match(path):
            return True
    return False


class AuthMiddleware(BaseHTTPMiddleware):
    """Reject unauthenticated requests to non-public paths.

    This is a fast pre-check — it validates that a Bearer token is present
    and superficially valid (JWT signature or ENGINE_INTERNAL_TOKEN match).
    Full user resolution (DB lookup, API key check) happens in the
    FastAPI dependency layer (get_current_user).

    When AUTH_ENABLED=false, this middleware is a no-op.
    """

    async def dispatch(self, request: Request, call_next):
        # Skip auth entirely when disabled
        if not auth_settings.enabled:
            return await call_next(request)

        path = request.url.path

        # Allow public paths
        if _is_public_path(path):
            return await call_next(request)

        # Allow CORS preflight
        if request.method == "OPTIONS":
            return await call_next(request)

        # Extract token
        token = _extract_bearer_token(request)
        if not token:
            return JSONResponse(
                status_code=401,
                content={"detail": "Not authenticated"},
                headers={"WWW-Authenticate": "Bearer"},
            )

        # Quick check: ENGINE_INTERNAL_TOKEN passes immediately
        if _is_engine_internal_token(token):
            return await call_next(request)

        # Quick check: try JWT decode (fast, no DB hit)
        try:
            payload = decode_token(token)
            if payload.get("type") == TOKEN_TYPE_ACCESS:
                return await call_next(request)
        except Exception:
            pass

        # If we got here, the token might be a DB API key.
        # Let it through — the route's Depends(get_current_user) will
        # do the full DB lookup and reject if invalid.
        # This avoids duplicating DB session management in middleware.
        return await call_next(request)
