"""Shared utility functions."""
import os
import re
import uuid
import yaml
import json
from datetime import datetime, timezone

from app.logging_config import get_logger
logger = get_logger(__name__)


def gen_id(prefix: str = "") -> str:
    """Generate a short prefixed ID."""
    return f"{prefix}{uuid.uuid4().hex[:12]}"


def now_ms() -> int:
    """Get current timestamp in milliseconds (matching core engine)."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def load_pipeline(pipeline_id: str) -> dict | None:
    """Load a pipeline YAML by ID, returning the parsed content or None."""
    pipelines_dir = os.getenv("PIPELINES_DIR", "./pipelines")
    if not os.path.exists(pipelines_dir):
        return None
    for fname in os.listdir(pipelines_dir):
        if not fname.endswith(('.yml', '.yaml')):
            continue
        fpath = os.path.join(pipelines_dir, fname)
        try:
            with open(fpath, 'r') as f:
                content = yaml.safe_load(f)
                if content and content.get('id') == pipeline_id:
                    return content
        except Exception:
            continue
    return None


def validate_pipeline_exists(pipeline_id: str) -> bool:
    """Check if a pipeline YAML file exists with the given ID."""
    return load_pipeline(pipeline_id) is not None


def read_file(path: str) -> str | None:
    """Read a file's contents, returning None on failure."""
    try:
        if os.path.isfile(path):
            with open(path, "r", encoding="utf-8") as f:
                return f.read()
    except Exception:
        pass
    return None


def parse_frontmatter(content: str) -> tuple[dict, str]:
    """Parse YAML frontmatter from markdown content."""
    m = re.match(r'^---\n(.*?)\n---\n(.*)', content, re.DOTALL)
    if not m:
        return {}, content
    meta = {}
    for line in m.group(1).split('\n'):
        if ':' in line:
            k, v = line.split(':', 1)
            meta[k.strip()] = v.strip()
    return meta, m.group(2)


async def emit_lifecycle_event(event: dict):
    """Publish a lifecycle event to Redis pub/sub.
    
    Event should contain:
    - type: Event type (AGENT_STATE_CHANGED, AGENT_MESSAGE_RECEIVED, etc.)
    - agentId: Agent identifier
    - timestamp: Unix timestamp in milliseconds
    - Other event-specific fields
    
    Example:
        await emit_lifecycle_event({
            "type": "AGENT_STATE_CHANGED",
            "agentId": "agent_abc123",
            "fromState": "idle",
            "toState": "working",
            "timestamp": now_ms()
        })
    """
    from app import dependencies
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:events:lifecycle",
                json.dumps(event)
            )
        except Exception as e:
            # Log but don't fail - event emission is non-critical
            logger.error(f"Failed to publish event: {e}")
