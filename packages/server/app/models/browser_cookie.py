"""Browser cookie management models.

Two tables:
  browser_cookie_sets   — named sets of cookies uploaded by users for specific domains
  agent_cookie_grants   — per-agent access control: which agents can use which cookie sets
"""

from typing import Optional
from sqlalchemy import (
    String,
    Text,
    Integer,
    Boolean,
    BigInteger,
    Index,
    ForeignKey,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base, now_ms


class BrowserCookieSet(Base):
    """A named set of cookies uploaded by a user for a specific domain.

    Cookie files are stored on JuiceFS at /data/cookies/{agent_id}/{filename}
    in Netscape cookie format. When an agent is granted access, the file
    appears in the agent's container at /home/agent/cookies/{filename}.
    """

    __tablename__ = "browser_cookie_sets"
    __table_args__ = (
        Index("idx_browser_cookie_sets_user", "user_id"),
        Index("idx_browser_cookie_sets_domain", "domain"),
    )

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    # User who uploaded the cookies (no FK — works with auth disabled where
    # user_id is "anonymous" and not present in the users table)
    user_id: Mapped[str] = mapped_column(String(64), nullable=False)
    # Human-readable name (e.g., "LinkedIn", "GitHub")
    name: Mapped[str] = mapped_column(String(256), nullable=False)
    # Primary domain (e.g., ".linkedin.com")
    domain: Mapped[str] = mapped_column(String(512), nullable=False)
    # Stored filename on JuiceFS (just the basename, no path)
    filename: Mapped[str] = mapped_column(String(256), nullable=False)
    # Number of cookies in the file
    cookie_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    # Earliest cookie expiry timestamp (seconds since epoch), or null if unknown
    expires_at: Mapped[Optional[int]] = mapped_column(BigInteger, nullable=True)

    created_at: Mapped[int] = mapped_column(BigInteger, nullable=False)
    updated_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationships
    grants: Mapped[list["AgentCookieGrant"]] = relationship(
        back_populates="cookie_set",
        cascade="all, delete-orphan",
    )


class AgentCookieGrant(Base):
    """Grants an agent access to a browser cookie set.

    When granted, the cookie file is placed into the agent's JuiceFS cookies
    directory so it appears at /home/agent/cookies/{filename} inside the container.
    """

    __tablename__ = "agent_cookie_grants"
    __table_args__ = (
        UniqueConstraint("agent_id", "cookie_set_id", name="uq_agent_cookie_grant"),
        Index("idx_agent_cookie_grants_agent", "agent_id"),
        Index("idx_agent_cookie_grants_cookie", "cookie_set_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    agent_id: Mapped[str] = mapped_column(String(128), nullable=False)
    cookie_set_id: Mapped[str] = mapped_column(
        String(64),
        ForeignKey("browser_cookie_sets.id", ondelete="CASCADE"),
        nullable=False,
    )
    granted_by: Mapped[str] = mapped_column(String(128), nullable=False, default="ui")
    granted_at: Mapped[int] = mapped_column(BigInteger, nullable=False)

    # Relationships
    cookie_set: Mapped["BrowserCookieSet"] = relationship(back_populates="grants")
