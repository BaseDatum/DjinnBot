"""add_onboarding_tables

Adds:
- onboarding_context column to projects (JSON blob of accumulated interview data)
- onboarding_sessions table (tracks multi-agent onboarding conversations)
- onboarding_messages table (message history across agent handoffs)

Revision ID: a9f3b2c81e54
Revises: 3c2e6bc66685
Create Date: 2026-02-18 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "a9f3b2c81e54"
down_revision: Union[str, Sequence[str], None] = "3c2e6bc66685"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add onboarding tables and project onboarding_context column."""

    # Add onboarding_context to projects — stores the accumulated vault of
    # facts gathered during the agent-guided onboarding interview.
    op.add_column("projects", sa.Column("onboarding_context", sa.Text(), nullable=True))

    # onboarding_sessions — one per guided project creation attempt.
    # Tracks current agent, phase, and accumulated context across handoffs.
    op.create_table(
        "onboarding_sessions",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column(
            "status", sa.String(length=32), nullable=False, server_default="active"
        ),
        # The project this session is creating (null until finalized)
        sa.Column("project_id", sa.String(length=64), nullable=True),
        # Which agent is currently talking to the user
        sa.Column("current_agent_id", sa.String(length=128), nullable=False),
        # Phase of the interview: intake | strategy | product | done
        sa.Column(
            "phase", sa.String(length=32), nullable=False, server_default="intake"
        ),
        # JSON blob — accumulated context from all agents so far
        sa.Column("context", sa.Text(), nullable=False, server_default="{}"),
        # The underlying chat session ID for the current agent container
        sa.Column("chat_session_id", sa.String(length=128), nullable=True),
        # Model used for this session
        sa.Column(
            "model",
            sa.String(length=128),
            nullable=False,
            server_default="openrouter/anthropic/claude-sonnet-4-5",
        ),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
        sa.Column("completed_at", sa.BigInteger(), nullable=True),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index("idx_onboarding_sessions_status", "onboarding_sessions", ["status"])
    op.create_index(
        "idx_onboarding_sessions_project", "onboarding_sessions", ["project_id"]
    )

    # onboarding_messages — full message log across all agent turns.
    # Each message records which agent sent it, supporting the seamless
    # multi-agent transcript that the UI renders as one conversation.
    op.create_table(
        "onboarding_messages",
        sa.Column("id", sa.String(length=64), nullable=False),
        sa.Column("session_id", sa.String(length=64), nullable=False),
        sa.Column(
            "role", sa.String(length=16), nullable=False
        ),  # user | assistant | system
        sa.Column("content", sa.Text(), nullable=False),
        sa.Column(
            "agent_id", sa.String(length=128), nullable=True
        ),  # which agent produced this
        sa.Column("agent_name", sa.String(length=128), nullable=True),
        sa.Column("agent_emoji", sa.String(length=16), nullable=True),
        # JSON array of tool calls (same format as chat_messages)
        sa.Column("tool_calls", sa.Text(), nullable=True),
        sa.Column("thinking", sa.Text(), nullable=True),
        # If this message triggered a handoff, record it
        sa.Column("handoff_to_agent", sa.String(length=128), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.ForeignKeyConstraint(
            ["session_id"], ["onboarding_sessions.id"], ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "idx_onboarding_messages_session_created",
        "onboarding_messages",
        ["session_id", "created_at"],
    )


def downgrade() -> None:
    """Remove onboarding tables and column."""
    op.drop_index(
        "idx_onboarding_messages_session_created", table_name="onboarding_messages"
    )
    op.drop_table("onboarding_messages")
    op.drop_index("idx_onboarding_sessions_project", table_name="onboarding_sessions")
    op.drop_index("idx_onboarding_sessions_status", table_name="onboarding_sessions")
    op.drop_table("onboarding_sessions")
    op.drop_column("projects", "onboarding_context")
