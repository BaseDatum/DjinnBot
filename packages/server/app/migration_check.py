"""Database migration verification utilities."""
import os
import sys
import subprocess
from pathlib import Path

from app.logging_config import get_logger

logger = get_logger(__name__)


def get_alembic_dir() -> Path:
    """Get path to alembic directory."""
    return Path(__file__).parent.parent


def ensure_migrations() -> None:
    """
    Ensure migrations are applied by running alembic upgrade head.
    
    Uses subprocess to avoid async issues in FastAPI lifespan.
    """
    alembic_dir = get_alembic_dir()
    
    # Check if AUTO_MIGRATE is disabled
    if os.getenv("AUTO_MIGRATE", "true").lower() == "false":
        logger.info("AUTO_MIGRATE=false, skipping migration check")
        return

    logger.info("Running database migrations...")
    
    try:
        result = subprocess.run(
            ["alembic", "upgrade", "head"],
            cwd=alembic_dir,
            capture_output=True,
            text=True,
            timeout=60,
        )
        
        if result.returncode != 0:
            logger.error(f"Migration failed: {result.stderr}")
            if os.getenv("REQUIRE_MIGRATIONS", "true").lower() == "true":
                sys.exit(1)
        else:
            # Parse output for useful info
            for line in result.stdout.splitlines():
                if line.strip():
                    logger.info(f"  {line}")
            logger.info("Migrations complete")
            
    except subprocess.TimeoutExpired:
        logger.error("Migration timed out after 60s")
        sys.exit(1)
    except FileNotFoundError:
        logger.warning("alembic not found - skipping migrations")
