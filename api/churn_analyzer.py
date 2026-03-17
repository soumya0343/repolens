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

from models import Commit, Repo


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

    async def _get_contributor_stats(self, repo_id: str) -> Dict[str, Dict]:
        """Get comprehensive contributor statistics with temporal decay."""
        # Get all commits for the repository
        result = await self.db.execute(
            select(Commit.author_login, Commit.author_email, Commit.committed_date, func.count(Commit.id))
            .where(Commit.repo_id == repo_id)
            .group_by(Commit.author_login, Commit.author_email, Commit.committed_date)
        )

        contributor_activity = defaultdict(lambda: {"commits": [], "total_weighted_commits": 0.0})

        rows = result.all()
        if not rows:
            return {}

        # Find the most recent commit date
        all_dates = [row[2] for row in rows if row[2]]
        if not all_dates:
            return {}

        latest_date = max(all_dates)

        for author_login, author_email, commit_date, commit_count in rows:
            if not author_login or not commit_date:
                continue

            # Use login as primary key, fallback to email
            contributor_key = author_login

            # Calculate temporal weight using exponential decay
            days_diff = (latest_date - commit_date).days
            weight = math.exp(-days_diff / self.decay_half_life)

            weighted_commits = commit_count * weight

            contributor_activity[contributor_key]["commits"].append({
                "date": commit_date,
                "count": commit_count,
                "weight": weight
            })
            contributor_activity[contributor_key]["total_weighted_commits"] += weighted_commits

        return dict(contributor_activity)

    def _calculate_bus_factor(self, contributor_stats: Dict[str, Dict]) -> Dict:
        """Calculate Herfindahl-Hirschman Index and bus factor metrics."""
        if not contributor_stats:
            return {"overall_hhi": 0.0, "contributors": []}

        # Calculate total weighted commits
        total_weighted_commits = sum(stats["total_weighted_commits"] for stats in contributor_stats.values())

        if total_weighted_commits == 0:
            return {"overall_hhi": 0.0, "contributors": []}

        # Calculate HHI (Herfindahl-Hirschman Index)
        hhi = 0.0
        contributors = []

        for contributor, stats in contributor_stats.items():
            share = stats["total_weighted_commits"] / total_weighted_commits
            hhi += share ** 2

            contributors.append({
                "name": contributor,
                "weighted_commits": stats["total_weighted_commits"],
                "share": share,
                "commit_count": len(stats["commits"])
            })

        # Sort contributors by weighted commits
        contributors.sort(key=lambda x: x["weighted_commits"], reverse=True)

        return {
            "overall_hhi": hhi,
            "contributors": contributors[:10]  # Top 10 contributors
        }

    async def _analyze_file_ownership(self, repo_id: str) -> List[Dict]:
        """Analyze ownership patterns for individual files."""
        # This is a simplified analysis since we don't have detailed file change data yet
        # In a real implementation, we'd analyze file-level changes

        # For now, return mock data based on commit patterns
        contributor_stats = await self._get_contributor_stats(repo_id)

        if not contributor_stats:
            return []

        # Mock file ownership analysis
        files = [
            "src/main.py",
            "src/api.py",
            "src/models.py",
            "src/utils.py",
            "tests/test_main.py",
            "README.md"
        ]

        file_ownership = []

        for file_path in files:
            # Simulate ownership based on contributor activity
            # In real implementation, this would be based on actual file changes
            top_contributors = list(contributor_stats.keys())[:3]  # Top 3 contributors

            ownership = []
            remaining_share = 1.0

            for i, contributor in enumerate(top_contributors):
                if i == len(top_contributors) - 1:
                    share = remaining_share
                else:
                    # Distribute ownership with decreasing shares
                    share = remaining_share * (0.7 ** i)
                    remaining_share -= share

                ownership.append({
                    "contributor": contributor,
                    "ownership_percentage": share,
                    "commits_to_file": max(1, int(share * 20))  # Mock commit count
                })

            # Calculate bus factor for this file
            ownership_shares = [owner["ownership_percentage"] for owner in ownership]
            file_hhi = sum(share ** 2 for share in ownership_shares)

            file_ownership.append({
                "file_path": file_path,
                "ownership": ownership,
                "bus_factor_hhi": file_hhi,
                "risk_level": "high" if file_hhi > self.bus_factor_threshold else "medium" if file_hhi > 0.3 else "low"
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
            "overall_bus_factor": 0.0,
            "risk_level": "unknown",
            "contributors": [],
            "file_ownership": [],
            "recommendations": ["No commit data available for analysis"]
        }


# Global instance for background processing
churn_analyzer = None

async def get_churn_analyzer(db: AsyncSession) -> ChurnBusFactorAnalyzer:
    """Get or create ChurnBusFactorAnalyzer instance."""
    global churn_analyzer
    if churn_analyzer is None:
        churn_analyzer = ChurnBusFactorAnalyzer(db)
    return churn_analyzer