"""
Churn and Bus Factor Analyzer - Analyzes code ownership and contribution patterns.

This module implements:
- Temporal decay analysis for contributor activity
- Herfindahl-Hirschman Index (HHI) calculations for bus factor
- Code ownership metrics
- Risk assessment based on contributor concentration
"""

import asyncio
from typing import List, Dict, Set, Tuple
from collections import defaultdict, Counter
from datetime import datetime, timedelta
import math
import statistics

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import and_, func, desc

from models import Commit, CommitFile, Repo


class ChurnBusFactorAnalyzer:
    """
    Analyzes contributor patterns and calculates bus factor metrics.

    The analyzer:
    1. Tracks contributor activity over time with decay
    2. Calculates Herfindahl-Hirschman Index for ownership concentration
    3. Identifies files with high bus factor risk
    4. Provides recommendations for knowledge distribution
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.decay_half_life = 180  # 6 months for contributor activity decay
        self.bus_factor_threshold = 0.6  # HHI threshold for high risk

    async def analyze_repository(self, repo_id: str) -> Dict:
        """
        Main analysis function for a repository.

        Returns comprehensive churn and bus factor analysis.
        """
        # Get contributor statistics
        contributor_stats = await self._get_contributor_stats(repo_id)

        if not contributor_stats:
            return self._empty_analysis()

        # Calculate bus factor metrics
        bus_factor_metrics = self._calculate_bus_factor(contributor_stats)

        # Analyze file ownership
        file_ownership = await self._analyze_file_ownership(repo_id)

        # Calculate risk scores
        risk_assessment = self._calculate_risk_scores(bus_factor_metrics, file_ownership)

        return {
            "overall_bus_factor": bus_factor_metrics["overall_hhi"],
            "risk_level": risk_assessment["overall_risk"],
            "contributors": bus_factor_metrics["contributors"],
            "file_ownership": file_ownership,
            "recommendations": risk_assessment["recommendations"]
        }

    # File path patterns to exclude from lines-changed HHI — lockfiles and generated code
    # skew ownership toward whoever last ran package install or codegen.
    _EXCLUDE_PATH_PATTERNS = [
        '%package-lock.json',
        '%yarn.lock',
        '%pnpm-lock.yaml',
        '%Cargo.lock',
        '%poetry.lock',
        '%Gemfile.lock',
        '%.pb.go',
        '%.generated.%',
        '%_pb2.py',
        '%/__generated__/%',
        '%.min.js',
        '%.min.css',
    ]

    async def _get_contributor_stats(self, repo_id: str) -> Dict[str, Dict]:
        """Get contributor statistics with temporal decay, weighted by lines changed.

        Groups by (author_login, commit date) — NOT by (login, email, date) which
        produced one row per author per day inflating counts.

        HHI is computed on decay-weighted lines changed (additions + deletions),
        excluding lockfiles and generated code which skew ownership.
        """
        # Build exclusion filter
        from sqlalchemy import not_, or_
        exclusions = or_(*[CommitFile.file_path.like(p) for p in self._EXCLUDE_PATH_PATTERNS])

        # Per-commit lines changed (excluding noisy files), grouped by author
        result = await self.db.execute(
            select(
                Commit.author_login,
                Commit.committed_date,
                func.sum(CommitFile.additions + CommitFile.deletions).label("lines_changed"),
            )
            .join(CommitFile, CommitFile.commit_id == Commit.id)
            .where(
                Commit.repo_id == repo_id,
                Commit.author_login.isnot(None),
                not_(exclusions),
            )
            .group_by(Commit.id, Commit.author_login, Commit.committed_date)
        )

        rows = result.all()
        if not rows:
            return {}

        all_dates = [row[1] for row in rows if row[1]]
        if not all_dates:
            return {}
        latest_date = max(all_dates)

        contributor_activity: Dict[str, Dict] = defaultdict(
            lambda: {"commits": [], "total_weighted_lines": 0.0}
        )

        for author_login, commit_date, lines_changed in rows:
            if not author_login or not commit_date:
                continue
            lines = lines_changed or 0
            days_diff = (latest_date - commit_date).days
            weight = math.exp(-days_diff / self.decay_half_life)
            contributor_activity[author_login]["commits"].append({
                "date": commit_date,
                "lines": lines,
                "weight": weight,
            })
            contributor_activity[author_login]["total_weighted_lines"] += lines * weight

        return dict(contributor_activity)

    def _calculate_bus_factor(self, contributor_stats: Dict[str, Dict]) -> Dict:
        """Calculate HHI weighted by decay-adjusted lines changed (not commit count)."""
        if not contributor_stats:
            return {"overall_hhi": None, "contributors": []}

        total_weighted_lines = sum(
            stats["total_weighted_lines"] for stats in contributor_stats.values()
        )
        if total_weighted_lines == 0:
            return {"overall_hhi": None, "contributors": []}

        hhi = 0.0
        contributors = []

        for contributor, stats in contributor_stats.items():
            share = stats["total_weighted_lines"] / total_weighted_lines
            hhi += share ** 2
            contributors.append({
                "name": contributor,
                "weighted_lines": stats["total_weighted_lines"],
                "share": share,
                "commit_count": len(stats["commits"]),
            })

        contributors.sort(key=lambda x: x["weighted_lines"], reverse=True)

        return {
            "overall_hhi": hhi,
            "contributors": contributors[:10],
        }

    async def _analyze_file_ownership(self, repo_id: str) -> List[Dict]:
        """Analyze ownership for ALL files, weighted by lines changed.

        Previously capped at top 20 files — that cap is removed. HHI is now
        computed on lines changed rather than commit count to match the repo-level metric.
        Lockfiles and generated files are excluded (same patterns as contributor stats).
        """
        from sqlalchemy import not_, or_
        exclusions = or_(*[CommitFile.file_path.like(p) for p in self._EXCLUDE_PATH_PATTERNS])

        result = await self.db.execute(
            select(
                CommitFile.file_path,
                Commit.author_login,
                func.sum(CommitFile.additions + CommitFile.deletions).label("lines"),
            )
            .join(Commit, Commit.id == CommitFile.commit_id)
            .where(
                Commit.repo_id == repo_id,
                Commit.author_login.isnot(None),
                not_(exclusions),
            )
            .group_by(CommitFile.file_path, Commit.author_login)
        )
        rows = result.all()

        if not rows:
            return []

        files_dict: dict = defaultdict(list)
        for file_path, author, lines in rows:
            files_dict[file_path].append({"contributor": author, "lines": lines or 0})

        file_ownership = []
        for file_path, contribs in files_dict.items():
            total = sum(c["lines"] for c in contribs)
            if total == 0:
                continue
            contribs.sort(key=lambda c: c["lines"], reverse=True)
            ownership = [
                {
                    "contributor": c["contributor"],
                    "ownership_percentage": c["lines"] / total,
                    "lines_to_file": c["lines"],
                }
                for c in contribs[:5]
            ]
            shares = [o["ownership_percentage"] for o in ownership]
            file_hhi = sum(s ** 2 for s in shares)
            file_ownership.append({
                "file_path": file_path,
                "ownership": ownership,
                "bus_factor_hhi": file_hhi,
                "risk_level": "high" if file_hhi > self.bus_factor_threshold else "medium" if file_hhi > 0.3 else "low",
            })

        return file_ownership

    def _calculate_risk_scores(self, bus_factor_metrics: Dict, file_ownership: List[Dict]) -> Dict:
        """Calculate overall risk scores and provide recommendations."""
        overall_hhi = bus_factor_metrics["overall_hhi"]

        # Determine overall risk level
        if overall_hhi > 0.8:
            overall_risk = "critical"
        elif overall_hhi > 0.6:
            overall_risk = "high"
        elif overall_hhi > 0.3:
            overall_risk = "medium"
        else:
            overall_risk = "low"

        # Count high-risk files
        high_risk_files = [f for f in file_ownership if f["risk_level"] == "high"]
        high_risk_count = len(high_risk_files)

        # Generate recommendations
        recommendations = []

        if overall_risk == "critical":
            recommendations.append("URGENT: Repository has critical bus factor. Single points of failure throughout codebase.")
        elif overall_risk == "high":
            recommendations.append("HIGH PRIORITY: Address bus factor concentration to prevent knowledge silos.")

        if high_risk_count > 0:
            recommendations.append(f"Review {high_risk_count} files with high bus factor risk.")

        if len(bus_factor_metrics["contributors"]) < 3:
            recommendations.append("Increase contributor diversity to reduce bus factor risk.")

        # Contributor diversity recommendations
        if overall_hhi > 0.5:
            recommendations.append("Implement code review rotation to distribute knowledge.")
            recommendations.append("Create documentation for critical components.")

        return {
            "overall_risk": overall_risk,
            "high_risk_files": high_risk_count,
            "recommendations": recommendations
        }

    def _empty_analysis(self) -> Dict:
        """Return empty analysis structure when no data is available."""
        return {
            "overall_bus_factor": None,
            "risk_level": None,
            "contributors": [],
            "file_ownership": [],
            "recommendations": [],
        }


async def get_churn_analyzer(db: AsyncSession) -> ChurnBusFactorAnalyzer:
    return ChurnBusFactorAnalyzer(db)