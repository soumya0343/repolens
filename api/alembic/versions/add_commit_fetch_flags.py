"""Add is_merge_commit and files_fetch_failed columns to commits

Revision ID: add_commit_fetch_flags
Revises: add_cirun_event_branch_prfile
Create Date: 2026-04-17

"""
from alembic import op
import sqlalchemy as sa

revision = 'add_commit_fetch_flags'
down_revision = 'add_cirun_event_branch_prfile'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column('commits', sa.Column('is_merge_commit', sa.Boolean(),
                                       nullable=False, server_default='false'))
    op.add_column('commits', sa.Column('files_fetch_failed', sa.Boolean(),
                                       nullable=False, server_default='false'))


def downgrade() -> None:
    op.drop_column('commits', 'files_fetch_failed')
    op.drop_column('commits', 'is_merge_commit')
