"""Add CIRun event + head_branch columns and PRFile table

Revision ID: add_cirun_event_branch_prfile
Revises: add_commit_files
Create Date: 2026-04-16

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = 'add_cirun_event_branch_prfile'
down_revision = 'add_commit_files'
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── CIRun: add event + head_branch ───────────────────────────────────────
    op.add_column('ci_runs', sa.Column('event', sa.String(), nullable=True))
    op.add_column('ci_runs', sa.Column('head_branch', sa.String(), nullable=True))
    op.create_index('ix_ci_runs_event', 'ci_runs', ['event'])
    op.create_index('ix_ci_runs_head_branch', 'ci_runs', ['head_branch'])

    # ── PRFile table ─────────────────────────────────────────────────────────
    op.create_table(
        'pr_files',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text('gen_random_uuid()')),
        sa.Column('pr_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('pull_requests.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('path', sa.String(), nullable=False, index=True),
        sa.Column('additions', sa.Integer(), nullable=True),
        sa.Column('deletions', sa.Integer(), nullable=True),
        sa.Column('change_type', sa.String(), nullable=True),
    )


def downgrade() -> None:
    op.drop_table('pr_files')
    op.drop_index('ix_ci_runs_head_branch', table_name='ci_runs')
    op.drop_index('ix_ci_runs_event', table_name='ci_runs')
    op.drop_column('ci_runs', 'head_branch')
    op.drop_column('ci_runs', 'event')
