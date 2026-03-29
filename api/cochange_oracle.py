"""
CoChangeOracle - Analyzes commit history to identify files that frequently change together.

This module implements:
- FP-Growth algorithm for frequent pattern mining
- DERAR (Decay Exponential Recent Activity Relevance) filter for temporal weighting
- TCM (Temporal Coupling Metric) scoring
- Incremental updates for new commits
"""

import asyncio
from typing import List, Dict, Set, Tuple
from collections import defaultdict, Counter
from datetime import datetime, timedelta
import math

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import and_, func

from models import Commit, CommitFile, Repo


class CoChangeOracle:
    """
    Analyzes co-changing files using FP-Growth and temporal decay.

    The algorithm:
    1. Groups commits by time windows
    2. Applies DERAR decay to recent activity
    3. Uses FP-Growth to find frequent itemsets
    4. Calculates TCM scores for file pairs
    """

    def __init__(self, db: AsyncSession):
        self.db = db
        self.min_support = 0.02  # Minimum support threshold (2%)
        self.max_itemset_size = 3  # Maximum files in a pattern
        self.decay_half_life = 30  # Days for DERAR decay

    async def analyze_repository(self, repo_id: str) -> Dict:
        """
        Main analysis function for a repository.

        Returns coupling data in format suitable for frontend visualization.
        """
        # Get all commits for the repository
        commits = await self._get_commits(repo_id)
        if not commits:
            return {"nodes": [], "links": []}

        # Group commits by time windows and apply DERAR
        time_windows = self._group_commits_by_time(commits)

        # Extract file change patterns
        file_patterns = self._extract_file_patterns(time_windows)

        # Apply FP-Growth to find frequent patterns
        frequent_patterns = self._fp_growth(file_patterns)

        # Calculate TCM scores
        coupling_scores = self._calculate_tcm_scores(frequent_patterns, time_windows)

        # Convert to frontend format
        return self._format_for_frontend(coupling_scores)

    async def _get_commits(self, repo_id: str) -> List[Dict]:
        """Fetch all commits for a repository with their actual changed files."""
        commits_result = await self.db.execute(
            select(Commit).where(Commit.repo_id == repo_id)
        )
        commits = commits_result.scalars().all()
        if not commits:
            return []

        # Batch-fetch all file changes for this repo's commits in one query
        files_result = await self.db.execute(
            select(CommitFile.commit_id, CommitFile.file_path)
            .join(Commit, Commit.id == CommitFile.commit_id)
            .where(Commit.repo_id == repo_id)
        )
        files_by_commit: Dict[str, List[str]] = defaultdict(list)
        for row in files_result.all():
            files_by_commit[str(row[0])].append(row[1])

        return [
            {
                "id": str(commit.id),
                "oid": commit.oid,
                "message": commit.message or "",
                "author_email": commit.author_email,
                "committed_date": commit.committed_date,
                "files_changed": files_by_commit.get(str(commit.id), []),
            }
            for commit in commits
        ]

    def _group_commits_by_time(self, commits: List[Dict]) -> Dict[str, List[Dict]]:
        """Group commits into time windows and apply DERAR decay."""
        time_windows = defaultdict(list)

        for commit in commits:
            # Create time window key (weekly buckets)
            committed_date = commit["committed_date"]
            if committed_date:
                window_key = committed_date.strftime("%Y-%U")
                time_windows[window_key].append(commit)

        # Apply DERAR decay to recent windows
        self._apply_derar_decay(time_windows)

        return time_windows

    def _apply_derar_decay(self, time_windows: Dict[str, List[Dict]]) -> None:
        """Apply DERAR (Decay Exponential Recent Activity Relevance) filter."""
        if not time_windows:
            return

        # Find the most recent window
        recent_window = max(time_windows.keys())

        for window_key, commits in time_windows.items():
            # Calculate days since this window
            recent_year, recent_week = map(int, recent_window.split("-"))
            window_year, window_week = map(int, window_key.split("-"))

            # Rough day calculation
            days_diff = (recent_year - window_year) * 52 + (recent_week - window_week) * 7

            # Apply exponential decay
            decay_factor = math.exp(-days_diff / self.decay_half_life)

            # Weight each commit in this window
            for commit in commits:
                commit["weight"] = decay_factor

    def _extract_file_patterns(self, time_windows: Dict[str, List[Dict]]) -> List[Set[str]]:
        """Extract file change patterns from time windows."""
        patterns = []

        for window_commits in time_windows.values():
            for commit in window_commits:
                files = set(commit["files_changed"])
                if len(files) > 1:  # Only include commits that change multiple files
                    weight = commit.get("weight", 1.0)
                    # Add pattern multiple times based on weight (simplified)
                    times = max(1, int(weight * 10))
                    for _ in range(times):
                        patterns.append(files)

        return patterns

    def _fp_growth(self, transactions: List[Set[str]]) -> List[Tuple[Set[str], float]]:
        """
        Simplified FP-Growth implementation for frequent pattern mining.

        Returns list of (itemset, support) tuples.
        """
        if not transactions:
            return []

        # Count individual item frequencies
        item_counts = Counter()
        for transaction in transactions:
            for item in transaction:
                item_counts[item] += 1

        total_transactions = len(transactions)

        # Filter items by minimum support
        frequent_items = {
            item: count / total_transactions
            for item, count in item_counts.items()
            if count / total_transactions >= self.min_support
        }

        if not frequent_items:
            return []

        # Simple pairwise analysis (simplified FP-Growth)
        patterns = []

        items = list(frequent_items.keys())
        for i in range(len(items)):
            for j in range(i + 1, len(items)):
                item1, item2 = items[i], items[j]

                # Count co-occurrences
                co_count = 0
                for transaction in transactions:
                    if item1 in transaction and item2 in transaction:
                        co_count += 1

                support = co_count / total_transactions
                if support >= self.min_support:
                    patterns.append(({item1, item2}, support))

        return patterns

    def _calculate_tcm_scores(self, frequent_patterns: List[Tuple[Set[str], float]],
                            time_windows: Dict[str, List[Dict]]) -> Dict[Tuple[str, str], float]:
        """Calculate Temporal Coupling Metric (TCM) scores."""
        coupling_scores = {}

        for pattern, support in frequent_patterns:
            if len(pattern) == 2:  # Only handle pairs for now
                files = list(pattern)
                file1, file2 = files[0], files[1]

                # Calculate temporal coupling score
                # TCM = support * temporal_coherence
                temporal_coherence = self._calculate_temporal_coherence(file1, file2, time_windows)

                tcm_score = support * temporal_coherence
                coupling_scores[(file1, file2)] = tcm_score

        return coupling_scores

    def _calculate_temporal_coherence(self, file1: str, file2: str,
                                    time_windows: Dict[str, List[Dict]]) -> float:
        """Calculate how often two files change together relative to individually."""
        file1_changes = 0
        file2_changes = 0
        joint_changes = 0

        for commits in time_windows.values():
            for commit in commits:
                files = set(commit["files_changed"])
                weight = commit.get("weight", 1.0)

                if file1 in files:
                    file1_changes += weight
                if file2 in files:
                    file2_changes += weight
                if file1 in files and file2 in files:
                    joint_changes += weight

        if file1_changes == 0 or file2_changes == 0:
            return 0.0

        # Jaccard-like temporal coherence
        expected_joint = (file1_changes * file2_changes) / (file1_changes + file2_changes - joint_changes)
        if expected_joint == 0:
            return 1.0

        return min(joint_changes / expected_joint, 1.0)

    def _format_for_frontend(self, coupling_scores: Dict[Tuple[str, str], float]) -> Dict:
        """Format coupling data for frontend D3.js visualization."""
        # Create nodes (files)
        file_set = set()
        for file1, file2 in coupling_scores.keys():
            file_set.add(file1)
            file_set.add(file2)

        nodes = [{"id": file, "group": 1} for file in sorted(file_set)]

        # Create links (couplings)
        links = []
        for (file1, file2), score in coupling_scores.items():
            links.append({
                "source": file1,
                "target": file2,
                "value": min(score * 10, 1.0)  # Normalize for visualization
            })

        return {"nodes": nodes, "links": links}


async def get_cochange_oracle(db: AsyncSession) -> CoChangeOracle:
    return CoChangeOracle(db)