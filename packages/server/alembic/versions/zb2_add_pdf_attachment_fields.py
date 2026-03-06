"""add_pdf_attachment_fields

Add structured PDF fields to chat_attachments for OpenDataLoader integration:
- structured_json: Full JSON output from opendataloader-pdf
- pdf_title, pdf_author, pdf_page_count: PDF metadata
- vault_ingest_status, vault_doc_slug, vault_chunk_count: Shared vault ingest tracking

Revision ID: zb2_pdf_fields
Revises: zb1_merge_heads
Create Date: 2026-02-26 22:00:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "zb2_pdf_fields"
down_revision: Union[str, Sequence[str], None] = "zb1_merge_heads"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "chat_attachments",
        sa.Column("structured_json", sa.Text(), nullable=True),
    )
    op.add_column(
        "chat_attachments",
        sa.Column("pdf_title", sa.String(512), nullable=True),
    )
    op.add_column(
        "chat_attachments",
        sa.Column("pdf_author", sa.String(256), nullable=True),
    )
    op.add_column(
        "chat_attachments",
        sa.Column("pdf_page_count", sa.Integer(), nullable=True),
    )
    op.add_column(
        "chat_attachments",
        sa.Column("vault_ingest_status", sa.String(32), nullable=True),
    )
    op.add_column(
        "chat_attachments",
        sa.Column("vault_doc_slug", sa.String(128), nullable=True),
    )
    op.add_column(
        "chat_attachments",
        sa.Column("vault_chunk_count", sa.Integer(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("chat_attachments", "vault_chunk_count")
    op.drop_column("chat_attachments", "vault_doc_slug")
    op.drop_column("chat_attachments", "vault_ingest_status")
    op.drop_column("chat_attachments", "pdf_page_count")
    op.drop_column("chat_attachments", "pdf_author")
    op.drop_column("chat_attachments", "pdf_title")
    op.drop_column("chat_attachments", "structured_json")
