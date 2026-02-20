"""Secrets management API.

Endpoints:

  Secret library (admin / UI):
    GET    /v1/secrets/                     list all secrets (masked, no plaintext)
    POST   /v1/secrets/                     create a secret
    GET    /v1/secrets/{secret_id}          get secret (masked)
    PUT    /v1/secrets/{secret_id}          update secret name / description / value
    DELETE /v1/secrets/{secret_id}          delete secret and all its grants

  Agent access control:
    GET    /v1/secrets/agents/{agent_id}                secrets granted to agent (masked)
    POST   /v1/secrets/{secret_id}/grant/{agent_id}     grant secret to agent
    DELETE /v1/secrets/{secret_id}/grant/{agent_id}     revoke secret from agent

  Engine injection endpoint (internal — called by the Node engine):
    GET    /v1/secrets/agents/{agent_id}/env            plaintext env map for container injection

SECURITY NOTES
--------------
* The plaintext secret value is NEVER returned by any endpoint except
  ``/v1/secrets/agents/{agent_id}/env`` which is an internal endpoint intended
  only for the engine container (not exposed to the dashboard).
* All secrets are stored AES-256-GCM encrypted in the database.
* The encryption key is sourced from SECRET_ENCRYPTION_KEY env var.
* Masked previews (e.g. "ghp_...abc1") are shown in all list/get responses.
"""

import uuid
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_async_session
from app.models.secret import Secret, AgentSecretGrant, SECRET_TYPES
from app.models.base import now_ms
from app.crypto import encrypt_secret, decrypt_secret, mask_secret
from app.logging_config import get_logger

logger = get_logger(__name__)

router = APIRouter()


# ── Pydantic schemas ───────────────────────────────────────────────────────────


class SecretCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=256)
    description: Optional[str] = None
    secret_type: str = "env_var"
    env_key: str = Field(
        ...,
        min_length=1,
        max_length=256,
        description="Environment variable name injected into agent containers, e.g. GITHUB_TOKEN",
    )
    value: str = Field(..., min_length=1, description="The plaintext secret value")


class SecretUpdate(BaseModel):
    name: Optional[str] = Field(None, min_length=1, max_length=256)
    description: Optional[str] = None
    secret_type: Optional[str] = None
    env_key: Optional[str] = Field(None, min_length=1, max_length=256)
    # If provided, the secret value is rotated.  Leave None to keep the current value.
    value: Optional[str] = Field(None, min_length=1)


class SecretResponse(BaseModel):
    """Secret response — never contains the plaintext value."""

    id: str
    name: str
    description: Optional[str]
    secret_type: str
    secret_type_label: str
    env_key: str
    masked_preview: Optional[str]
    granted_agents: List[str]
    created_at: int
    updated_at: int


class GrantResponse(BaseModel):
    secret_id: str
    agent_id: str
    granted_at: int
    granted_by: Optional[str]


class AgentSecretEnvResponse(BaseModel):
    """Plaintext env vars for container injection — internal use only."""

    agent_id: str
    env: dict[str, str]


# ── Helpers ────────────────────────────────────────────────────────────────────


def _secret_type_label(secret_type: str) -> str:
    return SECRET_TYPES.get(secret_type, secret_type)


async def _build_response(secret: Secret, session: AsyncSession) -> SecretResponse:
    result = await session.execute(
        select(AgentSecretGrant).where(AgentSecretGrant.secret_id == secret.id)
    )
    grants = result.scalars().all()
    return SecretResponse(
        id=secret.id,
        name=secret.name,
        description=secret.description,
        secret_type=secret.secret_type,
        secret_type_label=_secret_type_label(secret.secret_type),
        env_key=secret.env_key,
        masked_preview=secret.masked_preview,
        granted_agents=[g.agent_id for g in grants],
        created_at=secret.created_at,
        updated_at=secret.updated_at,
    )


