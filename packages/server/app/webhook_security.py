"""GitHub webhook signature verification."""
import hmac
import hashlib
from typing import Optional, Union
from datetime import datetime, timezone
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.pool import AsyncAdaptedQueuePool


def verify_github_signature(
    payload_body: bytes,
    signature_header: str,
    secret: str
) -> bool:
    """Verify GitHub webhook signature using HMAC-SHA256.
    
    Args:
        payload_body: Raw request body as bytes
        signature_header: X-Hub-Signature-256 header value (format: sha256=<hex>)
        secret: Webhook secret string
    
    Returns:
        True if signature is valid, False otherwise
    
    Example:
        >>> verify_github_signature(
        ...     b'{"action":"opened"}',
        ...     'sha256=abc123...',
        ...     'my-webhook-secret'
        ... )
        True
    """
    if not signature_header or not signature_header.startswith("sha256="):
        return False
    
    # Extract hex signature
    expected_signature = signature_header.split("=", 1)[1]
    
    # Compute HMAC-SHA256
    mac = hmac.new(
        key=secret.encode('utf-8'),
        msg=payload_body,
        digestmod=hashlib.sha256
    )
    computed_signature = mac.hexdigest()
    
    # Constant-time comparison to prevent timing attacks
    return hmac.compare_digest(computed_signature, expected_signature)


async def get_webhook_secret(
    db: Union[AsyncSession, any],
    installation_id: Optional[str] = None
) -> Optional[str]:
    """Get webhook secret for installation or global default.
    
    Args:
        db: Database connection or AsyncSession
        installation_id: GitHub App installation ID (optional)
    
    Returns:
        Webhook secret string or None if not found
    """
    # Try installation-specific secret first
    if installation_id:
        cursor = await db.execute(
            text("SELECT secret_hash FROM webhook_secrets WHERE installation_id = :installation_id"),
            {"installation_id": installation_id}
        )
        row = cursor.fetchone()
        if row:
            # Update last_used_at
            await db.execute(
                text("UPDATE webhook_secrets SET last_used_at = :now WHERE installation_id = :installation_id"),
                {"now": int(datetime.now(timezone.utc).timestamp()), "installation_id": installation_id}
            )
            await db.commit()
            return row[0]
    
    # Fall back to global secret (installation_id IS NULL)
    cursor = await db.execute(
        text("SELECT secret_hash FROM webhook_secrets WHERE installation_id IS NULL")
    )
    row = cursor.fetchone()
    return row[0] if row else None
