"""
Release Health Tracker - DORA Metrics Analysis

Calculates:
- Deployment Frequency (DF): PR merge rate
- Lead Time for Changes (LTTC): Commit to Merge duration
- Change Failure Rate (CFR): Failed CI runs post-merge
- Time to Restore Service (TTRS): Mean time to recovery

Window selection is adaptive: tries 30 → 90 → 365 days, uses the first
window that has at least one merged PR or CI run. The chosen window is
returned as `window_days` so the frontend can display it.
"""

from typing import Dict, Optional
from datetime import datetime, timedelta, timezone
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, and_, or_

from models import PullRequest, Commit, CIRun, Repo, PRFile, CommitFile

_CANDIDATE_WINDOWS = [30, 90, 365]


class ReleaseHealthTracker:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def _count_activity(self, repo_id: str, since: datetime, default_branch: Optional[str]) -> int:
        """Return total merged PRs + push CI runs in the window — used for adaptive window selection."""
        pr_stmt = select(func.count(PullRequest.id)).where(
            and_(PullRequest.repo_id == repo_id, PullRequest.merged_at >= since)
        )
        pr_count = (await self.db.execute(pr_stmt)).scalar() or 0
        if pr_count:
            return pr_count

        ci_filters = [CIRun.repo_id == repo_id, CIRun.created_at >= since, CIRun.event == "push"]
        if default_branch:
            ci_filters.append(CIRun.head_branch == default_branch)
        ci_stmt = select(func.count(CIRun.id)).where(and_(*ci_filters))
        ci_count = (await self.db.execute(ci_stmt)).scalar() or 0
        return ci_count

    async def get_dora_metrics(self, repo_id: str, days: int = 30) -> Dict:
        repo_result = await self.db.execute(select(Repo).where(Repo.id == repo_id))
        repo = repo_result.scalar_one_or_none()
        default_branch = repo.default_branch if repo else None

        # Adaptive window: use caller-supplied days if it has data, otherwise expand
        candidates = sorted(set([days] + _CANDIDATE_WINDOWS))
        window_days = candidates[-1]  # fallback to largest
        for w in candidates:
            since_candidate = datetime.now(timezone.utc) - timedelta(days=w)
            if await self._count_activity(repo_id, since_candidate, default_branch) > 0:
                window_days = w
                break

        since = datetime.now(timezone.utc) - timedelta(days=window_days)

        # ── 1. Deployment Frequency ──────────────────────────────────────────
        pr_stmt = select(func.count(PullRequest.id)).where(
            and_(PullRequest.repo_id == repo_id, PullRequest.merged_at >= since)
        )
        merged_count = (await self.db.execute(pr_stmt)).scalar() or 0

        if merged_count == 0:
            push_filters = [
                CIRun.repo_id == repo_id,
                CIRun.created_at >= since,
                CIRun.event == "push",
            ]
            if default_branch:
                push_filters.append(CIRun.head_branch == default_branch)
            push_stmt = select(func.count(CIRun.id)).where(and_(*push_filters))
            deploy_count = (await self.db.execute(push_stmt)).scalar() or 0
            df_source = "ci_pushes"
        else:
            deploy_count = merged_count
            df_source = "merged_prs"

        df = deploy_count / window_days if deploy_count else 0.0

        if deploy_count == 0:
            df_reason = "No merged PRs or push CI runs found even across the full 1-year lookback. Push code or merge a PR to start tracking."
        elif df_source == "ci_pushes":
            df_reason = f"No PRs detected — using push CI runs as deployment proxy ({deploy_count} runs over {window_days}d)."
        else:
            df_reason = None

        # ── 2. Lead Time for Changes ─────────────────────────────────────────
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
            .where(and_(
                PullRequest.repo_id == repo_id,
                PullRequest.merged_at >= since,
                PullRequest.author_login.isnot(None),
            ))
            .group_by(PullRequest.id, PullRequest.merged_at)
        )
        lt_rows = (await self.db.execute(lt_stmt)).all()
        lt_method = "commit"

        if lt_rows:
            durations = [
                (merged - first_commit).total_seconds()
                for merged, first_commit in lt_rows
                if merged and first_commit and merged > first_commit
            ]
        else:
            # Fallback: PR creation → merge
            fb_stmt = select(PullRequest.created_at, PullRequest.merged_at).where(
                and_(PullRequest.repo_id == repo_id, PullRequest.merged_at >= since)
            )
            fb_rows = (await self.db.execute(fb_stmt)).all()
            durations = [
                (merged - created).total_seconds()
                for created, merged in fb_rows
                if created and merged
            ]
            lt_method = "pr_creation" if fb_rows else "none"

        avg_lead_time = (sum(durations) / len(durations) / 3600) if durations else None

        if avg_lead_time is None:
            lt_reason = "No merged PRs in window — lead time cannot be computed."
        elif lt_method == "pr_creation":
            lt_reason = "Approximated from PR open → merge (commit-level data not yet ingested)."
        else:
            lt_reason = None

        # ── 3. Change Failure Rate ───────────────────────────────────────────
        # Strict: push events on default branch. Falls back to all CI runs if event is NULL (legacy).
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
        ci_stats = {row[1]: row[0] for row in (await self.db.execute(ci_stmt)).all()}
        total_ci = sum(ci_stats.values())
        cfr_method = "push"

        if total_ci == 0:
            # Legacy runs stored without event field — use all CI runs for this repo
            legacy_filters = [CIRun.repo_id == repo_id, CIRun.created_at >= since]
            legacy_stmt = select(func.count(CIRun.id), CIRun.conclusion).where(
                and_(*legacy_filters)
            ).group_by(CIRun.conclusion)
            ci_stats = {row[1]: row[0] for row in (await self.db.execute(legacy_stmt)).all()}
            total_ci = sum(ci_stats.values())
            cfr_method = "all_runs"

        failed_ci = ci_stats.get('failure', 0)
        cfr = (failed_ci / total_ci) if total_ci > 0 else None

        if cfr is None:
            cfr_reason = "No CI runs found in window."
        elif cfr_method == "all_runs":
            cfr_reason = "CI event metadata missing — computed across all run types, not push-only."
        elif failed_ci == 0:
            cfr_reason = None
        else:
            cfr_reason = None

        # ── 4. Mean Time to Restore ──────────────────────────────────────────
        mttr_base = [CIRun.repo_id == repo_id, CIRun.event == "push", CIRun.event.isnot(None)]
        if default_branch:
            mttr_base.append(CIRun.head_branch == default_branch)

        if cfr_method == "all_runs":
            # Consistent with CFR fallback: use all runs
            mttr_base = [CIRun.repo_id == repo_id]

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
            next_success = next((s for s in success_times if s > failure_ts), None)
            if next_success:
                recovery_durations.append((next_success - failure_ts).total_seconds())

        avg_mttr_hours = (
            sum(recovery_durations) / len(recovery_durations) / 3600
            if recovery_durations else None
        )

        mttr_reason = "No failures found in window — nothing to restore from." if avg_mttr_hours is None else None

        has_data = deploy_count > 0 or total_ci > 0 or merged_count > 0

        return {
            "has_data": has_data,
            "window_days": window_days,
            "deployment_frequency": {
                "value": round(df, 2) if deploy_count > 0 else None,
                "rating": self._rate_df(df) if deploy_count > 0 else "unavailable",
                "label": (
                    "Deployments per day (push CI runs — no PRs detected)"
                    if df_source == "ci_pushes" else
                    "Deployments per day (merged PRs)"
                ),
                "reason": df_reason,
            },
            "lead_time_for_changes": {
                "value": round(avg_lead_time, 1) if avg_lead_time is not None else None,
                "rating": self._rate_lt(avg_lead_time) if avg_lead_time is not None else "unavailable",
                "label": "Hours from first branch commit to merge",
                "reason": lt_reason,
            },
            "change_failure_rate": {
                "value": round(cfr * 100, 1) if cfr is not None else None,
                "rating": self._rate_cfr(cfr) if cfr is not None else "unavailable",
                "label": "% of CI runs that failed",
                "reason": cfr_reason,
            },
            "time_to_restore": {
                "value": round(avg_mttr_hours, 1) if avg_mttr_hours is not None else None,
                "rating": self._rate_mttr(avg_mttr_hours) if avg_mttr_hours is not None else "unknown",
                "label": "Hours to recover from a failure",
                "reason": mttr_reason,
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
