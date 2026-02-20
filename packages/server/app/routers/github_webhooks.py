"""GitHub webhook endpoints."""
from fastapi import APIRouter, Request, HTTPException, Header, Depends
from typing import Optional
import json
import uuid
from datetime import datetime, timezone
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models import WebhookEvent, WebhookSecret
from app.webhook_security import verify_github_signature, get_webhook_secret
from app import dependencies
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# Rate limiting: track deliveries per minute
_recent_deliveries = {}  # {delivery_id: timestamp}
_cleanup_counter = 0
MAX_REQUESTS_PER_MINUTE = 100


def _check_rate_limit(delivery_id: str) -> bool:
    """Check if request is within rate limits."""
    global _cleanup_counter
    now = datetime.now(timezone.utc).timestamp()
    
    # Cleanup old entries every 100 requests
    _cleanup_counter += 1
    if _cleanup_counter >= 100:
        cutoff = now - 60
        old_keys = [k for k, v in _recent_deliveries.items() if v < cutoff]
        for k in old_keys:
            del _recent_deliveries[k]
        _cleanup_counter = 0
    
    # Check recent requests
    recent_count = sum(1 for ts in _recent_deliveries.values() if ts > now - 60)
    if recent_count >= MAX_REQUESTS_PER_MINUTE:
        return False
    
    _recent_deliveries[delivery_id] = now
    return True


@router.post("/github")
async def receive_github_webhook(
    request: Request,
    session: AsyncSession = Depends(get_async_session),
    x_github_event: str = Header(..., alias="X-GitHub-Event"),
    x_github_delivery: str = Header(..., alias="X-GitHub-Delivery"),
    x_hub_signature_256: Optional[str] = Header(None, alias="X-Hub-Signature-256"),
    x_github_hook_installation_target_id: Optional[str] = Header(None, alias="X-GitHub-Hook-Installation-Target-ID"),
):
    """Receive and verify GitHub webhook events.
    
    Webhook URL: https://your-domain.com/api/webhooks/github
    
    Security:
    - Verifies HMAC-SHA256 signature using webhook secret
    - Logs all events for audit and replay
    - Rate limits to 100 requests/minute
    
    Returns:
    - 200: Webhook received and validated
    - 401: Invalid signature
    - 400: Missing required headers
    - 429: Rate limit exceeded
    """
    # Rate limiting
    if not _check_rate_limit(x_github_delivery):
        raise HTTPException(
            status_code=429,
            detail="Rate limit exceeded. Max 100 webhooks per minute."
        )
    
    # Read raw body (needed for signature verification)
    raw_body = await request.body()
    
    # Parse JSON payload
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError:
        raise HTTPException(status_code=400, detail="Invalid JSON payload")
    
    # Extract metadata from payload
    action = payload.get("action")
    repository = payload.get("repository", {})
    repository_full_name = repository.get("full_name")
    repository_id = repository.get("id")
    sender = payload.get("sender", {})
    sender_login = sender.get("login")
    installation = payload.get("installation", {})
    installation_id = installation.get("id") or x_github_hook_installation_target_id
    
    # Get webhook secret
    secret = await get_webhook_secret(session, str(installation_id) if installation_id else None)
    
    if not secret:
        logger.warning(f"No webhook secret configured for installation {installation_id}")
        # Store event even if no secret configured, but mark as unverified
        verified = False
        error_msg = "Webhook secret not configured"
    else:
        # Verify signature
        verified = False
        if x_hub_signature_256:
            verified = verify_github_signature(raw_body, x_hub_signature_256, secret)
        
        if not verified:
            logger.warning(f"Signature verification failed for delivery {x_github_delivery}")
            error_msg = "Invalid signature"
        else:
            error_msg = None
    
    # Store webhook event (even if verification failed, for audit)
    event_id = str(uuid.uuid4())
    received_at = int(datetime.now(timezone.utc).timestamp())
    
    event = WebhookEvent(
        id=event_id,
        delivery_id=x_github_delivery,
        event_type=x_github_event,
        action=action,
        installation_id=str(installation_id) if installation_id else None,
        repository_full_name=repository_full_name,
        repository_id=repository_id,
        sender_login=sender_login,
        payload=json.dumps(payload),
        signature=x_hub_signature_256 or "",
        verified=1 if verified else 0,
        received_at=received_at,
        processing_error=error_msg,
    )
    session.add(event)
    await session.commit()
    
    # If verification failed, return 401
    if not verified:
        raise HTTPException(status_code=401, detail=error_msg or "Invalid signature")
    
    # Publish event to Redis for async processing (Task 20)
    if dependencies.redis_client:
        try:
            await dependencies.redis_client.publish(
                "djinnbot:webhooks:github",
                json.dumps({
                    "event_id": event_id,
                    "delivery_id": x_github_delivery,
                    "event_type": x_github_event,
                    "action": action,
                    "repository": repository_full_name,
                    "installation_id": installation_id,
                })
            )
        except Exception as e:
            logger.error(f"Failed to publish to Redis: {e}")
    
    logger.info(f"{x_github_event}.{action} from {repository_full_name} (delivery: {x_github_delivery})")
    
    return {
        "status": "received",
        "event_id": event_id,
        "delivery_id": x_github_delivery,
        "event_type": x_github_event,
        "action": action
    }


