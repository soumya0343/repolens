"""add_secret_findings

Revision ID: add_secret_findings
Revises: add_commit_fetch_flags
Create Date: 2026-04-17 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = 'add_secret_findings'
down_revision: Union[str, Sequence[str], None] = 'add_commit_fetch_flags'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)

    # The API currently calls Base.metadata.create_all() on startup. In local
    # dev that can create this table before Alembic records the revision, so
    # this migration is intentionally tolerant of a pre-existing table.
    if 'secret_findings' not in inspector.get_table_names():
        op.create_table(
            'secret_findings',
            sa.Column('id', sa.UUID(), nullable=False),
            sa.Column('repo_id', sa.UUID(), nullable=False),
            sa.Column('source', sa.String(length=32), nullable=False),
            sa.Column('pr_number', sa.Integer(), nullable=True),
            sa.Column('commit_sha', sa.String(), nullable=True),
            sa.Column('file_path', sa.String(), nullable=False),
            sa.Column('line_number', sa.Integer(), nullable=False),
            sa.Column('detector', sa.String(length=64), nullable=False),
            sa.Column('severity', sa.String(length=32), nullable=False),
            sa.Column('confidence', sa.Float(), nullable=False),
            sa.Column('masked_value', sa.String(length=255), nullable=False),
            sa.Column('fingerprint_hash', sa.String(length=64), nullable=False),
            sa.Column('status', sa.String(length=32), nullable=False),
            sa.Column('message', sa.String(), nullable=True),
            sa.Column('first_seen_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
            sa.Column('last_seen_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=True),
            sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
            sa.ForeignKeyConstraint(['repo_id'], ['repos.id'], ondelete='CASCADE'),
            sa.PrimaryKeyConstraint('id'),
            sa.UniqueConstraint('repo_id', 'source', 'pr_number', 'fingerprint_hash', name='uq_secret_finding_scope_fingerprint'),
        )

    existing_indexes = {idx['name'] for idx in inspector.get_indexes('secret_findings')}
    indexes = {
        op.f('ix_secret_findings_commit_sha'): ['commit_sha'],
        op.f('ix_secret_findings_file_path'): ['file_path'],
        op.f('ix_secret_findings_fingerprint_hash'): ['fingerprint_hash'],
        op.f('ix_secret_findings_pr_number'): ['pr_number'],
        op.f('ix_secret_findings_repo_id'): ['repo_id'],
        op.f('ix_secret_findings_status'): ['status'],
    }
    for index_name, columns in indexes.items():
        if index_name not in existing_indexes:
            op.create_index(index_name, 'secret_findings', columns, unique=False)


def downgrade() -> None:
    op.drop_index(op.f('ix_secret_findings_status'), table_name='secret_findings')
    op.drop_index(op.f('ix_secret_findings_repo_id'), table_name='secret_findings')
    op.drop_index(op.f('ix_secret_findings_pr_number'), table_name='secret_findings')
    op.drop_index(op.f('ix_secret_findings_fingerprint_hash'), table_name='secret_findings')
    op.drop_index(op.f('ix_secret_findings_file_path'), table_name='secret_findings')
    op.drop_index(op.f('ix_secret_findings_commit_sha'), table_name='secret_findings')
    op.drop_table('secret_findings')
