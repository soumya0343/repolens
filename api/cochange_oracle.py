"""
CoChangeOracle - Analyzes commit history to identify files that frequently change together.

This module implements:
- FP-Growth algorithm for frequent pattern mining (true tree-based, not Apriori)
- DERAR (Decay Exponential Recent Activity Relevance) filter for temporal weighting
  Applied as a post-hoc multiplier on raw support counts — not by duplicating transactions.
- TCM (Temporal Coupling Metric) scoring
- 3-file itemset mining (triple coupling rules)
"""

import asyncio
import json
import os
from typing import List, Dict, Set, Tuple, Optional
from collections import defaultdict, Counter
from datetime import datetime, timedelta
import math

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import and_, func

import redis.asyncio as aioredis

from models import Commit, CommitFile, Repo

_CACHE_TTL = 3600  # 1 hour


def _redis_client() -> aioredis.Redis:
    host = os.getenv("REDIS_HOST", "localhost")
    port = int(os.getenv("REDIS_PORT", 6379))
    return aioredis.from_url(f"redis://{host}:{port}", decode_responses=True)


# ── FP-Growth data structures ─────────────────────────────────────────────────

class _FPNode:
    """Node in an FP-tree. count is a float to support weighted transactions."""
    __slots__ = ('item', 'count', 'parent', 'children', 'link')

    def __init__(self, item: Optional[str], count: float, parent):
        self.item = item
        self.count = count
        self.parent = parent
        self.children: Dict[str, '_FPNode'] = {}
        self.link: Optional['_FPNode'] = None  # horizontal header-table link


class _FPTree:
    """Weighted FP-tree with header table for efficient pattern extraction."""

    def __init__(self):
        self.root = _FPNode(None, 0.0, None)
        # header_table: item -> [total_support_float, first_node]
        self.header_table: Dict[str, list] = {}

    def insert(self, items: List[str], weight: float) -> None:
        node = self.root
        for item in items:
            if item in node.children:
                node.children[item].count += weight
            else:
                new_node = _FPNode(item, weight, node)
                node.children[item] = new_node
                if item not in self.header_table:
                    self.header_table[item] = [weight, new_node]
                else:
                    self.header_table[item][0] += weight
                    # Append to end of horizontal linked list
                    cur = self.header_table[item][1]
                    while cur.link:
                        cur = cur.link
                    cur.link = new_node
            node = node.children[item]

    def _conditional_pattern_base(self, item: str) -> List[Tuple[List[str], float]]:
        """Return (prefix_path, weight) pairs for conditional FP-tree construction."""
        patterns = []
        node = self.header_table[item][1]
        while node:
            path: List[str] = []
            parent = node.parent
            while parent and parent.item is not None:
                path.append(parent.item)
                parent = parent.parent
            if path:
                patterns.append((path, node.count))
            node = node.link
        return patterns


