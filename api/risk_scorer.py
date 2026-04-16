"""
Unified Risk Scorer - Aggregates scores from all analysis engines.
"""

import asyncio
from typing import Dict, Optional
from datetime import datetime, timedelta, timezone

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, and_

from models import Repo, ArchAnalysis, CIRun, CommitFile
from cochange_oracle import get_cochange_oracle
from churn_analyzer import get_churn_analyzer
from chronos_graph import get_chronos_graph


class UnifiedRiskScorer:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def _coupling_risk(self, repo_id: str) -> float:
        oracle = await get_cochange_oracle(self.db)
        coupling_data = await oracle.analyze_repository(repo_id)
        links = coupling_data.get("links", [])
        if not links:
            return None
        risk = sum(l["value"] for l in links) / len(links)
        return min(risk, 1.0)

    async def _arch_risk(self, repo_id: str) -> float:
        arch_stmt = select(ArchAnalysis).where(ArchAnalysis.repo_id == repo_id)
        arch_result = await self.db.execute(arch_stmt)
        arch_analysis = arch_result.scalar_one_or_none()
        if arch_analysis is None:
            return None
        violations = arch_analysis.violations or []

        from models import Commit
        fc_stmt = select(func.count(CommitFile.id.distinct())).join(
            Commit, Commit.id == CommitFile.commit_id
        ).where(Commit.repo_id == repo_id)
        fc_result = await self.db.execute(fc_stmt)
        file_count = fc_result.scalar() or 0
        denominator = max(20, file_count * 0.05)
        return min(len(violations) / denominator, 1.0)

    async def _bus_factor_risk(self, repo_id: str) -> float:
        churn_analyzer = await get_churn_analyzer(self.db)
        churn_data = await churn_analyzer.analyze_repository(repo_id)
        hhi = churn_data.get("overall_bus_factor")
        if hhi is None:
            return None
        return float(hhi)

    async def _collab_risk(self, repo_id: str) -> float:
        chronos = await get_chronos_graph(self.db)
        collaboration_score = await chronos.get_repo_collaboration_score(repo_id)
        if collaboration_score is None:
            return None
        return 1.0 - collaboration_score

    async def _ci_risk(self, repo_id: str) -> float:
        since = datetime.now(timezone.utc) - timedelta(days=30)
        ci_stmt = (
            select(func.count(CIRun.id), CIRun.conclusion)
            .where(and_(CIRun.repo_id == repo_id, CIRun.created_at >= since))
            .group_by(CIRun.conclusion)
        )
        ci_result = await self.db.execute(ci_stmt)
        ci_stats = {row[1]: row[0] for row in ci_result.all()}
        total_ci = sum(ci_stats.values())
        if total_ci == 0:
            return None
        failed_ci = ci_stats.get("failure", 0)
        return failed_ci / total_ci

    async def calculate_repo_risk(self, repo_id: str, weights: Dict = None) -> Dict:
        """
        Calculate unified risk score for a repository.
        All 5 sub-engines run in parallel via asyncio.gather().
        Signals that fail or have no data return None and are excluded from the
        weighted average — the score is based only on available signals.
        """
        w = weights or {
            "coupling": 0.25,
            "architecture": 0.20,
            "bus_factor": 0.20,
            "collaboration": 0.15,
            "ci": 0.20,
        }

        async def safe(coro):
            try:
                return await coro
            except Exception:
                return None

        signal_keys = ["coupling", "architecture", "bus_factor", "collaboration", "ci"]
        signal_values = await asyncio.gather(
            safe(self._coupling_risk(repo_id)),
            safe(self._arch_risk(repo_id)),
            safe(self._bus_factor_risk(repo_id)),
            safe(self._collab_risk(repo_id)),
            safe(self._ci_risk(repo_id)),
        )
        signals = dict(zip(signal_keys, signal_values))

        # Compute weighted average over available (non-None) signals only
        available = {k: v for k, v in signals.items() if v is not None}
        if available:
            total_weight = sum(w[k] for k in available)
            unified_score: Optional[float] = sum(available[k] * w[k] for k in available) / total_weight
            unified_score = min(unified_score, 1.0)
        else:
            unified_score = None

        return {
            "score": round(unified_score * 100, 1) if unified_score is not None else None,
            "label": self._label(unified_score) if unified_score is not None else "unavailable",
            "breakdown": {
                k: (round(v * 100, 1) if v is not None else None)
                for k, v in signals.items()
            },
            "weights": w,
            "unavailable_signals": [k for k, v in signals.items() if v is None],
        }

    def _label(self, score: float) -> str:
        if score < 0.30:
            return "low"
        if score < 0.55:
            return "medium"
        if score < 0.75:
            return "high"
        return "critical"


async def get_unified_risk_scorer(db: AsyncSession) -> UnifiedRiskScorer:
    return UnifiedRiskScorer(db)
