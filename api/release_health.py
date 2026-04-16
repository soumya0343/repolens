"""
Release Health Tracker - DORA Metrics Analysis

This module calculates:
- Deployment Frequency (DF): PR merge rate
- Lead Time for Changes (LTTC): Commit to Merge duration
- Change Failure Rate (CFR): Failed CI runs post-merge
- Time to Restore Service (TTRS): Mean time to recovery
"""

import asyncio
from typing import List, Dict, Optional
from datetime import datetime, timedelta, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, and_

from models import PullRequest, Commit, CIRun, Repo, PRFile, CommitFile

class ReleaseHealthTracker:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def get_dora_metrics(self, repo_id: str, days: int = 30) -> Dict:
        """
        Calculate DORA metrics for a repository over a given period.
        """
        since = datetime.now(timezone.utc) - timedelta(days=days)

        # Fetch repo's current default branch for CFR + MTTR filtering
        repo_result = await self.db.execute(select(Repo).where(Repo.id == repo_id))
        repo = repo_result.scalar_one_or_none()
        default_branch = repo.default_branch if repo else None

        # 1. Deployment Frequency
        # Using merged PRs as a proxy for deployments
        pr_stmt = select(func.count(PullRequest.id)).where(
            and_(
                PullRequest.repo_id == repo_id,
                PullRequest.merged_at >= since
            )
        )
        pr_result = await self.db.execute(pr_stmt)
        merged_count = pr_result.scalar() or 0
        df = merged_count / days
        
        # 2. Lead Time for Changes
        # Ideal DORA definition: first commit on branch → merge.
        # We approximate using PRFile→CommitFile join to find the oldest commit
        # by the PR author that touched any file in the PR, within 90 days of merge.
        # Falls back to PR.created_at → merged_at when PRFile data is absent (legacy repos).
        lt_lookback = timedelta(days=90)
        lt_stmt = (
            select(
                PullRequest.merged_at,
                func.min(Commit.committed_date).label("first_commit_date"),
            )
            .join(PRFile, PRFile.pr_id == PullRequest.id)
            .join(CommitFile, CommitFile.file_path == PRFile.path)
            .join(Commit, and_(
                Commit.id == CommitFile.commit_id,
                Commit.author_login == PullRequest.author_login,
                Commit.repo_id == PullRequest.repo_id,
                Commit.committed_date <= PullRequest.merged_at,
                Commit.committed_date >= PullRequest.merged_at - lt_lookback,
            ))
            .where(
                and_(
                    PullRequest.repo_id == repo_id,
                    PullRequest.merged_at >= since,
                    PullRequest.author_login.isnot(None),
                )
            )
            .group_by(PullRequest.id, PullRequest.merged_at)
        )
        lt_result = await self.db.execute(lt_stmt)
        lt_rows = lt_result.all()

        if lt_rows:
            # PRFile data available — use first-commit-on-branch lead time
            durations = [
                (merged - first_commit).total_seconds()
                for merged, first_commit in lt_rows
                if merged and first_commit and merged > first_commit
            ]
        else:
            # Fallback: PR creation → merge (old proxy, less accurate)
            fb_stmt = select(PullRequest.created_at, PullRequest.merged_at).where(
                and_(
                    PullRequest.repo_id == repo_id,
                    PullRequest.merged_at >= since,
                )
            )
            fb_result = await self.db.execute(fb_stmt)
            durations = [
                (merged - created).total_seconds()
                for created, merged in fb_result.all()
                if created and merged
            ]

        avg_lead_time = (sum(durations) / len(durations) / 3600) if durations else 0  # in hours
        
        # 3. Change Failure Rate
        # Only post-merge pushes to the default branch — not scheduled runs, PRs, or manual triggers.
        # Rows without event/head_branch are legacy (pre-schema-fix) — excluded via IS NOT NULL.
        cfr_filters = [
            CIRun.repo_id == repo_id,
            CIRun.created_at >= since,
            CIRun.event == "push",
            CIRun.event.isnot(None),
        ]
        if default_branch:
            cfr_filters.append(CIRun.head_branch == default_branch)

        ci_stmt = select(func.count(CIRun.id), CIRun.conclusion).where(
            and_(*cfr_filters)
        ).group_by(CIRun.conclusion)

        ci_result = await self.db.execute(ci_stmt)
        ci_stats = {row[1]: row[0] for row in ci_result.all()}

        total_ci = sum(ci_stats.values())
        failed_ci = ci_stats.get('failure', 0)
        cfr = (failed_ci / total_ci) if total_ci > 0 else None

        # 4. Mean Time to Restore (MTTR)
        # Same filter as CFR: push events on default branch only.
        mttr_base = [
            CIRun.repo_id == repo_id,
            CIRun.event == "push",
            CIRun.event.isnot(None),
        ]
        if default_branch:
            mttr_base.append(CIRun.head_branch == default_branch)

        failure_times_stmt = select(CIRun.updated_at).where(
            and_(*mttr_base, CIRun.conclusion == "failure", CIRun.created_at >= since)
        ).order_by(CIRun.updated_at)

        success_times_stmt = select(CIRun.created_at).where(
            and_(*mttr_base, CIRun.conclusion == "success")
        ).order_by(CIRun.created_at)

        failure_times = [r[0] for r in (await self.db.execute(failure_times_stmt)).all() if r[0]]
        success_times = [r[0] for r in (await self.db.execute(success_times_stmt)).all() if r[0]]

        recovery_durations = []
        for failure_ts in failure_times:
            # Find first success after this failure
            next_success = next((s for s in success_times if s > failure_ts), None)
            if next_success:
                recovery_durations.append((next_success - failure_ts).total_seconds())

        avg_mttr_hours = (
            sum(recovery_durations) / len(recovery_durations) / 3600
            if recovery_durations
            else None
        )

        return {
            "deployment_frequency": {
                "value": round(df, 2),
                "rating": self._rate_df(df),
                "label": "Deployments per day"
            },
            "lead_time_for_changes": {
                "value": round(avg_lead_time, 1),
                "rating": self._rate_lt(avg_lead_time),
                "label": "Hours from first branch commit to merge (falls back to PR creation when PRFile data absent)"
            },
            "change_failure_rate": {
                "value": round(cfr * 100, 1) if cfr is not None else None,
                "rating": self._rate_cfr(cfr) if cfr is not None else "unavailable",
                "label": "Percentage of failed CI runs on default branch (push events only)",
            },
            "time_to_restore": {
                "value": round(avg_mttr_hours, 1) if avg_mttr_hours is not None else None,
                "rating": self._rate_mttr(avg_mttr_hours) if avg_mttr_hours is not None else "unknown",
                "label": "Hours to recover from failure",
            },
        }

    def _rate_df(self, val: float) -> str:
        if val >= 1: return "elite"
        if val >= 0.1: return "high"
        if val >= 0.01: return "medium"
        return "low"

    def _rate_lt(self, hours: float) -> str:
        if hours <= 24: return "elite"
        if hours <= 24 * 7: return "high"
        if hours <= 24 * 30: return "medium"
        return "low"

    def _rate_mttr(self, hours: float) -> str:
        if hours <= 1: return "elite"
        if hours <= 24: return "high"
        if hours <= 168: return "medium"
        return "low"

    def _rate_cfr(self, rate: float) -> str:
        if rate <= 0.05: return "elite"
        if rate <= 0.15: return "high"
        if rate <= 0.30: return "medium"
        return "low"

async def get_release_health_tracker(db: AsyncSession):
    return ReleaseHealthTracker(db)
