"""SSE streaming endpoints for real-time pipeline events."""

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from sse_starlette.sse import EventSourceResponse
import asyncio
import json

from app import dependencies

router = APIRouter()


@router.get("/stream/{run_id}")
async def stream_run_events(run_id: str):
    """SSE endpoint — streams pipeline events for a specific run.

    Connect via EventSource:
        const es = new EventSource('/api/events/stream/run_123');
        es.onmessage = (e) => console.log(JSON.parse(e.data));
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    stream_key = f"djinnbot:events:run:{run_id}"

    async def event_generator():
        last_id = "0"  # Start from beginning

        while True:
            try:
                # XREAD with BLOCK to wait for new messages
                # timeout of 5000ms (5s) so we can send heartbeats
                response = await dependencies.redis_client.xread(
                    {stream_key: last_id}, block=5000
                )

                if response:
                    # Process messages
                    for stream_name, messages in response:
                        for msg_id, fields in messages:
                            last_id = (
                                msg_id.decode() if isinstance(msg_id, bytes) else msg_id
                            )
                            data = fields.get(b"data") or fields.get("data", "{}")

                            if isinstance(data, bytes):
                                data = data.decode()

                            try:
                                event_data = json.loads(data)
                            except json.JSONDecodeError:
                                event_data = {"raw": data}

                            yield {
                                "event": "message",
                                "data": json.dumps(event_data),
                            }
                else:
                    # No messages, send heartbeat
                    yield {
                        "event": "heartbeat",
                        "data": json.dumps({"run_id": run_id, "status": "connected"}),
                    }

            except asyncio.CancelledError:
                raise
            except Exception as e:
                # On error, send heartbeat and continue
                yield {
                    "event": "heartbeat",
                    "data": json.dumps(
                        {"run_id": run_id, "status": "error", "error": str(e)}
                    ),
                }
                await asyncio.sleep(5)

    return EventSourceResponse(event_generator())


@router.get("/stream")
async def stream_all_events():
    """SSE endpoint — streams all pipeline events via the global events stream."""
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    stream_key = "djinnbot:events:global"

    async def event_generator():
        last_id = "0"

        while True:
            try:
                response = await dependencies.redis_client.xread(
                    {stream_key: last_id}, block=5000
                )

                if response:
                    for stream_name, messages in response:
                        for msg_id, fields in messages:
                            last_id = (
                                msg_id.decode() if isinstance(msg_id, bytes) else msg_id
                            )
                            data = fields.get(b"data") or fields.get("data", "{}")

                            if isinstance(data, bytes):
                                data = data.decode()

                            try:
                                event_data = json.loads(data)
                            except json.JSONDecodeError:
                                event_data = {"raw": data}

                            yield {
                                "event": "message",
                                "data": json.dumps(event_data),
                            }
                else:
                    yield {
                        "event": "heartbeat",
                        "data": json.dumps({"status": "connected"}),
                    }

            except asyncio.CancelledError:
                raise
            except Exception as e:
                yield {
                    "event": "heartbeat",
                    "data": json.dumps({"status": "error", "error": str(e)}),
                }
                await asyncio.sleep(5)

    return EventSourceResponse(event_generator())


# Agent Lifecycle Events Stream (B4)


async def lifecycle_event_generator():
    """Generate SSE events from Redis pub/sub for agent lifecycle events."""
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    pubsub = dependencies.redis_client.pubsub()
    await pubsub.subscribe("djinnbot:events:lifecycle")

    try:
        while True:
            try:
                message = await asyncio.wait_for(
                    pubsub.get_message(ignore_subscribe_messages=True, timeout=None),
                    timeout=20.0,
                )
                if message and message["type"] == "message":
                    data = message["data"]
                    if isinstance(data, bytes):
                        data = data.decode("utf-8")
                    yield f"data: {data}\n\n"
            except asyncio.TimeoutError:
                yield ": ping\n\n"

    except asyncio.CancelledError:
        await pubsub.unsubscribe("djinnbot:events:lifecycle")
        raise
    finally:
        await pubsub.close()


@router.get("/events")
async def sse_agent_events():
    """SSE endpoint for agent lifecycle events.

    Streams real-time agent state changes, messages, work queue updates, and pulse completions.
    Dashboard subscribes to this endpoint for live agent status updates.

    Event types:
    - AGENT_STATE_CHANGED: Agent state transitions
    - AGENT_MESSAGE_RECEIVED: New messages in agent inbox
    - AGENT_WORK_QUEUED: Work added to agent queue
    - AGENT_PULSE_COMPLETED: Health check/pulse cycle finished

    Test with: curl -N http://localhost:8000/api/agents/events
    """
    return StreamingResponse(
        lifecycle_event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/chat-sessions")
async def stream_all_chat_sessions():
    """SSE endpoint — streams chat session updates for ALL agents.

    Subscribes to Redis channel: djinnbot:chat:sessions:live
    Forwards all chat session events (status changes, deletions, etc.).

    Test with: curl -N http://localhost:8000/api/events/chat-sessions
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    channel = "djinnbot:chat:sessions:live"

    async def event_generator():
        pubsub = dependencies.redis_client.pubsub()
        await pubsub.subscribe(channel)

        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=None
                        ),
                        timeout=20.0,
                    )
                    if message and message["type"] == "message":
                        data_str = message["data"]
                        if isinstance(data_str, bytes):
                            data_str = data_str.decode()
                        yield f"data: {data_str}\n\n"
                    else:
                        yield ": heartbeat\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                except asyncio.CancelledError:
                    break
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/sessions")
async def stream_all_sessions():
    """SSE endpoint — streams session updates for ALL agents.

    Subscribes to Redis channel: djinnbot:sessions:live
    Does NOT filter by agent — all session events are forwarded.

    Use this on the dashboard to get a live merged view of all sessions.

    Test with: curl -N http://localhost:8000/api/events/sessions
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    channel = "djinnbot:sessions:live"

    async def event_generator():
        pubsub = dependencies.redis_client.pubsub()
        await pubsub.subscribe(channel)

        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=None
                        ),
                        timeout=20.0,
                    )
                    if message and message["type"] == "message":
                        data_str = message["data"]
                        if isinstance(data_str, bytes):
                            data_str = data_str.decode()
                        try:
                            data = json.loads(data_str)
                            yield f"data: {json.dumps(data)}\n\n"
                        except json.JSONDecodeError:
                            pass
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"

        except asyncio.CancelledError:
            raise
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/sessions/{agent_id}")
async def stream_agent_sessions(agent_id: str):
    """SSE endpoint — streams session updates for a specific agent.

    Subscribes to Redis channel: djinnbot:sessions:live
    Filters events to only include those for the specified agent_id.

    Events:
    - created: New session started
    - status: Session status changed
    - completed: Session finished successfully
    - failed: Session finished with error

    Test with: curl -N http://localhost:8000/api/events/sessions/agent_123
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    channel = "djinnbot:sessions:live"

    async def event_generator():
        pubsub = dependencies.redis_client.pubsub()
        await pubsub.subscribe(channel)

        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=None
                        ),
                        timeout=20.0,
                    )
                    if message and message["type"] == "message":
                        data_str = message["data"]
                        if isinstance(data_str, bytes):
                            data_str = data_str.decode()
                        try:
                            data = json.loads(data_str)
                            if data.get("agentId") == agent_id:
                                yield f"data: {json.dumps(data)}\n\n"
                        except json.JSONDecodeError:
                            pass
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"

        except asyncio.CancelledError:
            raise
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/sessions/{session_id}/events")
async def stream_session_events(
    session_id: str,
    since: str = Query(
        "0-0",
        description=(
            "Redis Stream ID to replay from (exclusive). "
            "Pass the last received stream_id on reconnect to catch up on "
            "events missed during a disconnect. Defaults to '0-0' (no replay)."
        ),
    ),
):
    """SSE endpoint — streams real-time events for a specific chat session.

    Two-phase delivery:
      1. Replay: XRANGE from the session's Redis Stream (djinnbot:sessions:{id}:stream)
         for any structural events (step_start/end, turn_end, tool_start/end, etc.)
         that arrived since `since`. This catches up a reconnecting client.
      2. Live: subscribe to the pub/sub channel (djinnbot:sessions:{id}) for
         real-time delivery of all events going forward.

    Uses StreamingResponse (not EventSourceResponse) with raw SSE string yields
    and get_message(timeout=None) so each message fetch genuinely suspends the
    coroutine — giving the asyncio event loop time to flush the TCP write buffer
    between tokens. This prevents burst delivery of queued messages.
    """
    import logging

    logger = logging.getLogger(__name__)
    logger.info(
        f"[SSE] Client connecting to chat session: {session_id} (since={since})"
    )

    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    channel = f"djinnbot:sessions:{session_id}"
    stream_key = f"{channel}:stream"

    async def event_generator():
        # ── Phase 1: replay missed structural events from the Redis Stream ──
        try:
            replay_start = since if since else "0-0"
            if "-" in replay_start:
                ms, seq = replay_start.rsplit("-", 1)
                try:
                    replay_start = f"{ms}-{int(seq) + 1}"
                except ValueError:
                    pass

            entries = await dependencies.redis_client.xrange(
                stream_key, replay_start, "+"
            )
            for entry_id, fields in entries:
                if isinstance(entry_id, bytes):
                    entry_id = entry_id.decode()
                data_str = fields.get(b"data") or fields.get("data", b"")
                if isinstance(data_str, bytes):
                    data_str = data_str.decode()
                try:
                    data = json.loads(data_str)
                    data["stream_id"] = entry_id
                    logger.debug(
                        f"[SSE] Replaying {data.get('type')} ({entry_id}) for {session_id}"
                    )
                    yield f"data: {json.dumps(data)}\n\n"
                except json.JSONDecodeError:
                    pass
        except Exception as e:
            logger.warning(f"[SSE] Stream replay failed for {session_id}: {e}")

        # ── Phase 2: live pub/sub for real-time events ──
        pubsub = dependencies.redis_client.pubsub()
        await pubsub.subscribe(channel)
        logger.info(f"[SSE] Subscribed to pub/sub channel: {channel}")

        # Send connection confirmation
        yield f"data: {json.dumps({'type': 'connected', 'session_id': session_id})}\n\n"

        HEARTBEAT_INTERVAL = 20.0

        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=None
                        ),
                        timeout=HEARTBEAT_INTERVAL,
                    )

                    if message and message["type"] == "message":
                        data_str = message["data"]
                        if isinstance(data_str, bytes):
                            data_str = data_str.decode()
                        yield f"data: {data_str}\n\n"

                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                except asyncio.CancelledError:
                    raise
                except Exception as e:
                    logger.error(
                        f"[SSE] Error in chat event stream for {session_id}: {e}"
                    )
                    await asyncio.sleep(1)

        except asyncio.CancelledError:
            logger.info(f"[SSE] Client disconnected from {session_id}")
            raise
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/llm-calls")
async def stream_llm_calls():
    """SSE endpoint — streams LLM call log events in real-time.

    Subscribes to Redis channel: djinnbot:llm-calls:live
    Each event contains the full LLM call record so clients can append
    directly without re-fetching.
    """
    if not dependencies.redis_client:
        raise HTTPException(status_code=503, detail="Redis not connected")

    channel = "djinnbot:llm-calls:live"

    async def event_generator():
        pubsub = dependencies.redis_client.pubsub()
        await pubsub.subscribe(channel)

        try:
            while True:
                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(
                            ignore_subscribe_messages=True, timeout=None
                        ),
                        timeout=20.0,
                    )
                    if message and message["type"] == "message":
                        data_str = message["data"]
                        if isinstance(data_str, bytes):
                            data_str = data_str.decode()
                        yield f"data: {data_str}\n\n"
                    else:
                        yield ": heartbeat\n\n"
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                except asyncio.CancelledError:
                    break
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
