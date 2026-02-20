"""Agent assignment models."""
from typing import Optional
from sqlalchemy import String, BigInteger, ForeignKey, Index
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base


class ProjectAgent(Base):
    """Agent assignment to a project."""
    __tablename__ = "project_agents"
    __table_args__ = (
        Index("idx_project_agents_agent", "agent_id"),
        Index("idx_project_agents_project", "project_id"),
    )
    
    project_id: Mapped[str] = mapped_column(String(64), ForeignKey("projects.id", ondelete="CASCADE"), primary_key=True)
    agent_id: Mapped[str] = mapped_column(String(128), primary_key=True)
    role: Mapped[str] = mapped_column(String(32), nullable=False, default="member")
    assigned_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    assigned_by: Mapped[Optional[str]] = mapped_column(String(128), nullable=True)
    
    # Relationships
    project: Mapped["Project"] = relationship(back_populates="agents")


# Avoid circular import
from app.models.project import Project