"""MCP server integration models.

Two tables:
  mcp_servers      — registry of configured MCP servers (mcpo config entries)
  agent_mcp_tools  — per-tool access control: which agents can use which tools
"""

from typing import Optional
from sqlalchemy import (
    String,
    Text,
    Boolean,
    BigInteger,
    Index,
    ForeignKey,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, now_ms


class McpServer(Base):
    """A configured MCP server managed by mcpo.

    Each row corresponds to one entry in the mcpo config.json
    ``mcpServers`` object. The ``config`` field is the JSON blob for that
    entry (command/args/env for stdio, url/type for SSE/streamable-http).

    status:
      'configuring' — being set up via interactive agent session
      'running'     — mcpo reports it is healthy
      'error'       — mcpo failed to start this server
      'stopped'     — globally disabled (enabled=False)
    """

    __tablename__ = "mcp_servers"
    __table_args__ = (
        Index("idx_mcp_servers_status", "status"),
        Index("idx_mcp_servers_enabled", "enabled"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)  # slug
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False, default="")
    # JSON blob — the mcpServers entry: {command, args, env} or {type, url, headers}
    config: Mapped[str] = mapped_column(Text, nullable=False, default="{}")
    # Cached list of tool names discovered from mcpo OpenAPI (JSON array of strings)
    discovered_tools: Mapped[str] = mapped_column(Text, nullable=False, default="[]")
    status: Mapped[str] = mapped_column(
        String(32), nullable=False, default="configuring"
    )
    enabled: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    # Which agent ran the setup session, if any
    setup_agent_id: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)

    # Approval workflow: admin-created servers are auto-approved; user-submitted
    # servers start as 'pending' and require admin approval.
    approval_status: Mapped[str] = mapped_column(
        String(16), nullable=False, default="approved"
    )
    # The user who submitted this MCP server (NULL for admin-created).
    submitted_by_user_id: Mapped[Optional[str]] = mapped_column(
        String(64), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationships
    tool_grants: Mapped[list["AgentMcpTool"]] = relationship(
        back_populates="server",
        cascade="all, delete-orphan",
    )


class AgentMcpTool(Base):
    """Per-tool access control: which agents may call which mcpo tools.

    tool_name is the OpenAPI operation name as reported by mcpo, e.g.
    "memory__create_entities" or the raw tool name "get_current_time".

    The special value "*" means "all tools on this server".
    """

    __tablename__ = "agent_mcp_tools"
    __table_args__ = (
        UniqueConstraint(
            "agent_id", "server_id", "tool_name", name="uq_agent_mcp_tool"
        ),
        Index("idx_agent_mcp_tools_agent", "agent_id"),
        Index("idx_agent_mcp_tools_server", "server_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    server_id: Mapped[str] = mapped_column(
        String(64), ForeignKey("mcp_servers.id", ondelete="CASCADE"), nullable=False
    )
    # "*" = all tools, or specific tool name
    tool_name: Mapped[str] = mapped_column(String(256), nullable=False, default="*")
    granted: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    granted_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    granted_by: Mapped[str] = mapped_column(String(128), nullable=False, default="ui")

    # Relationships
    server: Mapped["McpServer"] = relationship(back_populates="tool_grants")