@router.get("/events")
async def list_webhook_events(
    event_type: Optional[str] = None,
    repository: Optional[str] = None,
    processed: Optional[bool] = None,
    limit: int = 50,
    offset: int = 0,
    session: AsyncSession = Depends(get_async_session)
):
    """List webhook events with optional filtering.
    
    Query params:
    - event_type: Filter by event type (issues, pull_request, etc.)
    - repository: Filter by repository full name
    - processed: Filter by processing status
    - limit: Max results (default: 50)
    - offset: Pagination offset
    """
    query = select(WebhookEvent)
    
    if event_type:
        query = query.where(WebhookEvent.event_type == event_type)
    
    if repository:
        query = query.where(WebhookEvent.repository_full_name == repository)
    
    if processed is not None:
        query = query.where(WebhookEvent.processed == (1 if processed else 0))
    
    query = query.order_by(WebhookEvent.received_at.desc()).limit(limit).offset(offset)
    
    result = await session.execute(query)
    events = result.scalars().all()
    
    return {
        "events": [
            {
                "id": e.id,
                "delivery_id": e.delivery_id,
                "event_type": e.event_type,
                "action": e.action,
                "installation_id": e.installation_id,
                "repository_full_name": e.repository_full_name,
                "repository_id": e.repository_id,
                "sender_login": e.sender_login,
                "verified": bool(e.verified),
                "processed": bool(e.processed),
                "processing_error": e.processing_error,
                "received_at": e.received_at,
                "processed_at": e.processed_at,
            }
            for e in events
        ],
        "count": len(events),
        "limit": limit,
        "offset": offset
    }


@router.get("/events/{event_id}")
async def get_webhook_event(
    event_id: str,
    session: AsyncSession = Depends(get_async_session)
):
    """Get webhook event details by ID."""
    result = await session.execute(
        select(WebhookEvent).where(WebhookEvent.id == event_id)
    )
    event = result.scalar_one_or_none()
    
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    
    return {
        "id": event.id,
        "delivery_id": event.delivery_id,
        "event_type": event.event_type,
        "action": event.action,
        "installation_id": event.installation_id,
        "repository_full_name": event.repository_full_name,
        "repository_id": event.repository_id,
        "sender_login": event.sender_login,
        "payload": json.loads(event.payload) if event.payload else {},
        "signature": event.signature,
        "verified": bool(event.verified),
        "processed": bool(event.processed),
        "processing_error": event.processing_error,
        "received_at": event.received_at,
        "processed_at": event.processed_at,
    }


@router.post("/events/{event_id}/replay")
async def replay_webhook_event(
    event_id: str,
    session: AsyncSession = Depends(get_async_session)
):
    """Replay a webhook event (useful for failed processing).
    
    This endpoint allows manual retry of webhook event processing.
    """
    result = await session.execute(
        select(WebhookEvent).where(WebhookEvent.id == event_id)
    )
    event = result.scalar_one_or_none()
    
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    
    if not dependencies.redis_client:
        raise HTTPException(
            status_code=503,
            detail="Redis not available - cannot replay events"
        )
    
    # Clear processing error and mark as unprocessed
    event.processing_error = None
    event.processed = 0
    
    # Re-publish event to Redis for processing
    try:
        await dependencies.redis_client.publish(
            "djinnbot:webhooks:github",
            json.dumps({
                "event_id": event_id,
                "delivery_id": event.delivery_id,
                "event_type": event.event_type,
                "action": event.action,
                "repository": event.repository_full_name,
                "installation_id": event.installation_id,
                "replay": True
            })
        )
        await session.commit()
        
        return {
            "status": "replayed",
            "event_id": event_id,
            "message": "Event re-queued for processing"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to replay event: {str(e)}")
