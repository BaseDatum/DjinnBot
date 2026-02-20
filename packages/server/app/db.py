"""
DEPRECATED: Legacy database module.

This module provides backward compatibility during migration.
All new code should use:
- app.database.get_async_session (FastAPI dependency)
- app.models.* (SQLAlchemy ORM models)
- Alembic for schema changes

This module will be removed after full migration.
"""
import warnings
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession
from app.database import AsyncSessionLocal


@asynccontextmanager
async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    DEPRECATED: Use get_async_session dependency instead.
    
    This wrapper provides sqlite3.Row-like access for gradual migration.
    """
    warnings.warn(
        "get_db() is deprecated. Use Depends(get_async_session) instead.",
        DeprecationWarning,
        stacklevel=2
    )
    
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# init_db is fully deprecated
async def init_db():
    """REMOVED: Use Alembic migrations instead."""
    raise NotImplementedError(
        "init_db() has been removed. "
        "Run 'alembic upgrade head' to initialize the database."
    )