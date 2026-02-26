"""LLM call log model — tracks individual LLM API calls within sessions/runs."""

from typing import Optional
from sqlalchemy import String, Text, Integer, BigInteger, Float, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class LlmCallLog(Base):
    """Individual LLM API call within a session or run.

    Each row records one round-trip to an LLM provider, capturing:
    - Which session/run and request triggered it
    - Provider + model used
    - Token usage (input / output / cache)
    - Estimated cost
    - Latency
    - Which API key type was used (personal / admin_shared / instance)
    """

    __tablename__ = "llm_call_logs"
    __table_args__ = (
        Index("idx_llm_call_logs_session", "session_id"),
        Index("idx_llm_call_logs_run", "run_id"),
        Index("idx_llm_call_logs_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)

    # ── Context ─────────────────────────────────────────────────────────────
    # At least one of session_id / run_id will be set.
    # Chat sessions set session_id (the chat_session id).
    # Pipeline runs set run_id (the pipeline run id) and optionally session_id
    # (the step session id within the run).
    session_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    request_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # ── User attribution ────────────────────────────────────────────────────
    # Which user's keys funded this call.  Set when key resolution is per-user
    # (chat sessions with a logged-in user, project runs with an executing_user).
    # NULL for system-level / webhook-triggered calls with no user context.
    user_id: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)

    # ── Model info ──────────────────────────────────────────────────────────
    provider: Mapped[str] = mapped_column(
        String(64), nullable=False
    )  # e.g. "anthropic"
    model: Mapped[str] = mapped_column(
        String(128), nullable=False
    )  # e.g. "claude-sonnet-4"

    # ── Key source ──────────────────────────────────────────────────────────
    key_source: Mapped[Optional[str]] = mapped_column(
        String(32), nullable=True
    )  # "personal", "admin_shared", "instance"
    key_masked: Mapped[Optional[str]] = mapped_column(
        String(64), nullable=True
    )  # e.g. "sk-ant-...7xQ2"

    # ── Token usage ─────────────────────────────────────────────────────────
    input_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_read_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    cache_write_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    total_tokens: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # ── Cost (USD) ──────────────────────────────────────────────────────────
    cost_input: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cost_output: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    cost_total: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    # True when cost was computed from sibling pricing or OpenRouter live API
    # rather than exact registry data.  Dashboard should show "~" indicator.
    cost_approximate: Mapped[bool] = mapped_column(default=False, nullable=False)

    # ── Performance ─────────────────────────────────────────────────────────
    duration_ms: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)

    # ── Metadata ────────────────────────────────────────────────────────────
    # Number of tool calls in this turn (0 = pure text response)
    tool_call_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Whether extended thinking was enabled
    has_thinking: Mapped[bool] = mapped_column(default=False, nullable=False)
    # Stop reason: "stop", "tool_use", "max_tokens", etc.
    stop_reason: Mapped[Optional[str]] = mapped_column(String(32), nullable=True)

    # ── Timestamps ──────────────────────────────────────────────────────────
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