def _validate_env_key(env_key: str) -> str:
    """Normalise env key to UPPER_SNAKE_CASE and validate characters."""
    key = env_key.strip().upper()
    if not all(c.isalnum() or c == "_" for c in key):
        raise HTTPException(
            status_code=422,
            detail="env_key must contain only alphanumeric characters and underscores",
        )
    return key


# ── Fixed-path routes (MUST come before /{secret_id} to avoid shadowing) ──────


@router.get("/types")
async def list_secret_types() -> dict:
    """Return the catalog of known secret types for the UI."""
    return {"types": [{"value": k, "label": v} for k, v in SECRET_TYPES.items()]}


# ── Per-agent views ────────────────────────────────────────────────────────────


@router.get("/agents/{agent_id}/env", response_model=AgentSecretEnvResponse)
async def get_agent_env(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> AgentSecretEnvResponse:
    """Return decrypted env vars for all secrets granted to *agent_id*.

    This endpoint is called by the engine immediately before launching a
    container.  It returns the plaintext values so the engine can inject them
    as environment variables.

    SECURITY: This endpoint should NOT be exposed to the public internet or the
    dashboard.  In production, restrict access to the engine's internal network.
    """
    result = await session.execute(
        select(AgentSecretGrant).where(AgentSecretGrant.agent_id == agent_id)
    )
    grants = result.scalars().all()

    env: dict[str, str] = {}
    for grant in grants:
        secret = await session.get(Secret, grant.secret_id)
        if not secret:
            continue
        try:
            plaintext = decrypt_secret(secret.encrypted_value)
            env[secret.env_key] = plaintext
        except ValueError as exc:
            logger.error(
                f"Failed to decrypt secret {secret.id} for agent {agent_id}: {exc}"
            )
            # Skip this secret rather than crash the entire launch

    return AgentSecretEnvResponse(agent_id=agent_id, env=env)


@router.get("/agents/{agent_id}", response_model=List[SecretResponse])
async def list_agent_secrets(
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> List[SecretResponse]:
    """List all secrets granted to a specific agent (masked — no plaintext)."""
    result = await session.execute(
        select(AgentSecretGrant).where(AgentSecretGrant.agent_id == agent_id)
    )
    grants = result.scalars().all()
    secrets = []
    for grant in grants:
        secret = await session.get(Secret, grant.secret_id)
        if secret:
            secrets.append(await _build_response(secret, session))
    return secrets


# ── Secret CRUD ────────────────────────────────────────────────────────────────


@router.get("/", response_model=List[SecretResponse])
async def list_secrets(
    session: AsyncSession = Depends(get_async_session),
) -> List[SecretResponse]:
    """List all secrets. Plaintext values are never returned."""
    result = await session.execute(select(Secret).order_by(Secret.created_at.desc()))
    secrets = result.scalars().all()
    return [await _build_response(s, session) for s in secrets]


@router.post("/", response_model=SecretResponse, status_code=201)
async def create_secret(
    body: SecretCreate,
    session: AsyncSession = Depends(get_async_session),
) -> SecretResponse:
    """Create a new secret. The plaintext value is encrypted immediately and never stored."""
    if body.secret_type not in SECRET_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown secret_type '{body.secret_type}'. Valid: {list(SECRET_TYPES.keys())}",
        )

    env_key = _validate_env_key(body.env_key)

    now = now_ms()
    secret = Secret(
        id=f"sec_{uuid.uuid4().hex[:12]}",
        name=body.name.strip(),
        description=body.description,
        secret_type=body.secret_type,
        env_key=env_key,
        encrypted_value=encrypt_secret(body.value),
        masked_preview=mask_secret(body.value),
        created_at=now,
        updated_at=now,
    )
    session.add(secret)
    await session.commit()
    await session.refresh(secret)
    logger.info(f"Secret created: {secret.id} ({secret.name}, env_key={env_key})")
    return await _build_response(secret, session)


@router.get("/{secret_id}", response_model=SecretResponse)
async def get_secret(
    secret_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> SecretResponse:
    """Get a single secret. Plaintext value is never returned."""
    secret = await session.get(Secret, secret_id)
    if not secret:
        raise HTTPException(status_code=404, detail=f"Secret '{secret_id}' not found")
    return await _build_response(secret, session)


@router.put("/{secret_id}", response_model=SecretResponse)
async def update_secret(
    secret_id: str,
    body: SecretUpdate,
    session: AsyncSession = Depends(get_async_session),
) -> SecretResponse:
    """Update secret metadata and/or rotate the value.

    Only fields that are explicitly set in the request body are updated.
    To rotate the value, include ``value`` in the request.
    """
    secret = await session.get(Secret, secret_id)
    if not secret:
        raise HTTPException(status_code=404, detail=f"Secret '{secret_id}' not found")

    if body.name is not None:
        secret.name = body.name.strip()
    if body.description is not None:
        secret.description = body.description
    if body.secret_type is not None:
        if body.secret_type not in SECRET_TYPES:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown secret_type '{body.secret_type}'",
            )
        secret.secret_type = body.secret_type
    if body.env_key is not None:
        secret.env_key = _validate_env_key(body.env_key)
    if body.value is not None:
        # Rotate the encrypted value
        secret.encrypted_value = encrypt_secret(body.value)
        secret.masked_preview = mask_secret(body.value)

    secret.updated_at = now_ms()
    await session.commit()
    await session.refresh(secret)
    logger.info(f"Secret updated: {secret.id} ({secret.name})")
    return await _build_response(secret, session)


@router.delete("/{secret_id}", status_code=204)
async def delete_secret(
    secret_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> None:
    """Delete a secret and all its agent grants."""
    secret = await session.get(Secret, secret_id)
    if not secret:
        raise HTTPException(status_code=404, detail=f"Secret '{secret_id}' not found")
    await session.execute(
        delete(AgentSecretGrant).where(AgentSecretGrant.secret_id == secret_id)
    )
    await session.delete(secret)
    await session.commit()
    logger.info(f"Secret deleted: {secret_id}")


# ── Grant / revoke ─────────────────────────────────────────────────────────────


@router.post("/{secret_id}/grant/{agent_id}", response_model=GrantResponse)
async def grant_secret(
    secret_id: str,
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> GrantResponse:
    """Grant a secret to an agent."""
    secret = await session.get(Secret, secret_id)
    if not secret:
        raise HTTPException(status_code=404, detail=f"Secret '{secret_id}' not found")

    # Idempotent — if grant already exists just return it
    result = await session.execute(
        select(AgentSecretGrant).where(
            AgentSecretGrant.secret_id == secret_id,
            AgentSecretGrant.agent_id == agent_id,
        )
    )
    existing = result.scalar_one_or_none()
    if existing:
        return GrantResponse(
            secret_id=existing.secret_id,
            agent_id=existing.agent_id,
            granted_at=existing.granted_at,
            granted_by=existing.granted_by,
        )

    now = now_ms()
    grant = AgentSecretGrant(
        id=f"grt_{uuid.uuid4().hex[:12]}",
        secret_id=secret_id,
        agent_id=agent_id,
        granted_at=now,
    )
    session.add(grant)
    await session.commit()
    logger.info(f"Secret {secret_id} granted to agent {agent_id}")
    return GrantResponse(
        secret_id=secret_id,
        agent_id=agent_id,
        granted_at=now,
        granted_by=None,
    )


@router.delete("/{secret_id}/grant/{agent_id}", status_code=204)
async def revoke_secret(
    secret_id: str,
    agent_id: str,
    session: AsyncSession = Depends(get_async_session),
) -> None:
    """Revoke a secret from an agent."""
    result = await session.execute(
        select(AgentSecretGrant).where(
            AgentSecretGrant.secret_id == secret_id,
            AgentSecretGrant.agent_id == agent_id,
        )
    )
    grant = result.scalar_one_or_none()
    if not grant:
        raise HTTPException(
            status_code=404,
            detail=f"No grant for secret '{secret_id}' → agent '{agent_id}'",
        )
    await session.delete(grant)
    await session.commit()
    logger.info(f"Secret {secret_id} revoked from agent {agent_id}")
