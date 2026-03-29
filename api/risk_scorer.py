"""
Unified Risk Scorer - Aggregates scores from all analysis engines.
"""

from typing import Dict
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, and_

from models import Repo, ArchAnalysis, CIRun
from cochange_oracle import get_cochange_oracle
from churn_analyzer import get_churn_analyzer
from chronos_graph import get_chronos_graph


class UnifiedRiskScorer:
    def __init__(self, db: AsyncSession):
        self.db = db

    async def calculate_repo_risk(self, repo_id: str, weights: Dict = None) -> Dict:
        """
        Calculate unified risk score for a repository.
        Weights come from repo config or fall back to defaults.
        """
        w = weights or {
            "coupling": 0.25,
            "architecture": 0.20,
            "bus_factor": 0.20,
            "collaboration": 0.15,
            "ci": 0.20,
        }

        # 1. Coupling Risk
        try:
            oracle = await get_cochange_oracle(self.db)
            coupling_data = await oracle.analyze_repository(repo_id)
            links = coupling_data.get("links", [])
            coupling_risk = (sum(l["value"] for l in links) / len(links)) if links else 0.0
            coupling_risk = min(coupling_risk, 1.0)
        except Exception:
            coupling_risk = 0.0

        # 2. Architecture Risk
        try:
            arch_stmt = select(ArchAnalysis).where(ArchAnalysis.repo_id == repo_id)
            arch_result = await self.db.execute(arch_stmt)
            arch_analysis = arch_result.scalar_one_or_none()
            violations = arch_analysis.violations if arch_analysis and arch_analysis.violations else []
            arch_risk = min(len(violations) / 20.0, 1.0)
        except Exception:
            arch_risk = 0.0

        # 3. Bus Factor Risk (HHI-based)
        try:
            churn_analyzer = await get_churn_analyzer(self.db)
            churn_data = await churn_analyzer.analyze_repository(repo_id)
            # HHI → 1.0 = single owner (high risk), → 0 = distributed (low risk)
            hhi = churn_data.get("overall_bus_factor", 0.3)
            bus_factor_risk = float(hhi)
        except Exception:
            bus_factor_risk = 0.3

        # 4. Collaboration Risk (from ChronosGraph — real Neo4j data)
        try:
            chronos = await get_chronos_graph(self.db)
            collaboration_score = await chronos.get_repo_collaboration_score(repo_id)
            collab_risk = 1.0 - collaboration_score
        except Exception:
            collab_risk = 0.3

        # 5. CI / Flakiness Risk (from actual CI run failure rate)
        try:
            since = datetime.utcnow() - timedelta(days=30)
            ci_stmt = (
                select(func.count(CIRun.id), CIRun.conclusion)
                .where(and_(CIRun.repo_id == repo_id, CIRun.created_at >= since))
                .group_by(CIRun.conclusion)
            )
            ci_result = await self.db.execute(ci_stmt)
            ci_stats = {row[1]: row[0] for row in ci_result.all()}
            total_ci = sum(ci_stats.values())
            failed_ci = ci_stats.get("failure", 0)
            ci_risk = (failed_ci / total_ci) if total_ci > 0 else 0.1
        except Exception:
            ci_risk = 0.1

        unified_score = (
            coupling_risk * w["coupling"]
            + arch_risk * w["architecture"]
            + bus_factor_risk * w["bus_factor"]
            + collab_risk * w["collaboration"]
            + ci_risk * w["ci"]
        )
        unified_score = min(unified_score, 1.0)

        return {
            "score": round(unified_score * 100, 1),
            "label": self._label(unified_score),
            "breakdown": {
                "coupling": round(coupling_risk * 100, 1),
                "architecture": round(arch_risk * 100, 1),
                "bus_factor": round(bus_factor_risk * 100, 1),
                "collaboration": round(collab_risk * 100, 1),
                "ci": round(ci_risk * 100, 1),
            },
            "weights": w,
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
