"""Waitlist & email settings API.

Public endpoints (no auth):
  POST  /v1/waitlist/join             join the waitlist

Admin endpoints:
  GET    /v1/waitlist/                 list waitlist entries
  POST   /v1/waitlist/{entry_id}/invite   send invite email
  DELETE /v1/waitlist/{entry_id}       remove entry

Email settings (admin):
  GET    /v1/waitlist/email-settings           get SMTP config
  PUT    /v1/waitlist/email-settings           update SMTP config
  POST   /v1/waitlist/email-settings/test      send test email
"""

import uuid
import smtplib
import ssl
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.auth.dependencies import get_current_admin, AuthUser
from app.models.waitlist import WaitlistEntry, EmailSettings
from app.models.base import now_ms
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ── Schemas ───────────────────────────────────────────────────────────────────


class JoinWaitlistRequest(BaseModel):
    email: str


class JoinWaitlistResponse(BaseModel):
    status: str
    message: str


class WaitlistEntryResponse(BaseModel):
    id: str
    email: str
    status: str
    invitedAt: Optional[int]
    registeredAt: Optional[int]
    createdAt: int


class EmailSettingsRequest(BaseModel):
    smtpHost: str
    smtpPort: int = 587
    smtpUsername: str
    smtpPassword: str
    smtpUseTls: bool = True
    fromEmail: str
    fromName: str = "DjinnBot"


class EmailSettingsResponse(BaseModel):
    smtpHost: str
    smtpPort: int
    smtpUsername: str
    smtpPassword: str  # masked
    smtpUseTls: bool
    fromEmail: str
    fromName: str
    configured: bool


class TestEmailRequest(BaseModel):
    recipientEmail: str


# ── Helpers ───────────────────────────────────────────────────────────────────


def _gen_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def _mask_password(pw: str) -> str:
    if not pw:
        return ""
    if len(pw) <= 4:
        return "****"
    return pw[:2] + "*" * (len(pw) - 4) + pw[-2:]


async def _get_email_settings(session: AsyncSession) -> Optional[EmailSettings]:
    result = await session.execute(
        select(EmailSettings).where(EmailSettings.id == "default")
    )
    return result.scalar_one_or_none()


def _send_email(
    settings: EmailSettings,
    to_email: str,
    subject: str,
    html_body: str,
) -> None:
    """Send an email via SMTP. Raises on failure."""
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{settings.from_name} <{settings.from_email}>"
    msg["To"] = to_email

    # Plain text fallback
    plain = "You've been invited to DjinnBot! Please view this email in an HTML-capable client."
    msg.attach(MIMEText(plain, "plain"))
    msg.attach(MIMEText(html_body, "html"))

    if settings.smtp_use_tls:
        ctx = ssl.create_default_context()
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            server.starttls(context=ctx)
            if settings.smtp_username and settings.smtp_password:
                server.login(settings.smtp_username, settings.smtp_password)
            server.sendmail(settings.from_email, to_email, msg.as_string())
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as server:
            if settings.smtp_username and settings.smtp_password:
                server.login(settings.smtp_username, settings.smtp_password)
            server.sendmail(settings.from_email, to_email, msg.as_string())


