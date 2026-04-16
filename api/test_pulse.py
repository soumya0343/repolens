"""
TestPulse - CI Log Analysis and Flaky Test Detection

Per-run analysis (used by ci-worker):
  DrainClusterer + analyze_logs — clusters error patterns in a single run's logs.

Cross-run flakiness (requires DB session):
  analyze_flakiness — groups CIRuns by (workflow_name, head_sha) and identifies
  workflows where the same commit produced both passing and failing runs.
  Real flakiness = non-determinism on a fixed input, not just "many error patterns".
"""

import re
from typing import List, Dict, Optional
from collections import defaultdict

from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import and_

from models import CIRun


class DrainClusterer:
    """
    Simplified Drain-like log clustering algorithm.
    Groups log lines by their structural template.
    """
    def __init__(self, depth=4, st=0.5):
        self.depth = depth
        self.st = st
        self.clusters = []

    def cluster(self, logs: List[str]) -> List[Dict]:
        for line in logs:
            if not line.strip():
                continue
            processed = self._preprocess(line)
            tokens = processed.split()
            if not tokens:
                continue
            matched = False
            for cluster in self.clusters:
                similarity = self._calculate_similarity(tokens, cluster['template'].split())
                if similarity >= self.st:
                    cluster['count'] += 1
                    matched = True
                    break
            if not matched:
                self.clusters.append({
                    'id': len(self.clusters) + 1,
                    'template': processed,
                    'count': 1,
                })
        return sorted(self.clusters, key=lambda x: x['count'], reverse=True)

    def _preprocess(self, line: str) -> str:
        line = re.sub(r'\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]', '', line)
        line = re.sub(r'0x[0-9a-fA-F]+', '<HEX>', line)
        line = re.sub(r'\d+', '<NUM>', line)
        return line.strip()

    def _calculate_similarity(self, tokens1: List[str], tokens2: List[str]) -> float:
        if len(tokens1) != len(tokens2):
            return 0.0
        matches = sum(1 for t1, t2 in zip(tokens1, tokens2) if t1 == t2)
        return matches / len(tokens1)


class TestPulse:
    """
    Analyzes CI runs for flakiness.
    """
    def __init__(self, db: Optional[AsyncSession] = None):
        self.db = db
        self.clusterer = DrainClusterer()

    def analyze_logs(self, logs: Dict[str, str]) -> Dict:
        """
        Per-run log analysis used by ci-worker to cluster error patterns.
        Does NOT compute flakiness — that requires cross-run data.
        """
        all_lines = []
        for content in logs.values():
            lines = [
                l for l in content.splitlines()
                if any(k in l.lower() for k in ['error', 'fail', 'exception', 'traceback'])
            ]
            all_lines.extend(lines)

        clusters = self.clusterer.cluster(all_lines[:1000])
        return {
            "clusters": clusters[:10],
            "total_errors": len(all_lines),
            # flakiness_prob intentionally absent — computed cross-run only
        }

    async def analyze_flakiness(self, repo_id: str, min_runs: int = 2) -> List[Dict]:
        """
        Cross-run flakiness: a workflow is flaky if the SAME commit (head_sha) produced
        both passing and failing runs of the SAME workflow.

        Requires self.db (AsyncSession). Only considers runs where event IS NOT NULL
        (i.e. rows ingested after the CIRun schema fix — legacy rows are excluded).

        Returns a list of flaky workflows sorted by flakiness_rate descending.
        """
        if self.db is None:
            raise RuntimeError("TestPulse.analyze_flakiness requires a database session")

        result = await self.db.execute(
            select(CIRun.name, CIRun.head_sha, CIRun.conclusion)
            .where(
                and_(
                    CIRun.repo_id == repo_id,
                    CIRun.event.isnot(None),       # skip legacy rows without event
                    CIRun.conclusion.isnot(None),
                    CIRun.head_sha.isnot(None),
                )
            )
        )
        rows = result.all()

        # Group by (workflow_name, head_sha)
        groups: Dict[tuple, Dict] = defaultdict(lambda: {"success": 0, "failure": 0})
        for name, head_sha, conclusion in rows:
            key = (name, head_sha)
            if conclusion == "success":
                groups[key]["success"] += 1
            elif conclusion == "failure":
                groups[key]["failure"] += 1

        # Identify flaky groups: ≥1 success AND ≥1 failure on the same SHA
        flaky_by_workflow: Dict[str, Dict] = defaultdict(lambda: {
            "flaky_sha_count": 0,
            "total_sha_count": 0,
        })
        for (workflow_name, head_sha), counts in groups.items():
            total = counts["success"] + counts["failure"]
            if total < min_runs:
                continue
            flaky_by_workflow[workflow_name]["total_sha_count"] += 1
            if counts["success"] > 0 and counts["failure"] > 0:
                flaky_by_workflow[workflow_name]["flaky_sha_count"] += 1

        results = []
        for workflow_name, stats in flaky_by_workflow.items():
            total = stats["total_sha_count"]
            flaky = stats["flaky_sha_count"]
            if total == 0:
                continue
            results.append({
                "workflow_name": workflow_name,
                "flaky_sha_count": flaky,
                "total_sha_count": total,
                "flakiness_rate": round(flaky / total, 3),
            })

        return sorted(results, key=lambda x: x["flakiness_rate"], reverse=True)


async def get_test_pulse(db: Optional[AsyncSession] = None) -> TestPulse:
    return TestPulse(db=db)
