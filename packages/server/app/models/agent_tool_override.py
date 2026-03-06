"""Agent built-in tool override model.

A single table: agent_tool_overrides

Each row records that a specific built-in tool is DISABLED for a specific
agent.  The absence of a row means the tool is enabled (allow-list by default).

This intentionally mirrors the agent_skills / agent_mcp_tools pattern:
  - Only disabled tools are stored — keeps the table small.
  - The runtime fetches the disabled set on startup (or on broadcast invalidation)
    and filters buildTools() accordingly.
"""

from sqlalchemy import (
    String,
    Boolean,
    BigInteger,
    Index,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AgentToolOverride(Base):
    """Per-agent disable record for a built-in tool.

    When ``enabled`` is False the tool is filtered out of the agent's tool list
    before it runs. The row is kept (rather than deleted) so toggling back on
    requires only an UPDATE, preserving audit info.
    """

    __tablename__ = "agent_tool_overrides"
    __table_args__ = (
        UniqueConstraint("agent_id", "tool_name", name="uq_agent_tool_override"),
        Index("idx_agent_tool_overrides_agent", "agent_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    # The exact tool name as returned by AgentTool.name (e.g. "bash", "remember")
    tool_name: Mapped[str] = mapped_column(String(256), nullable=False)
    # False = tool disabled; True = tool explicitly re-enabled (row can be cleaned up)
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_by: Mapped[str] = mapped_column(String(128), nullable=False, default="ui")
