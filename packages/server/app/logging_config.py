"""
Centralized logging configuration for the djinnbot server package.

Format: LEVEL: timestamp : package.file.function.lineno : log-line
Example: INFO: 2024-02-17 13:01:23 : server.routers.runs.create_run.42 : Creating new run

Usage:
    from app.logging_config import get_logger
    logger = get_logger(__name__)
    logger.info("Something happened")
"""

import logging
import os
import sys
from datetime import datetime, timezone
from typing import Optional


class DjinnbotFormatter(logging.Formatter):
    """
    Custom formatter producing:
    LEVEL: timestamp : package.file.function.lineno : message

    The package prefix is normalized to 'server.X' for app modules.
    """

    def format(self, record: logging.LogRecord) -> str:
        # Timestamp in ISO format (UTC)
        timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

        # Normalize module name: app.routers.runs -> server.routers.runs
        module = record.name
        if module.startswith("app."):
            module = "server." + module[4:]
        elif module == "app":
            module = "server"
        elif not module.startswith("server"):
            # External modules keep their name
            pass

        # Extract just the filename without extension
        filename = record.filename
        if filename.endswith(".py"):
            filename = filename[:-3]

        # Build location: module.function.lineno
        # If module already ends with filename, don't duplicate
        if module.endswith(f".{filename}"):
            location = f"{module}.{record.funcName}.{record.lineno}"
        else:
            location = f"{module}.{filename}.{record.funcName}.{record.lineno}"

        # Format: LEVEL: timestamp : location : message
        return f"{record.levelname}: {timestamp} : {location} : {record.getMessage()}"


def setup_logging(level: Optional[int] = None, stream: Optional[object] = None) -> None:
    """
    Configure root logging for the entire server package.

    Call this once at application startup (e.g., in main.py lifespan).

    Args:
        level: Logging level (default: from LOG_LEVEL env var, fallback INFO)
        stream: Output stream (default: sys.stdout)
    """
    if level is None:
        env_level = os.getenv("LOG_LEVEL", "INFO").upper()
        level = getattr(logging, env_level, logging.INFO)
    if stream is None:
        stream = sys.stdout

    # Create handler with our custom formatter
    handler = logging.StreamHandler(stream)
    handler.setFormatter(DjinnbotFormatter())

    # Configure root logger
    root_logger = logging.getLogger()
    root_logger.setLevel(level)

    # Remove existing handlers to avoid duplicates
    root_logger.handlers.clear()
    root_logger.addHandler(handler)

    # Also configure the 'app' logger hierarchy
    app_logger = logging.getLogger("app")
    app_logger.setLevel(level)
    # Propagate to root (don't add separate handler)
    app_logger.propagate = True

    # Suppress noisy third-party loggers
    logging.getLogger("uvicorn.access").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


def get_logger(name: str) -> logging.Logger:
    """
    Get a logger for a module.

    Args:
        name: Typically __name__ from the calling module

    Returns:
        Configured logger instance

    Example:
        from app.logging_config import get_logger
        logger = get_logger(__name__)
        logger.info("Processing request")
    """
    return logging.getLogger(name)
