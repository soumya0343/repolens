"""
TestPulse - Per-run CI log clustering (ci-worker copy).

Only handles per-run log analysis. Cross-run flakiness detection lives
in api/test_pulse.py and requires a DB session.

Structured parsing:
- JUnit XML (pytest, Maven, Gradle, etc.) — detected by '<' prefix
- Jest JSON (--json flag) — detected by '{' prefix + 'testResults' key
When a structured format is detected, failed test names are extracted and
returned as `failed_tests` alongside the error clusters.
"""

import re
import json
import xml.etree.ElementTree as ET
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


def _parse_junit_xml(content: str) -> List[Dict]:
    """Extract failed/errored test cases from JUnit XML."""
    results = []
    try:
        root = ET.fromstring(content)
        suites = list(root) if root.tag == 'testsuites' else ([root] if root.tag == 'testsuite' else [])
        for suite in suites:
            for case in suite.findall('testcase'):
                name = case.get('name', '')
                classname = case.get('classname', '')
                full_name = f"{classname}.{name}" if classname else name
                failure = case.find('failure')
                error = case.find('error')
                if failure is not None or error is not None:
                    node = failure if failure is not None else error
                    results.append({
                        'name': full_name,
                        'status': 'failed',
                        'message': (node.get('message') or (node.text or ''))[:500],
                    })
    except ET.ParseError:
        pass
    return results


def _parse_jest_json(content: str) -> List[Dict]:
    """Extract failed test cases from Jest --json output."""
    results = []
    try:
        data = json.loads(content)
        if not isinstance(data, dict) or 'testResults' not in data:
            return []
        for suite in data.get('testResults', []):
            for test in suite.get('testResults', []):
                if test.get('status') == 'failed':
                    results.append({
                        'name': test.get('fullName') or test.get('title', ''),
                        'status': 'failed',
                        'message': ' '.join(test.get('failureMessages', []))[:500],
                    })
    except (json.JSONDecodeError, KeyError, TypeError):
        pass
    return results


class TestPulse:
    def __init__(self):
        self.clusterer = DrainClusterer()

    def analyze_logs(self, logs: Dict[str, str]) -> Dict:
        """
        Cluster error patterns from a single CI run's logs.
        When structured output (JUnit XML or Jest JSON) is present in any log file,
        also extracts named failed tests and returns them as `failed_tests`.
        Flakiness is NOT computed here — it requires cross-run DB analysis.
        """
        all_lines = []
        parsed_failures = []

        for content in logs.values():
            stripped = content.lstrip()
            # Try structured parsers before falling back to line scanning
            if stripped.startswith('<'):
                parsed_failures.extend(_parse_junit_xml(content))
            elif stripped.startswith('{') or stripped.startswith('['):
                parsed_failures.extend(_parse_jest_json(content))

            lines = [
                l for l in content.splitlines()
                if any(k in l.lower() for k in ['error', 'fail', 'exception', 'traceback'])
            ]
            all_lines.extend(lines)

        clusters = self.clusterer.cluster(all_lines[:1000])
        result: Dict = {
            "clusters": clusters[:10],
            "total_errors": len(all_lines),
        }
        if parsed_failures:
            # Deduplicate by test name, keep first occurrence
            seen = set()
            deduped = []
            for t in parsed_failures:
                if t['name'] not in seen:
                    seen.add(t['name'])
                    deduped.append(t)
            result["failed_tests"] = deduped[:50]
        return result
