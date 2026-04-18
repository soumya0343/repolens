"""add_api_performance_indexes

Revision ID: add_api_performance_indexes
Revises: add_secret_findings
Create Date: 2026-04-17

"""
from alembic import op
import sqlalchemy as sa


revision = "add_api_performance_indexes"
down_revision = "add_secret_findings"
branch_labels = None
depends_on = None


def _indexes(table_name: str) -> set[str]:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    return {idx["name"] for idx in inspector.get_indexes(table_name)}


def _create_index(name: str, table_name: str, columns: list[str]) -> None:
    if name not in _indexes(table_name):
        op.create_index(name, table_name, columns, unique=False)


def upgrade() -> None:
    _create_index("ix_repos_owner_name", "repos", ["owner", "name"])
    _create_index("ix_user_repos_user_id_repo_id", "user_repos", ["user_id", "repo_id"])
    _create_index("ix_user_repos_repo_id", "user_repos", ["repo_id"])

    _create_index("ix_commits_repo_committed_date", "commits", ["repo_id", "committed_date"])
    _create_index("ix_commits_repo_author_date", "commits", ["repo_id", "author_login", "committed_date"])

    _create_index("ix_pull_requests_repo_created_at", "pull_requests", ["repo_id", "created_at"])
    _create_index("ix_pull_requests_repo_state_created_at", "pull_requests", ["repo_id", "state", "created_at"])
    _create_index("ix_pull_requests_repo_merged_at", "pull_requests", ["repo_id", "merged_at"])

    _create_index("ix_pr_comments_pr_id_created_at", "pr_comments", ["pr_id", "created_at"])
    _create_index("ix_pr_files_pr_id_path", "pr_files", ["pr_id", "path"])

    _create_index("ix_ci_runs_repo_created_at", "ci_runs", ["repo_id", "created_at"])
    _create_index("ix_ci_runs_repo_event_branch_created", "ci_runs", ["repo_id", "event", "head_branch", "created_at"])
    _create_index("ix_ci_runs_repo_name_sha_conclusion", "ci_runs", ["repo_id", "name", "head_sha", "conclusion"])

    _create_index("ix_commit_files_commit_id_file_path", "commit_files", ["commit_id", "file_path"])
    _create_index("ix_commit_files_file_path_commit_id", "commit_files", ["file_path", "commit_id"])

    _create_index("ix_arch_analysis_repo_parsed_at", "arch_analysis", ["repo_id", "parsed_at"])
    _create_index("ix_repo_score_snapshots_repo_recorded_at", "repo_score_snapshots", ["repo_id", "recorded_at"])
    _create_index("ix_secret_findings_repo_status_last_seen", "secret_findings", ["repo_id", "status", "last_seen_at"])


def downgrade() -> None:
    for table_name, index_name in [
        ("secret_findings", "ix_secret_findings_repo_status_last_seen"),
        ("repo_score_snapshots", "ix_repo_score_snapshots_repo_recorded_at"),
        ("arch_analysis", "ix_arch_analysis_repo_parsed_at"),
        ("commit_files", "ix_commit_files_file_path_commit_id"),
        ("commit_files", "ix_commit_files_commit_id_file_path"),
        ("ci_runs", "ix_ci_runs_repo_name_sha_conclusion"),
        ("ci_runs", "ix_ci_runs_repo_event_branch_created"),
        ("ci_runs", "ix_ci_runs_repo_created_at"),
        ("pr_files", "ix_pr_files_pr_id_path"),
        ("pr_comments", "ix_pr_comments_pr_id_created_at"),
        ("pull_requests", "ix_pull_requests_repo_merged_at"),
        ("pull_requests", "ix_pull_requests_repo_state_created_at"),
        ("pull_requests", "ix_pull_requests_repo_created_at"),
        ("commits", "ix_commits_repo_author_date"),
        ("commits", "ix_commits_repo_committed_date"),
        ("user_repos", "ix_user_repos_repo_id"),
        ("user_repos", "ix_user_repos_user_id_repo_id"),
        ("repos", "ix_repos_owner_name"),
    ]:
        if index_name in _indexes(table_name):
            op.drop_index(index_name, table_name=table_name)
