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
    conn = op.get_bind()

    # ── CIRun: add event + head_branch (idempotent) ──────────────────────────
    existing = {row[0] for row in conn.execute(sa.text(
        "SELECT column_name FROM information_schema.columns WHERE table_name='ci_runs'"
    ))}
    if 'event' not in existing:
        op.add_column('ci_runs', sa.Column('event', sa.String(), nullable=True))
    if 'head_branch' not in existing:
        op.add_column('ci_runs', sa.Column('head_branch', sa.String(), nullable=True))

    # Create indexes only if they don't exist
    idx_existing = {row[0] for row in conn.execute(sa.text(
        "SELECT indexname FROM pg_indexes WHERE tablename='ci_runs'"
    ))}
    if 'ix_ci_runs_event' not in idx_existing:
        op.create_index('ix_ci_runs_event', 'ci_runs', ['event'])
    if 'ix_ci_runs_head_branch' not in idx_existing:
        op.create_index('ix_ci_runs_head_branch', 'ci_runs', ['head_branch'])

    # ── PRFile table (idempotent — create_all may have already created it) ───
    tables = {row[0] for row in conn.execute(sa.text(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'"
    ))}
    if 'pr_files' not in tables:
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
    conn = op.get_bind()
    tables = {row[0] for row in conn.execute(sa.text(
        "SELECT tablename FROM pg_tables WHERE schemaname='public'"
    ))}
    if 'pr_files' in tables:
        op.drop_table('pr_files')
    idx_existing = {row[0] for row in conn.execute(sa.text(
        "SELECT indexname FROM pg_indexes WHERE tablename='ci_runs'"
    ))}
    if 'ix_ci_runs_head_branch' in idx_existing:
        op.drop_index('ix_ci_runs_head_branch', table_name='ci_runs')
    if 'ix_ci_runs_event' in idx_existing:
        op.drop_index('ix_ci_runs_event', table_name='ci_runs')
    op.drop_column('ci_runs', 'head_branch')
    op.drop_column('ci_runs', 'event')
