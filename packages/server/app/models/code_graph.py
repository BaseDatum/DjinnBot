"""Code Knowledge Graph index tracking model."""

from typing import Optional
from sqlalchemy import String, Text, Integer, BigInteger, Index
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class CodeGraphIndex(Base):
    """Tracks the indexing state of a project's code knowledge graph.

    One-to-one relationship with Project. The actual graph data lives in
    KuzuDB on disk at {WORKSPACES_DIR}/{project_id}/.code-graph/
    """

    __tablename__ = "code_graph_indexes"
    __table_args__ = (Index("idx_code_graph_project", "project_id", unique=True),)

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    project_id: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    # pending | indexing | ready | failed | stale
    status: Mapped[str] = mapped_column(String(32), nullable=False, default="pending")
    last_indexed_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)
    last_commit_hash: Mapped[Optional[str]] = mapped_column(String(64), nullable=True)
    node_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    relationship_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    community_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    process_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
