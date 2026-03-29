"""
TestPulse - CI Log Analysis and Flaky Test Detection

This module implements:
- Drain-like log clustering to group similar failure patterns
- Bayesian flakiness model to identify non-deterministic failures
- Environment correlation for failure diagnostics
"""

import re
import math
from typing import List, Dict, Set, Tuple, Optional
from collections import defaultdict, Counter
from datetime import datetime

class DrainClusterer:
    """
    Simplified Drain-like log clustering algorithm.
    Groups log lines by their structural template.
    """
    def __init__(self, depth=4, st=0.5):
        self.depth = depth
        self.st = st # Similarity threshold
        self.clusters = [] # List of {template: str, count: int, id: int}

    def cluster(self, logs: List[str]) -> List[Dict]:
        """Cluster a list of log lines"""
        for line in logs:
            if not line.strip():
                continue
            
            # Preprocess: remove timestamps, IDs, etc.
            processed = self._preprocess(line)
            tokens = processed.split()
            
            if not tokens:
                continue
                
            matched = False
            for cluster in self.clusters:
                similarity = self._calculate_similarity(tokens, cluster['template'].split())
                if similarity >= self.st:
                    cluster['count'] += 1
                    # Update template (simplified: keep first)
                    matched = True
                    break
            
            if not matched:
                self.clusters.append({
                    'id': len(self.clusters) + 1,
                    'template': processed,
                    'count': 1
                })
        
        return sorted(self.clusters, key=lambda x: x['count'], reverse=True)

    def _preprocess(self, line: str) -> str:
        """Simple regex-based preprocessing"""
        # Remove timestamps [2024-01-01 10:00:00]
        line = re.sub(r'\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\]', '', line)
        # Remove hex IDs 0x123abc
        line = re.sub(r'0x[0-9a-fA-F]+', '<HEX>', line)
        # Remove numbers
        line = re.sub(r'\d+', '<NUM>', line)
        return line.strip()

    def _calculate_similarity(self, tokens1: List[str], tokens2: List[str]) -> float:
        """Token-based similarity"""
        if len(tokens1) != len(tokens2):
            return 0.0
        
        matches = sum(1 for t1, t2 in zip(tokens1, tokens2) if t1 == t2)
        return matches / len(tokens1)


class TestPulse:
    """
    Analyzes CI runs for flakiness and environment issues.
    """
    def __init__(self, db_session=None):
        self.db = db_session
        self.clusterer = DrainClusterer()

    def analyze_logs(self, logs: Dict[str, str]) -> Dict:
        """
        Main analysis entry point.
        Expects a dict of {filename: content}.
        """
        all_lines = []
        for content in logs.values():
            # Only look at error/failure lines for clustering to save time
            lines = [l for l in content.splitlines() if any(k in l.lower() for k in ['error', 'fail', 'exception', 'traceback'])]
            all_lines.extend(lines)
            
        clusters = self.clusterer.cluster(all_lines[:1000]) # Limit to 1000 lines for speed
        
        return {
            "clusters": clusters[:10], # Top 10 failure patterns
            "total_errors": len(all_lines),
            "flakiness_prob": self._calculate_flakiness_probability(clusters)
        }

    def _calculate_flakiness_probability(self, clusters: List[Dict]) -> float:
        """
        Bayesian-inspired flakiness probability.
        If we see many different failure patterns on the same codebase, 
        or if the same pattern appears randomly across many runs, it's likely flaky.
        """
        if not clusters:
            return 0.0
            
        # Simplified: higher diversity of errors = higher flakiness probability
        # In real Bayesian model, we'd use: P(Flaky | Pattern) = P(Pattern | Flaky) * P(Flaky) / P(Pattern)
        diversity = len(clusters) / (sum(c['count'] for c in clusters) or 1)
        
        return min(diversity * 2.0, 1.0)

    def correlate_environment(self, runs: List[Dict]) -> Dict:
        """
        Correlate failures with environment factors (OS, Runner, etc.)
        """
        environment_stats = defaultdict(lambda: {"total": 0, "failed": 0})
        
        for run in runs:
            env = run.get("environment", "unknown")
            conclusion = run.get("conclusion")
            
            environment_stats[env]["total"] += 1
            if conclusion == "failure":
                environment_stats[env]["failed"] += 1
                
        correlations = {}
        for env, stats in environment_stats.items():
            failure_rate = stats["failed"] / stats["total"] if stats["total"] > 0 else 0
            correlations[env] = {
                "failure_rate": round(failure_rate, 2),
                "is_outlier": failure_rate > 0.5 and stats["total"] > 5
            }
            
        return correlations

# Global instance helper
async def get_test_pulse():
    return TestPulse()
