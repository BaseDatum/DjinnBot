"""Database configuration with async SQLAlchemy and connection pooling."""
import os
from contextlib import asynccontextmanager
from typing import AsyncGenerator

from sqlalchemy.ext.asyncio import (
    AsyncSession,
    AsyncEngine,
    create_async_engine,
    async_sessionmaker,
)
from sqlalchemy.pool import StaticPool, QueuePool
from sqlalchemy import text

from app.models import Base
from app.logging_config import get_logger
logger = get_logger(__name__)

# Database URL from environment
# Supports both SQLite and PostgreSQL
# PostgreSQL: postgresql+asyncpg://user:pass@host:port/dbname
# SQLite: sqlite+aiosqlite:///path/to/db.db
DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://djinnbot:djinnbot@localhost:5432/djinnbot"
)

# Detect database type
IS_SQLITE = DATABASE_URL.startswith("sqlite")

# Create async engine with appropriate settings
if IS_SQLITE:
    # SQLite: use StaticPool (single connection)
    DATABASE_PATH = DATABASE_URL.replace("sqlite+aiosqlite:///", "")
    engine: AsyncEngine = create_async_engine(
        DATABASE_URL,
        echo=os.getenv("DATABASE_ECHO", "").lower() == "true",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
else:
    # PostgreSQL: use QueuePool with proper connection pooling
    engine: AsyncEngine = create_async_engine(
        DATABASE_URL,
        echo=os.getenv("DATABASE_ECHO", "").lower() == "true",
        pool_size=5,
        max_overflow=10,
        pool_timeout=30,
        pool_pre_ping=True,  # Verify connections are alive
    )

# Session factory
AsyncSessionLocal = async_sessionmaker(
    engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autocommit=False,
    autoflush=False,
)


async def init_db_engine() -> None:
    """
    Initialize the database engine.
    
    For SQLite: sets pragmas for WAL mode, foreign keys, etc.
    For PostgreSQL: verifies connection.
    """
    if IS_SQLITE:
        DATABASE_PATH = DATABASE_URL.replace("sqlite+aiosqlite:///", "")
        db_dir = os.path.dirname(DATABASE_PATH)
        if db_dir:
            os.makedirs(db_dir, exist_ok=True)
        
        async with engine.begin() as conn:
            await conn.execute(text("PRAGMA journal_mode=WAL"))
            await conn.execute(text("PRAGMA busy_timeout=5000"))
            await conn.execute(text("PRAGMA foreign_keys=ON"))
    else:
        # PostgreSQL: just verify connection
        async with engine.begin() as conn:
            await conn.execute(text("SELECT 1"))
        logger.info("Connected to PostgreSQL")


async def close_db_engine() -> None:
    """Close the database engine and all connections."""
    await engine.dispose()


async def get_async_session() -> AsyncGenerator[AsyncSession, None]:
    """
    FastAPI dependency that yields an async session.
    
    Usage:
        @router.get("/items")
        async def list_items(session: AsyncSession = Depends(get_async_session)):
            result = await session.execute(select(Item))
            return result.scalars().all()
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


# Legacy compatibility: context manager for gradual migration
@asynccontextmanager
async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
    """
    Context manager for async session (legacy compatibility).
    
    Use get_async_session dependency for new code.
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
