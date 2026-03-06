"""FastAPI dependencies for DjinnBot API."""
from typing import AsyncGenerator

import redis.asyncio as redis
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import AsyncSessionLocal, get_async_session

# Global Redis client (initialized in main.py lifespan)
redis_client: redis.Redis | None = None


def get_redis() -> redis.Redis:
    """
    FastAPI dependency that returns the Redis client.
    
    Raises HTTPException 503 if Redis is not connected.
    """
    if redis_client is None:
        raise HTTPException(status_code=503, detail="Redis not connected")
    return redis_client