"""Agent inbox endpoints for inter-agent messaging.

Uses Redis Streams (XADD/XRANGE) to match the core engine's AgentInbox implementation.
"""
import json
import time
from typing import Literal
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app import dependencies
from app.logging_config import get_logger
from app.utils import emit_lifecycle_event, now_ms

logger = get_logger(__name__)

router = APIRouter()


class SendMessageRequest(BaseModel):
    from_: str = Field(alias="from")
    fromAgentId: str | None = None
    type: Literal["info", "review_request", "help_request", "urgent", "work_assignment"] = "info"
    priority: Literal["normal", "high", "urgent"] = "normal"
    subject: str | None = None
    body: str
    runContext: str | None = None
    stepContext: str | None = None


class MarkReadRequest(BaseModel):
    messageIds: list[str]


class ClearInboxRequest(BaseModel):
    confirm: bool


class Message(BaseModel):
    id: str
    from_: str = Field(alias="from")
    fromAgentId: str | None = None
    type: Literal["info", "review_request", "help_request", "urgent", "work_assignment"]
    priority: Literal["normal", "high", "urgent"]
    subject: str | None = None
    body: str
    runContext: str | None = None
    stepContext: str | None = None
    timestamp: int
    read: bool
    readAt: int | None = None


def _get_inbox_key(agent_id: str) -> str:
    """Get Redis stream key for agent's inbox."""
    return f"djinnbot:agent:{agent_id}:inbox"


def _get_last_read_key(agent_id: str) -> str:
    """Get Redis key for agent's last read message ID."""
    return f"djinnbot:agent:{agent_id}:inbox:last_read"


def _ensure_redis():
    """Ensure Redis client is available."""
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not available")


def _parse_stream_message(msg_id: str, fields: dict, agent_id: str) -> dict:
    """Parse a Redis stream message into our message format."""
    # Fields come as dict from aioredis/redis-py
    return {
        "id": msg_id,
        "from": fields.get(b"from", fields.get("from", b"")).decode() if isinstance(fields.get(b"from", fields.get("from", "")), bytes) else fields.get("from", ""),
        "fromAgentId": (fields.get(b"fromAgentId", fields.get("fromAgentId", b"")).decode() if isinstance(fields.get(b"fromAgentId", fields.get("fromAgentId", "")), bytes) else fields.get("fromAgentId")) or None,
        "to": agent_id,
        "message": fields.get(b"message", fields.get("message", b"")).decode() if isinstance(fields.get(b"message", fields.get("message", "")), bytes) else fields.get("message", ""),
        "body": fields.get(b"message", fields.get("message", b"")).decode() if isinstance(fields.get(b"message", fields.get("message", "")), bytes) else fields.get("message", ""),
        "type": (fields.get(b"type", fields.get("type", b"info")).decode() if isinstance(fields.get(b"type", fields.get("type", "info")), bytes) else fields.get("type", "info")),
        "priority": (fields.get(b"priority", fields.get("priority", b"normal")).decode() if isinstance(fields.get(b"priority", fields.get("priority", "normal")), bytes) else fields.get("priority", "normal")),
        "subject": (fields.get(b"subject", fields.get("subject", b"")).decode() if isinstance(fields.get(b"subject", fields.get("subject", "")), bytes) else fields.get("subject")) or None,
        "timestamp": int(fields.get(b"timestamp", fields.get("timestamp", 0)).decode() if isinstance(fields.get(b"timestamp", fields.get("timestamp", 0)), bytes) else fields.get("timestamp", 0)),
        "read": False,  # Stream doesn't track read status per-message; use last_read key
        "readAt": None,
    }


def _parse_stream_message_simple(msg_id: str, fields: list, agent_id: str) -> dict:
    """Parse a Redis stream message from xrange format (list of key-value pairs)."""
    # Convert list to dict
    field_dict = {}
    if isinstance(fields, list):
        for i in range(0, len(fields), 2):
            key = fields[i].decode() if isinstance(fields[i], bytes) else fields[i]
            value = fields[i+1].decode() if isinstance(fields[i+1], bytes) else fields[i+1]
            field_dict[key] = value
    else:
        # Already a dict
        for k, v in fields.items():
            key = k.decode() if isinstance(k, bytes) else k
            value = v.decode() if isinstance(v, bytes) else v
            field_dict[key] = value
    
    return {
        "id": msg_id,
        "from": field_dict.get("from", ""),
        "fromAgentId": field_dict.get("fromAgentId") or None,
        "to": agent_id,
        "message": field_dict.get("message", ""),
        "body": field_dict.get("message", ""),
        "type": field_dict.get("type", "info"),
        "priority": field_dict.get("priority", "normal"),
        "subject": field_dict.get("subject") or None,
        "timestamp": int(field_dict.get("timestamp", 0)),
        "read": False,
        "readAt": None,
    }


