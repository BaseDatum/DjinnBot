"""Agent messaging permission model.

Table: agent_messaging_permissions

Controls which targets (chat IDs, phone numbers, group IDs) an agent is
allowed to send messages to on each messaging channel (telegram, whatsapp, signal).

Permission model:
  - No rows for an agent+channel = agent cannot send on that channel
  - A row with target='*' = wildcard, agent can send to any target on that channel
  - Specific target rows = agent can only send to those exact targets

This is enforced client-side in the agent-runtime tools before the API call
is made, providing fail-fast feedback to the LLM.
"""

from typing import Optional

from sqlalchemy import (
    String,
    BigInteger,
    Index,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AgentMessagingPermission(Base):
    """Per-agent, per-channel messaging target permission.

    Each row grants the agent permission to send to one specific target
    (or all targets if target='*') on one messaging channel.
    """

    __tablename__ = "agent_messaging_permissions"
    __table_args__ = (
        UniqueConstraint(
            "agent_id",
            "channel",
            "target",
            name="uq_agent_messaging_perm",
        ),
        Index("idx_agent_messaging_perm_agent_channel", "agent_id", "channel"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # 'telegram', 'whatsapp', or 'signal'
    channel: Mapped[str] = mapped_column(String(32), nullable=False)
    # '*' for wildcard or a specific chat ID / phone number / group ID
    target: Mapped[str] = mapped_column(String(256), nullable=False)
    # Human-friendly label (e.g. "Ops channel", "Alice's phone")
    label: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
