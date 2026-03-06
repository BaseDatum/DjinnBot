"""SQLAlchemy declarative base and mixins for DjinnBot models."""
from datetime import datetime
from typing import Optional
import uuid

from sqlalchemy import BigInteger, String, Text, Integer
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    """Base class for all SQLAlchemy models."""
    pass


class TimestampMixin:
    """Mixin for created_at/updated_at timestamps (milliseconds since epoch)."""
    
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class TimestampWithCompletedMixin(TimestampMixin):
    """Mixin for entities with optional completed_at."""
    
    completed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)


def generate_prefixed_id(prefix: str) -> str:
    """Generate a prefixed UUID like 'proj_abc123...'."""
    return f"{prefix}{uuid.uuid4().hex[:12]}"


class PrefixedIdMixin:
    """
    Mixin for entities with prefixed string IDs.
    
    Subclasses should set _id_prefix class attribute.
    """
    _id_prefix: str = ""
    
    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    
    @classmethod
    def generate_id(cls) -> str:
        return generate_prefixed_id(cls._id_prefix)


class AutoIncrementIdMixin:
    """Mixin for entities with auto-increment integer IDs."""
    
    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)


def now_ms() -> int:
    """Return current timestamp in milliseconds."""
    return int(datetime.utcnow().timestamp() * 1000)