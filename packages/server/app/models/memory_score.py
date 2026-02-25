"""Memory scoring models — agent-driven memory valuations.

Four tables work together:
- memory_retrieval_log: Raw append-only events. Each row = one memory surfaced
  during a recall/wake call. Used for analytics and access counting.
- memory_valuations: Agent-authored usefulness ratings. Each row = one explicit
  "useful" or "not useful" judgment from the agent about a specific memory
  after it was recalled and consumed.  This is the PRIMARY scoring signal.
- memory_gaps: Knowledge the agent needed but couldn't find.  Aggregated to
  surface systemic knowledge holes in the dashboard.
- memory_scores: Materialized aggregates per (agent_id, memory_id). Updated
  atomically on retrieval batches and valuation events.  Queried at recall
  time to blend adaptive scores with raw BM25/vector scores.
"""

from typing import Optional
from sqlalchemy import String, Integer, BigInteger, Float, Index, Boolean, Text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MemoryRetrievalLog(Base):
    """Individual memory retrieval event within a step.

    One row per memory surfaced during a recall() or wake() call.
    Pure analytics / access-count record — no outcome signal.
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

    # ── Timestamps ──────────────────────────────────────────────────────────
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class MemoryValuation(Base):
    """Agent-authored usefulness rating for a specific memory.

    Created when an agent calls the rate_memories tool after recalling
    and consuming memories.  This is the PRIMARY signal for adaptive
    scoring — it captures whether the memory actually helped the agent
    accomplish its current task, as judged by the agent itself.

    The boolean ``useful`` field is intentionally simple: agents are
    reliable at binary "helped / didn't help" judgments.  Numeric scales
    add calibration noise.  The EMA of boolean signals converges fast.
    """

    __tablename__ = "memory_valuations"
    __table_args__ = (
        Index("idx_mv_agent", "agent_id"),
        Index("idx_mv_memory", "agent_id", "memory_id"),
        Index("idx_mv_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)

    # ── Context ─────────────────────────────────────────────────────────────
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # ── Memory identification ───────────────────────────────────────────────
    memory_id: Mapped[str] = mapped_column(String(512), nullable=False)
    memory_title: Mapped[Optional[str]] = mapped_column(String(512), nullable=True)

    # ── Valuation ───────────────────────────────────────────────────────────
    useful: Mapped[bool] = mapped_column(Boolean, nullable=False)

    # ── Timestamps ──────────────────────────────────────────────────────────
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class MemoryGap(Base):
    """Knowledge the agent needed but couldn't find in its memory vault.

    Created when an agent calls rate_memories with a ``gap`` description.
    Aggregated in the dashboard to surface systemic knowledge holes that
    should be filled — either manually or via an automated research task.
    """

    __tablename__ = "memory_gaps"
    __table_args__ = (
        Index("idx_mg_agent", "agent_id"),
        Index("idx_mg_created", "created_at"),
    )

    id: Mapped[str] = mapped_column(String(128), primary_key=True)

    # ── Context ─────────────────────────────────────────────────────────────
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    session_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)
    run_id: Mapped[Optional[str]] = mapped_column(String(256), nullable=True)

    # ── Gap description ─────────────────────────────────────────────────────
    description: Mapped[str] = mapped_column(Text, nullable=False)
    query_attempted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Timestamps ──────────────────────────────────────────────────────────
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)


class MemoryScore(Base):
    """Materialized aggregate score for a memory within an agent's vault.

    Updated atomically via upsert when retrieval or valuation events arrive.
    Queried at recall time to blend with raw search scores.

    The adaptive_score is a pre-computed blend of:
      usefulness_rate * w_usefulness + recency * w_recency + frequency * w_freq

    Where:
      usefulness_rate = useful_count / valuation_count (or 0.5 if < min_valuations)
      recency = exponential decay from last_accessed (configurable half-life)
      frequency = log(access_count + 1) normalized and capped

    The usefulness_rate is the PRIMARY signal — derived from explicit agent
    valuations via the rate_memories tool, NOT from step success/failure.
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
    valuation_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    useful_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    not_useful_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    # ── Derived scores ──────────────────────────────────────────────────────
    usefulness_rate: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)
    adaptive_score: Mapped[float] = mapped_column(Float, nullable=False, default=0.5)

    # ── Timestamps ──────────────────────────────────────────────────────────
    last_accessed: Mapped[int] = mapped_column(BigInteger, nullable=False)
    last_valued: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
