"""Add waitlist and email settings tables.

New tables:
  - waitlist_entries: users who signed up for the waitlist
  - email_settings: SMTP email provider configuration

Revision ID: n1a2b3c4d5e6
Revises: m1a2b3c4d5e6
Create Date: 2026-02-22

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "n1a2b3c4d5e6"
down_revision: Union[str, None] = "m1a2b3c4d5e6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Waitlist entries
    op.create_table(
        "waitlist_entries",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("status", sa.String(32), nullable=False, server_default="waiting"),
        sa.Column("invited_at", sa.BigInteger(), nullable=True),
        sa.Column("registered_at", sa.BigInteger(), nullable=True),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
    )
    op.create_index(
        "idx_waitlist_entries_email", "waitlist_entries", ["email"], unique=True
    )
    op.create_index("idx_waitlist_entries_status", "waitlist_entries", ["status"])

    # Email settings
    op.create_table(
        "email_settings",
        sa.Column("id", sa.String(64), primary_key=True),
        sa.Column("smtp_host", sa.String(256), nullable=False, server_default=""),
        sa.Column("smtp_port", sa.BigInteger(), nullable=False, server_default="587"),
        sa.Column("smtp_username", sa.String(256), nullable=False, server_default=""),
        sa.Column("smtp_password", sa.Text(), nullable=False, server_default=""),
        sa.Column("smtp_use_tls", sa.Boolean(), nullable=False, server_default="true"),
        sa.Column("from_email", sa.String(320), nullable=False, server_default=""),
        sa.Column(
            "from_name", sa.String(256), nullable=False, server_default="DjinnBot"
        ),
        sa.Column("updated_at", sa.BigInteger(), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("email_settings")
    op.drop_index("idx_waitlist_entries_status", table_name="waitlist_entries")
    op.drop_index("idx_waitlist_entries_email", table_name="waitlist_entries")
    op.drop_table("waitlist_entries")