def _build_invite_html(to_email: str) -> str:
    """Build the beautifully formatted invite email HTML."""
    return f"""\
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>You're Invited to DjinnBot</title>
</head>
<body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Oxygen,Ubuntu,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0f;min-height:100vh;">
<tr><td align="center" style="padding:40px 20px;">

<!-- Main Card -->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:linear-gradient(145deg,#12121a 0%,#1a1a2e 100%);border-radius:16px;border:1px solid #2a2a3e;overflow:hidden;">

<!-- Header Glow -->
<tr><td style="height:4px;background:linear-gradient(90deg,#6366f1,#8b5cf6,#a855f7,#6366f1);background-size:200% 100%;"></td></tr>

<!-- Logo Area -->
<tr><td align="center" style="padding:48px 40px 24px;">
  <div style="width:72px;height:72px;border-radius:16px;background:linear-gradient(135deg,#6366f1,#8b5cf6);display:inline-flex;align-items:center;justify-content:center;font-size:36px;margin-bottom:16px;">
    <img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ctext x='8' y='32' font-size='32'%3E%F0%9F%A7%9E%3C/text%3E%3C/svg%3E" alt="" width="40" height="40" style="display:block;">
  </div>
  <h1 style="margin:0;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
    You're In.
  </h1>
</td></tr>

<!-- Body -->
<tr><td style="padding:0 40px 32px;">
  <p style="margin:0 0 20px;font-size:16px;line-height:1.7;color:#a0a0b8;text-align:center;">
    Welcome to <strong style="color:#c4b5fd;">DjinnBot</strong> &mdash; the AI agent orchestration platform where autonomous agents collaborate, think, and build alongside you.
  </p>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
    <tr>
      <td style="padding:16px 20px;background:#ffffff08;border-radius:12px;border:1px solid #ffffff0d;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="40" valign="top" style="padding-right:12px;font-size:20px;">&#9889;</td>
            <td>
              <p style="margin:0;font-size:14px;color:#e0e0f0;font-weight:600;">Autonomous Agent Teams</p>
              <p style="margin:4px 0 0;font-size:13px;color:#808098;line-height:1.5;">Orchestrate fleets of AI agents that think, code, and collaborate in sandboxed environments.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr><td height="10"></td></tr>
    <tr>
      <td style="padding:16px 20px;background:#ffffff08;border-radius:12px;border:1px solid #ffffff0d;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="40" valign="top" style="padding-right:12px;font-size:20px;">&#128640;</td>
            <td>
              <p style="margin:0;font-size:14px;color:#e0e0f0;font-weight:600;">Pipeline-Driven Workflows</p>
              <p style="margin:4px 0 0;font-size:13px;color:#808098;line-height:1.5;">Define multi-step pipelines with YAML. Agents execute tasks, manage memory, and ship code.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
    <tr><td height="10"></td></tr>
    <tr>
      <td style="padding:16px 20px;background:#ffffff08;border-radius:12px;border:1px solid #ffffff0d;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          <tr>
            <td width="40" valign="top" style="padding-right:12px;font-size:20px;">&#128065;</td>
            <td>
              <p style="margin:0;font-size:14px;color:#e0e0f0;font-weight:600;">Full Observability</p>
              <p style="margin:4px 0 0;font-size:13px;color:#808098;line-height:1.5;">Real-time dashboards, knowledge graphs, chat sessions, and complete audit trails.</p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>

  <p style="margin:24px 0 0;font-size:15px;line-height:1.7;color:#a0a0b8;text-align:center;">
    Your account is being prepared. An admin will reach out with your login credentials shortly.
  </p>
</td></tr>

<!-- Divider -->
<tr><td style="padding:0 40px;">
  <div style="height:1px;background:linear-gradient(90deg,transparent,#2a2a3e,transparent);"></div>
</td></tr>

<!-- Footer -->
<tr><td align="center" style="padding:24px 40px 36px;">
  <p style="margin:0;font-size:12px;color:#505068;line-height:1.6;">
    This invite was sent to <span style="color:#808098;">{to_email}</span><br>
    &copy; DjinnBot &mdash; AI Agent Orchestration
  </p>
</td></tr>

</table>
<!-- End Main Card -->

</td></tr>
</table>
</body>
</html>"""


# ═════════════════════════════════════════════════════════════════════════════
#  PUBLIC — Join Waitlist
# ═════════════════════════════════════════════════════════════════════════════


@router.post("/join", response_model=JoinWaitlistResponse)
async def join_waitlist(
    body: JoinWaitlistRequest,
    session: AsyncSession = Depends(get_async_session),
) -> JoinWaitlistResponse:
    """Public endpoint: add email to the waitlist."""
    email = body.email.lower().strip()
    if not email or "@" not in email:
        raise HTTPException(status_code=400, detail="Invalid email address")

    # Check for duplicate
    existing = await session.execute(
        select(WaitlistEntry).where(WaitlistEntry.email == email)
    )
    if existing.scalar_one_or_none():
        # Don't reveal whether the email already exists — just succeed.
        return JoinWaitlistResponse(
            status="ok",
            message="You're on the list! We'll notify you when a spot opens up.",
        )

    entry = WaitlistEntry(
        id=_gen_id("wl"),
        email=email,
        status="waiting",
        created_at=now_ms(),
    )
    session.add(entry)
    await session.commit()

    logger.info(f"Waitlist signup: {email}")
    return JoinWaitlistResponse(
        status="ok",
        message="You're on the list! We'll notify you when a spot opens up.",
    )


