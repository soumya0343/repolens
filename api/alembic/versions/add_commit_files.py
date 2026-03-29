"""Add commit_files table

Revision ID: add_commit_files
Revises: 75bfb673ce4f
Create Date: 2026-03-18

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'add_commit_files'
down_revision = '75bfb673ce4f'
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        'commit_files',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True, server_default=sa.text('gen_random_uuid()')),
        sa.Column('commit_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('commits.id', ondelete='CASCADE'), index=True),
        sa.Column('file_path', sa.String(), index=True),
        sa.Column('additions', sa.Integer(), default=0),
        sa.Column('deletions', sa.Integer(), default=0),
        sa.Column('change_type', sa.String()),  # ADDED, MODIFIED, DELETED
    )
    
    # Create composite index for common queries
    op.create_index('ix_commit_files_repo_commit', 'commit_files', ['commit_id'])


def downgrade() -> None:
    op.drop_index('ix_commit_files_repo_commit', table_name='commit_files')
    op.drop_table('commit_files')
