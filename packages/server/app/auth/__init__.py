"""Authentication module for DjinnBot API."""

from app.auth.config import auth_settings
from app.auth.dependencies import (
    get_current_user,
    get_current_admin,
    get_service_or_user,
    AuthUser,
)

__all__ = [
    "auth_settings",
    "get_current_user",
    "get_current_admin",
    "get_service_or_user",
    "AuthUser",
]