# ═════════════════════════════════════════════════════════════════════════════
#  ADMIN — Waitlist Management
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/", response_model=List[WaitlistEntryResponse])
async def list_waitlist(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> List[WaitlistEntryResponse]:
    """List all waitlist entries (admin only)."""
    result = await session.execute(
        select(WaitlistEntry).order_by(WaitlistEntry.created_at.desc())
    )
    return [
        WaitlistEntryResponse(
            id=e.id,
            email=e.email,
            status=e.status,
            invitedAt=e.invited_at,
            registeredAt=e.registered_at,
            createdAt=e.created_at,
        )
        for e in result.scalars().all()
    ]


@router.post("/{entry_id}/invite")
async def invite_waitlist_entry(
    entry_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Send an invite email to a waitlist entry (admin only)."""
    entry = await session.get(WaitlistEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Waitlist entry not found")

    # Get email settings
    email_cfg = await _get_email_settings(session)
    if not email_cfg or not email_cfg.smtp_host:
        raise HTTPException(
            status_code=400,
            detail="Email settings not configured. Set up SMTP in the Email Settings tab first.",
        )

    try:
        html = _build_invite_html(entry.email)
        _send_email(
            email_cfg,
            entry.email,
            "You're Invited to DjinnBot",
            html,
        )
    except Exception as e:
        logger.error(f"Failed to send invite to {entry.email}: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Failed to send email: {str(e)}",
        )

    entry.status = "invited"
    entry.invited_at = now_ms()
    await session.commit()

    logger.info(f"Admin {admin.id} invited {entry.email} from waitlist")
    return {"status": "invited", "email": entry.email}


@router.delete("/{entry_id}")
async def delete_waitlist_entry(
    entry_id: str,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Remove a waitlist entry (admin only)."""
    entry = await session.get(WaitlistEntry, entry_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Waitlist entry not found")
    await session.delete(entry)
    await session.commit()
    logger.info(f"Admin {admin.id} deleted waitlist entry {entry_id}")
    return {"status": "deleted", "id": entry_id}


# ═════════════════════════════════════════════════════════════════════════════
#  ADMIN — Email Settings
# ═════════════════════════════════════════════════════════════════════════════


@router.get("/email-settings", response_model=EmailSettingsResponse)
async def get_email_settings(
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> EmailSettingsResponse:
    """Get the current email settings (admin only)."""
    cfg = await _get_email_settings(session)
    if not cfg:
        return EmailSettingsResponse(
            smtpHost="",
            smtpPort=587,
            smtpUsername="",
            smtpPassword="",
            smtpUseTls=True,
            fromEmail="",
            fromName="DjinnBot",
            configured=False,
        )
    return EmailSettingsResponse(
        smtpHost=cfg.smtp_host,
        smtpPort=cfg.smtp_port,
        smtpUsername=cfg.smtp_username,
        smtpPassword=_mask_password(cfg.smtp_password),
        smtpUseTls=cfg.smtp_use_tls,
        fromEmail=cfg.from_email,
        fromName=cfg.from_name,
        configured=bool(cfg.smtp_host and cfg.from_email),
    )


@router.put("/email-settings")
async def update_email_settings(
    body: EmailSettingsRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Update the email settings (admin only)."""
    cfg = await _get_email_settings(session)

    if cfg:
        cfg.smtp_host = body.smtpHost.strip()
        cfg.smtp_port = body.smtpPort
        cfg.smtp_username = body.smtpUsername.strip()
        # Only update password if not masked
        if body.smtpPassword and not body.smtpPassword.startswith("**"):
            cfg.smtp_password = body.smtpPassword
        cfg.smtp_use_tls = body.smtpUseTls
        cfg.from_email = body.fromEmail.strip()
        cfg.from_name = body.fromName.strip()
        cfg.updated_at = now_ms()
    else:
        cfg = EmailSettings(
            id="default",
            smtp_host=body.smtpHost.strip(),
            smtp_port=body.smtpPort,
            smtp_username=body.smtpUsername.strip(),
            smtp_password=body.smtpPassword,
            smtp_use_tls=body.smtpUseTls,
            from_email=body.fromEmail.strip(),
            from_name=body.fromName.strip(),
            updated_at=now_ms(),
        )
        session.add(cfg)

    await session.commit()
    logger.info(f"Admin {admin.id} updated email settings")
    return {"status": "saved"}


@router.post("/email-settings/test")
async def test_email_settings(
    body: TestEmailRequest,
    admin: AuthUser = Depends(get_current_admin),
    session: AsyncSession = Depends(get_async_session),
) -> dict:
    """Send a test email using current settings (admin only)."""
    cfg = await _get_email_settings(session)
    if not cfg or not cfg.smtp_host:
        raise HTTPException(
            status_code=400,
            detail="Email settings not configured yet.",
        )

    try:
        test_html = """\
<!DOCTYPE html>
<html>
<body style="margin:0;padding:0;background-color:#0a0a0f;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0a0a0f;">
<tr><td align="center" style="padding:40px 20px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#12121a;border-radius:12px;border:1px solid #2a2a3e;">
<tr><td style="height:3px;background:linear-gradient(90deg,#6366f1,#a855f7);"></td></tr>
<tr><td align="center" style="padding:40px;">
  <p style="margin:0 0 8px;font-size:24px;font-weight:700;color:#fff;">Test Email</p>
  <p style="margin:0;font-size:15px;color:#a0a0b8;line-height:1.6;">
    If you're reading this, your DjinnBot email settings are configured correctly.
  </p>
  <div style="margin:24px 0;padding:12px 20px;background:#6366f120;border-radius:8px;border:1px solid #6366f140;">
    <p style="margin:0;font-size:13px;color:#c4b5fd;">SMTP connection successful</p>
  </div>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>"""
        _send_email(cfg, body.recipientEmail, "DjinnBot Test Email", test_html)
    except Exception as e:
        logger.error(f"Test email failed: {e}")
        raise HTTPException(
            status_code=500,
            detail=f"Test email failed: {str(e)}",
        )

    logger.info(f"Admin {admin.id} sent test email to {body.recipientEmail}")
    return {"status": "sent", "recipient": body.recipientEmail}