def _mine_tree(
    tree: _FPTree,
    min_sup: float,
    prefix: frozenset,
    max_size: int,
    results: List[Tuple[frozenset, float]],
) -> None:
    """Recursively mine frequent itemsets from an FP-tree (depth-first)."""
    for item, (support, _) in tree.header_table.items():
        if support < min_sup:
            continue
        new_prefix = prefix | frozenset([item])
        results.append((new_prefix, support))

        if len(new_prefix) >= max_size:
            continue

        # Build conditional FP-tree
        cond_base = tree._conditional_pattern_base(item)
        if not cond_base:
            continue

        # Count item support in conditional base
        cond_item_sup: Dict[str, float] = defaultdict(float)
        for path, weight in cond_base:
            for p_item in path:
                cond_item_sup[p_item] += weight

        freq_in_cond = {i: s for i, s in cond_item_sup.items() if s >= min_sup}
        if not freq_in_cond:
            continue

        cond_tree = _FPTree()
        for path, weight in cond_base:
            filtered = sorted(
                [i for i in path if i in freq_in_cond],
                key=lambda x: freq_in_cond[x],
                reverse=True,
            )
            if filtered:
                cond_tree.insert(filtered, weight)

        _mine_tree(cond_tree, min_sup, new_prefix, max_size, results)


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
        Result cached in Redis for 1 hour keyed by (repo_id, latest_commit_oid).
        """
        # Use latest commit OID as cache discriminator so new data invalidates the entry
        latest_oid_row = await self.db.execute(
            select(Commit.oid)
            .where(Commit.repo_id == repo_id)
            .order_by(Commit.committed_date.desc())
            .limit(1)
        )
        latest_oid = latest_oid_row.scalar() or "none"
        cache_key = f"cochange:{repo_id}:{latest_oid}"

        try:
            r = _redis_client()
            cached = await r.get(cache_key)
            await r.aclose()
            if cached:
                return json.loads(cached)
        except Exception:
            pass

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
        result = self._format_for_frontend(coupling_scores)

        try:
            r = _redis_client()
            await r.setex(cache_key, _CACHE_TTL, json.dumps(result))
            await r.aclose()
        except Exception:
            pass

        return result

    async def _get_commits(self, repo_id: str) -> List[Dict]:
        """Fetch all commits for a repository with their actual changed files."""
        commits_result = await self.db.execute(
            select(Commit).where(
                Commit.repo_id == repo_id,
                Commit.files_fetch_failed == False,  # noqa: E712
            )
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

    def _extract_file_patterns(self, time_windows: Dict[str, List[Dict]]) -> List[Tuple[Set[str], float]]:
        """Return (fileset, weight) pairs — one per multi-file commit.

        Weight is the DERAR decay factor for that commit's time window.
        No duplication: the FP-tree handles weighted support natively.
        """
        patterns: List[Tuple[Set[str], float]] = []
        for window_commits in time_windows.values():
            for commit in window_commits:
                files = set(commit["files_changed"])
                if len(files) > 1:
                    patterns.append((files, commit.get("weight", 1.0)))
        return patterns

    def _fp_growth(self, transactions: List[Tuple[Set[str], float]]) -> List[Tuple[frozenset, float]]:
        """
        True FP-Growth: build weighted FP-tree, then mine frequent itemsets
        up to self.max_itemset_size (default 3) in a single tree traversal.

        Returns list of (frozenset, raw_weighted_support) tuples.
        Support values are raw weighted counts (not fractions) — normalised
        against total_weight in _calculate_tcm_scores.
        """
        if not transactions:
            return []

        # Step 1: compute weighted support for each item
        item_sup: Dict[str, float] = defaultdict(float)
        total_weight = sum(w for _, w in transactions)
        for items, weight in transactions:
            for item in items:
                item_sup[item] += weight

        min_sup_count = self.min_support * total_weight
        freq_items = {item: sup for item, sup in item_sup.items() if sup >= min_sup_count}
        if not freq_items:
            return []

        # Step 2: build FP-tree (items sorted by descending support for sharing)
        tree = _FPTree()
        for items, weight in transactions:
            sorted_items = sorted(
                [i for i in items if i in freq_items],
                key=lambda x: freq_items[x],
                reverse=True,
            )
            if sorted_items:
                tree.insert(sorted_items, weight)

        # Step 3: mine all frequent itemsets up to max_itemset_size
        results: List[Tuple[frozenset, float]] = []
        _mine_tree(tree, min_sup_count, frozenset(), self.max_itemset_size, results)
        return results

    def _calculate_tcm_scores(
        self,
        frequent_patterns: List[Tuple[frozenset, float]],
        time_windows: Dict[str, List[Dict]],
    ) -> Dict[Tuple[str, ...], float]:
        """Calculate TCM = (weighted_support / total_weight) * temporal_coherence.

        Handles both 2-file pairs and 3-file triplets.
        3-file TCM uses average pairwise temporal coherence.
        """
        total_weight = sum(
            commit.get("weight", 1.0)
            for commits in time_windows.values()
            for commit in commits
        )
        if total_weight == 0:
            return {}

        coupling_scores: Dict[Tuple[str, ...], float] = {}

        for pattern, raw_support in frequent_patterns:
            size = len(pattern)
            if size < 2 or size > 3:
                continue

            files = tuple(sorted(pattern))
            support_frac = raw_support / total_weight

            if size == 2:
                coherence = self._calculate_temporal_coherence(files[0], files[1], time_windows)
            else:  # size == 3
                # Average Jaccard coherence across the 3 pairs
                coherence = (
                    self._calculate_temporal_coherence(files[0], files[1], time_windows)
                    + self._calculate_temporal_coherence(files[0], files[2], time_windows)
                    + self._calculate_temporal_coherence(files[1], files[2], time_windows)
                ) / 3.0

            tcm = support_frac * coherence
            if tcm > 0:
                coupling_scores[files] = tcm

        return coupling_scores

    def _calculate_temporal_coherence(self, file1: str, file2: str,
                                      time_windows: Dict[str, List[Dict]]) -> float:
        """Jaccard similarity: weighted joint / weighted union."""
        file1_w = file2_w = joint_w = 0.0
        for commits in time_windows.values():
            for commit in commits:
                files = set(commit["files_changed"])
                w = commit.get("weight", 1.0)
                f1 = file1 in files
                f2 = file2 in files
                if f1:
                    file1_w += w
                if f2:
                    file2_w += w
                if f1 and f2:
                    joint_w += w

        union = file1_w + file2_w - joint_w
        return joint_w / union if union > 0 else 0.0

    def _format_for_frontend(self, coupling_scores: Dict[Tuple[str, ...], float]) -> Dict:
        """Format coupling data for D3.js visualization.

        Pairs → single link.
        Triplets → 3 links sharing a triplet_id so the frontend can highlight the group.
        """
        file_set: Set[str] = set()
        for key in coupling_scores:
            file_set.update(key)

        nodes = [{"id": f, "group": 1} for f in sorted(file_set)]

        links = []
        for key, score in coupling_scores.items():
            value = min(score * 10, 1.0)
            if len(key) == 2:
                links.append({
                    "source": key[0],
                    "target": key[1],
                    "value": value,
                    "triplet": False,
                })
            else:  # 3-file triplet
                triplet_id = "|".join(key)
                for i in range(3):
                    for j in range(i + 1, 3):
                        links.append({
                            "source": key[i],
                            "target": key[j],
                            "value": value,
                            "triplet": True,
                            "triplet_id": triplet_id,
                        })

        return {"nodes": nodes, "links": links}


async def get_cochange_oracle(db: AsyncSession) -> CoChangeOracle:
    return CoChangeOracle(db)