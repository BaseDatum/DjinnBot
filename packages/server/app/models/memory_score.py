"""Memory scoring models — tracks retrieval outcomes and adaptive memory scores.

Two tables work together:
- memory_retrieval_log: Raw append-only events. Each row = one memory surfaced
  during a recall/wake call, tagged with the step outcome (success/failure)
  once the step completes.
- memory_scores: Materialized aggregates per (agent_id, memory_id). Updated
  atomically on each retrieval batch via upsert. Queried at recall time to
  blend adaptive scores with raw BM25/vector scores.
"""

from typing import Optional
from sqlalchemy import String, Integer, BigInteger, Float, Index, Boolean, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MemoryRetrievalLog(Base):
    """Individual memory retrieval event within a step.

    One row per memory surfaced during a recall() or wake() call.
    After the step completes, the agent runtime POSTs a batch with
    step_success filled in.
    """

    __tablename__ = "memory_retrieval_log"
    __table_args__ = (
        Index("idx_mrl_agent", "agent_id"),
        Index("idx_mrl_memory", "agent_id", "memory_id"),
        Index("idx_mrl_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)

    # ── Context ─────────────────────────────────────────────────────────────
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    request_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # ── Memory identification ───────────────────────────────────────────────
    memory_id: Mapped[str] = mapped_column(String(512), nullable=False)
    memory_title: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    # ── Retrieval metadata ──────────────────────────────────────────────────
    query: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    retrieval_source: Mapped[str] = mapped_column(
        String(32), nullable=False, default="bm25"
    )  # bm25, vector, shared_bm25, shared_vector, wake_bm25, wake_vector
    raw_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.0)

    # ── Outcome ─────────────────────────────────────────────────────────────
    step_success: Mapped[Optional[bool]] = mapped_column(Boolean, nullable=True)

    # ── Timestamps ──────────────────────────────────────────────────────────
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class MemoryScore(Base):
    """Materialized aggregate score for a memory within an agent's vault.

    Updated atomically via upsert when retrieval batches arrive.
    Queried at recall time to blend with raw search scores.

    The adaptive_score is a pre-computed blend of:
      success_rate * recency_weight * frequency_signal

    Where:
      success_rate = success_count / access_count (or 0.5 if < 3 accesses)
      recency_weight = decays toward 0.5 as last_accessed ages (30-day half-life)
      frequency_signal = log(access_count + 1) capped at 1.0
    """

    __tablename__ = "memory_scores"
    __table_args__ = (
        Index("idx_ms_agent", "agent_id"),
        Index("idx_ms_adaptive", "agent_id", "adaptive_score"),
    )

    # Composite natural key: one row per (agent_id, memory_id)
    id: Mapped[str] = mapped_column(String(128), primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    memory_id: Mapped[str] = mapped_column(String(512), nullable=False)

    # ── Counters ────────────────────────────────────────────────────────────
    access_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    success_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    failure_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # ── Derived scores ──────────────────────────────────────────────────────
    success_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    adaptive_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)

    # ── Timestamps ──────────────────────────────────────────────────────────
    last_accessed: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
