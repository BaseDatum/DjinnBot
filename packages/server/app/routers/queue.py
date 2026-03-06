"""Queue and Pulse management endpoints."""
import os
import json
import yaml
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from typing import Literal
from datetime import datetime, timezone

from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()

AGENTS_DIR = os.getenv("AGENTS_DIR", "./agents")


# ============================================================================
# Pydantic Models
# ============================================================================

class QueueItem(BaseModel):
    id: str
    runId: str
    step: str
    priority: Literal["normal", "high", "urgent"] = "normal"
    queuedAt: int
    estimatedDuration: int | None = None


class QueueResponse(BaseModel):
    items: list[QueueItem]
    length: int


class QueueCancelRequest(BaseModel):
    itemId: str


class QueueCancelResponse(BaseModel):
    cancelled: bool


class QueueClearRequest(BaseModel):
    confirm: bool


class QueueClearResponse(BaseModel):
    cleared: int


class PulseConfig(BaseModel):
    enabled: bool = True
    intervalMs: int = 1800000  # 30 minutes
    timeoutMs: int = 60000  # 1 minute
    checks: dict = Field(default_factory=lambda: {
        "inbox": True,
        "consolidateMemories": True,
        "updateWorkspaceDocs": False,
        "cleanupStaleFiles": True,
        "postStatusSlack": False
    })


class PulseTriggerResponse(BaseModel):
    triggered: bool
    message: str
    result: dict | None = None  # Filled in after completion


# ============================================================================
# Queue Endpoints
# ============================================================================

@router.get("/{agent_id}/queue", response_model=QueueResponse)
async def get_agent_queue(agent_id: str):
    """Get current work queue for an agent."""
    logger.debug(f"get_agent_queue called for agent_id={agent_id}")
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")
    
    # Verify agent exists
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    
    queue_key = f"djinnbot:agent:{agent_id}:queue"
    
    try:
        # Get all items from the Redis list
        raw_items = await dependencies.redis_client.lrange(queue_key, 0, -1)
        
        items = []
        for raw in raw_items:
            try:
                item_data = json.loads(raw)
                items.append(QueueItem(**item_data))
            except (json.JSONDecodeError, ValueError) as e:
                logger.warning(f"Invalid queue item format in {queue_key}: {e}")
                continue
        
        return QueueResponse(items=items, length=len(items))
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to read queue: {str(e)}")


@router.post("/{agent_id}/queue/cancel", response_model=QueueCancelResponse)
async def cancel_queue_item(agent_id: str, req: QueueCancelRequest):
    """Cancel a specific queued item."""
    logger.debug(f"cancel_queue_item called for agent_id={agent_id}, itemId={req.itemId}")
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")
    
    # Verify agent exists
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    
    queue_key = f"djinnbot:agent:{agent_id}:queue"
    
    try:
        # Get all items from queue
        raw_items = await dependencies.redis_client.lrange(queue_key, 0, -1)
        
        # Find and remove the matching item
        cancelled = False
        for raw in raw_items:
            try:
                item_data = json.loads(raw)
                if item_data.get("id") == req.itemId:
                    # Remove this specific item from the list
                    # LREM key count value - removes 'count' occurrences of 'value'
                    await dependencies.redis_client.lrem(queue_key, 1, raw)
                    cancelled = True
                    logger.debug(f"Cancelled queue item {req.itemId} for agent_id={agent_id}")
                    break
            except json.JSONDecodeError:
                continue
        
        return QueueCancelResponse(cancelled=cancelled)
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to cancel queue item: {str(e)}")


@router.post("/{agent_id}/queue/clear", response_model=QueueClearResponse)
async def clear_agent_queue(agent_id: str, req: QueueClearRequest):
    """Clear entire queue for an agent."""
    logger.debug(f"clear_agent_queue called for agent_id={agent_id}")
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")
    
    # Verify agent exists
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    
    if not req.confirm:
        raise HTTPException(status_code=400, detail="Must set confirm=true to clear queue")
    
    queue_key = f"djinnbot:agent:{agent_id}:queue"
    
    try:
        # Get queue length before deleting
        length = await dependencies.redis_client.llen(queue_key)
        
        # Delete the entire list
        await dependencies.redis_client.delete(queue_key)
        
        logger.debug(f"Cleared {length} items from queue for agent_id={agent_id}")
        return QueueClearResponse(cleared=length)
    
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to clear queue: {str(e)}")


# ============================================================================
# Pulse Endpoints
# ============================================================================