async def _get_all_messages(agent_id: str) -> list[dict]:
    """Get all messages from the stream."""
    inbox_key = _get_inbox_key(agent_id)
    
    # XRANGE returns list of [id, fields] tuples
    results = await dependencies.redis_client.xrange(inbox_key, "-", "+")
    
    messages = []
    for item in results:
        msg_id = item[0]
        fields = item[1]
        messages.append(_parse_stream_message_simple(msg_id, fields, agent_id))
    
    return messages


async def _get_last_read_id(agent_id: str) -> str | None:
    """Get the ID of the last read message."""
    last_read_key = _get_last_read_key(agent_id)
    result = await dependencies.redis_client.get(last_read_key)
    if result:
        return result.decode() if isinstance(result, bytes) else result
    return None


async def _count_unread(agent_id: str) -> int:
    """Count unread messages (messages after last_read ID)."""
    last_read_id = await _get_last_read_id(agent_id)
    
    inbox_key = _get_inbox_key(agent_id)
    
    if last_read_id:
        # Get messages after last read
        # Increment the sequence to exclude the last read message itself
        parts = last_read_id.split("-")
        if len(parts) == 2:
            start_id = f"{parts[0]}-{int(parts[1]) + 1}"
        else:
            start_id = last_read_id
        results = await dependencies.redis_client.xrange(inbox_key, start_id, "+")
    else:
        # All messages are unread
        results = await dependencies.redis_client.xrange(inbox_key, "-", "+")
    
    return len(results)


@router.get("/{agent_id}/inbox")
async def get_inbox(
    agent_id: str,
    filter: Literal["all", "unread", "urgent", "review_request", "help_request"] = Query("all"),
    limit: int = Query(100, ge=1, le=1000),
    offset: int = Query(0, ge=0)
):
    """
    Fetch messages from agent inbox.
    
    Messages are stored in Redis Streams to match core engine's AgentInbox.
    """
    logger.debug(f"get_inbox entry: agent_id={agent_id}, filter={filter}, limit={limit}, offset={offset}")
    _ensure_redis()
    
    logger.debug(f"get_inbox: fetching all messages from Redis stream for agent_id={agent_id}")
    messages = await _get_all_messages(agent_id)
    logger.debug(f"get_inbox: retrieved {len(messages)} messages from stream")
    
    last_read_id = await _get_last_read_id(agent_id)
    
    # Mark messages as read/unread based on last_read_id
    for msg in messages:
        if last_read_id:
            msg["read"] = _compare_stream_ids(msg["id"], last_read_id) <= 0
        else:
            msg["read"] = False
    
    # Reverse to show newest first
    messages.reverse()
    
    # Apply filters
    filtered_messages = []
    for msg in messages:
        if filter == "unread" and msg.get("read", False):
            continue
        if filter == "urgent" and msg.get("priority") != "urgent":
            continue
        if filter == "review_request" and msg.get("type") != "review_request":
            continue
        if filter == "help_request" and msg.get("type") != "help_request":
            continue
        filtered_messages.append(msg)
    
    # Count unread
    unread_count = sum(1 for m in messages if not m.get("read", False))
    
    # Apply pagination
    total_count = len(filtered_messages)
    paginated_messages = filtered_messages[offset:offset + limit]
    has_more = (offset + limit) < total_count
    
    return {
        "messages": paginated_messages,
        "unreadCount": unread_count,
        "totalCount": total_count,
        "hasMore": has_more
    }


def _compare_stream_ids(id1: str, id2: str) -> int:
    """Compare two Redis stream IDs. Returns -1, 0, or 1."""
    parts1 = id1.split("-")
    parts2 = id2.split("-")
    
    if len(parts1) != 2 or len(parts2) != 2:
        return 0
    
    time1, seq1 = int(parts1[0]), int(parts1[1])
    time2, seq2 = int(parts2[0]), int(parts2[1])
    
    if time1 != time2:
        return 1 if time1 > time2 else -1
    if seq1 != seq2:
        return 1 if seq1 > seq2 else -1
    return 0


