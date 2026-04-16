"""
TestPulse - Per-run CI log clustering (ci-worker copy).

Only handles per-run log analysis. Cross-run flakiness detection lives
in api/test_pulse.py and requires a DB session.
"""

import re
from typing import List, Dict


class DrainClusterer:
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
    def __init__(self):
        self.clusterer = DrainClusterer()

    def analyze_logs(self, logs: Dict[str, str]) -> Dict:
        """
        Cluster error patterns from a single CI run's logs.
        Returns cluster list and total error line count only.
        Flakiness is NOT computed here — it requires cross-run DB analysis.
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
        }