@router.get("/{agent_id}/pulse/config", response_model=PulseConfig)
async def get_pulse_config(agent_id: str):
    """Get pulse configuration for an agent."""
    logger.debug(f"get_pulse_config called for agent_id={agent_id}")
    # Verify agent exists
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    
    config_path = os.path.join(agent_dir, "config.yml")
    
    # Default pulse config
    default_config = PulseConfig()
    
    # Try to read from config.yml
    if os.path.isfile(config_path):
        try:
            with open(config_path, 'r') as f:
                config_data = yaml.safe_load(f) or {}
            
            # Extract pulse config if it exists
            pulse_data = config_data.get("pulse", {})
            
            if pulse_data:
                # Merge with defaults
                return PulseConfig(
                    enabled=pulse_data.get("enabled", default_config.enabled),
                    intervalMs=pulse_data.get("intervalMs", default_config.intervalMs),
                    timeoutMs=pulse_data.get("timeoutMs", default_config.timeoutMs),
                    checks=pulse_data.get("checks", default_config.checks)
                )
        except Exception as e:
            logger.warning(f"Failed to read pulse config from {config_path}: {e}")
    
    return default_config


@router.put("/{agent_id}/pulse/config", response_model=PulseConfig)
async def update_pulse_config(agent_id: str, req: dict):
    """Update pulse configuration for an agent."""
    logger.debug(f"update_pulse_config called for agent_id={agent_id}, changes={list(req.keys())}")
    # Verify agent exists
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    
    config_path = os.path.join(agent_dir, "config.yml")
    
    # Load existing config or start fresh
    existing = {}
    if os.path.isfile(config_path):
        try:
            with open(config_path, 'r') as f:
                existing = yaml.safe_load(f) or {}
        except Exception as e:
            logger.warning(f"Failed to load existing config: {e}")
    
    # Get current pulse config or create default
    pulse_config = existing.get("pulse", {})
    
    # Merge updates - allow partial updates
    if "enabled" in req:
        pulse_config["enabled"] = req["enabled"]
    if "intervalMs" in req:
        pulse_config["intervalMs"] = req["intervalMs"]
    if "timeoutMs" in req:
        pulse_config["timeoutMs"] = req["timeoutMs"]
    if "checks" in req:
        # Merge checks instead of replacing entirely
        if "checks" not in pulse_config:
            pulse_config["checks"] = {}
        pulse_config["checks"].update(req["checks"])
    
    # Update the config
    existing["pulse"] = pulse_config
    
    # Write back to file
    try:
        with open(config_path, 'w') as f:
            yaml.dump(existing, f, default_flow_style=False)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config: {str(e)}")
    
    logger.debug(f"Updated pulse config for agent_id={agent_id}")
    # Return updated pulse config
    return PulseConfig(**pulse_config)


@router.post("/{agent_id}/pulse/trigger", response_model=PulseTriggerResponse)
async def trigger_pulse(agent_id: str):
    """Trigger an immediate pulse for an agent."""
    logger.debug(f"trigger_pulse called for agent_id={agent_id}")
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")
    
    # Verify agent exists
    agent_dir = os.path.join(AGENTS_DIR, agent_id)
    if not os.path.isdir(agent_dir):
        raise HTTPException(status_code=404, detail=f"Agent {agent_id} not found")
    
    try:
        # Queue a pulse job to Redis
        pulse_key = f"djinnbot:agent:{agent_id}:pulse:trigger"
        pulse_data = {
            "type": "PULSE_TRIGGERED",
            "agent_id": agent_id,
            "triggered_at": int(datetime.now(timezone.utc).timestamp() * 1000),
            "source": "api"
        }
        
        # Set with expiration (5 minutes) to prevent stale triggers
        await dependencies.redis_client.setex(
            pulse_key,
            300,  # 5 minutes TTL
            json.dumps(pulse_data)
        )
        
        # Also publish to the global events stream for immediate pickup
        event = {
            "type": "PULSE_TRIGGERED",
            "agentId": agent_id,
            "timestamp": pulse_data["triggered_at"],
            "source": "api"
        }
        await dependencies.redis_client.xadd(
            "djinnbot:events:global",
            {"data": json.dumps(event)}
        )
        
        logger.debug(f"Pulse triggered for agent_id={agent_id}")
        
        # Wait briefly and check for result
        import asyncio
        result = None
        result_key = f"djinnbot:agent:{agent_id}:pulse:result"
        
        for _ in range(10):  # Poll for up to 5 seconds
            await asyncio.sleep(0.5)
            result_data = await dependencies.redis_client.get(result_key)
            if result_data:
                result = json.loads(result_data)
                # Clear the result
                await dependencies.redis_client.delete(result_key)
                logger.debug(f"Pulse completed for agent_id={agent_id}")
                break
        
        return PulseTriggerResponse(
            triggered=True,
            message=f"Pulse {'completed' if result else 'triggered'} for agent {agent_id}",
            result=result
        )
    
    except Exception as e:
        raise HTTPException(
            status_code=500,
            detail=f"Failed to trigger pulse: {str(e)}"
        )