@router.post("/{agent_id}/inbox")
async def send_message(agent_id: str, req: SendMessageRequest):
    """
    Send a message to an agent's inbox.
    
    Uses Redis Streams (XADD) to match core engine's AgentInbox.send().
    """
    logger.debug(f"send_message entry: agent_id={agent_id}, from={req.from_}, type={req.type}, priority={req.priority}")
    _ensure_redis()
    
    inbox_key = _get_inbox_key(agent_id)
    now = now_ms()
    
    # Build stream fields matching core engine format
    fields = {
        "from": req.from_,
        "to": agent_id,
        "message": req.body,
        "priority": req.priority,
        "type": req.type,
        "timestamp": str(now),
    }
    
    # Add optional fields
    if req.fromAgentId:
        fields["fromAgentId"] = req.fromAgentId
    if req.subject:
        fields["subject"] = req.subject
    if req.runContext:
        fields["metadata_runContext"] = req.runContext
    if req.stepContext:
        fields["metadata_stepContext"] = req.stepContext
    
    # Add to stream (XADD returns the message ID)
    logger.debug(f"send_message: XADD to stream key={inbox_key}")
    msg_id = await dependencies.redis_client.xadd(inbox_key, fields)
    logger.debug(f"send_message: message added with id={msg_id}")
    
    # Emit lifecycle event
    unread_count = await _count_unread(agent_id)
    await emit_lifecycle_event({
        "type": "AGENT_MESSAGE_RECEIVED",
        "agentId": agent_id,
        "from": req.from_,
        "messageType": req.type,
        "priority": req.priority,
        "unreadCount": unread_count,
        "timestamp": now
    })
    
    return {
        "id": msg_id,
        "from": req.from_,
        "fromAgentId": req.fromAgentId,
        "to": agent_id,
        "type": req.type,
        "priority": req.priority,
        "subject": req.subject,
        "body": req.body,
        "message": req.body,
        "timestamp": now,
        "read": False,
        "readAt": None
    }


@router.post("/{agent_id}/inbox/mark-read")
async def mark_messages_read(agent_id: str, req: MarkReadRequest):
    """
    Mark messages as read by updating the last_read pointer.
    
    In stream-based inbox, we track the highest read message ID.
    """
    logger.debug(f"mark_messages_read entry: agent_id={agent_id}, message_count={len(req.messageIds)}")
    _ensure_redis()
    
    if not req.messageIds:
        return {"marked": 0}
    
    # Find the highest message ID to mark as last read
    highest_id = None
    for msg_id in req.messageIds:
        if highest_id is None or _compare_stream_ids(msg_id, highest_id) > 0:
            highest_id = msg_id
    
    if highest_id:
        last_read_key = _get_last_read_key(agent_id)
        logger.debug(f"mark_messages_read: getting current last_read for key={last_read_key}")
        current_last_read = await dependencies.redis_client.get(last_read_key)
        
        # Only update if new ID is higher
        if not current_last_read or _compare_stream_ids(highest_id, current_last_read.decode() if isinstance(current_last_read, bytes) else current_last_read) > 0:
            logger.debug(f"mark_messages_read: SET last_read key={last_read_key} to id={highest_id}")
            await dependencies.redis_client.set(last_read_key, highest_id)
    
    # Emit lifecycle event
    unread_count = await _count_unread(agent_id)
    await emit_lifecycle_event({
        "type": "AGENT_INBOX_READ",
        "agentId": agent_id,
        "messageIds": req.messageIds,
        "unreadCount": unread_count,
        "timestamp": now_ms()
    })
    
    return {"marked": len(req.messageIds), "unreadCount": unread_count}


@router.post("/{agent_id}/inbox/clear")
async def clear_inbox(agent_id: str, req: ClearInboxRequest):
    """
    Clear all messages from agent's inbox.
    """
    logger.debug(f"clear_inbox entry: agent_id={agent_id}")
    _ensure_redis()
    
    if not req.confirm:
        raise HTTPException(status_code=400, detail="Must confirm=true to clear inbox")
    
    inbox_key = _get_inbox_key(agent_id)
    last_read_key = _get_last_read_key(agent_id)
    
    # Delete the stream and last_read key
    logger.debug(f"clear_inbox: DELETE keys inbox={inbox_key}, last_read={last_read_key}")
    await dependencies.redis_client.delete(inbox_key)
    await dependencies.redis_client.delete(last_read_key)
    
    # Emit lifecycle event
    await emit_lifecycle_event({
        "type": "AGENT_INBOX_CLEARED",
        "agentId": agent_id,
        "timestamp": now_ms()
    })
    
    return {"cleared": True}


@router.get("/{agent_id}/inbox/{message_id}")
async def get_message(agent_id: str, message_id: str):
    """
    Get a specific message by ID.
    """
    logger.debug(f"get_message entry: agent_id={agent_id}, message_id={message_id}")
    _ensure_redis()
    
    inbox_key = _get_inbox_key(agent_id)
    
    # XRANGE with same start/end to get single message
    logger.debug(f"get_message: XRANGE stream={inbox_key} for message_id={message_id}")
    results = await dependencies.redis_client.xrange(inbox_key, message_id, message_id)
    
    if not results:
        raise HTTPException(status_code=404, detail=f"Message {message_id} not found")
    
    msg_id, fields = results[0]
    message = _parse_stream_message_simple(msg_id, fields, agent_id)
    
    # Check if read
    last_read_id = await _get_last_read_id(agent_id)
    if last_read_id:
        message["read"] = _compare_stream_ids(msg_id, last_read_id) <= 0
    
    return message
