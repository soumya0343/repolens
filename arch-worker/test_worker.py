"""
Tests for pure functions in arch-worker/worker.py.
Functions are copied here to avoid loading heavy deps (networkx, tree-sitter, arq)
that aren't installed in CI without Docker.
"""
import os
import re
import tempfile
import unittest
from pathlib import Path


# ── Functions under test (copied from worker.py — keep in sync) ──────────────

SECRET_SCAN_SKIP_DIRS = {'.git', 'node_modules', 'venv', '.venv', 'dist', 'build', 'coverage', '__pycache__'}
SECRET_SCAN_SKIP_SUFFIXES = {
    '.lock', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip',
    '.gz', '.tar', '.pyc', '.woff', '.woff2', 'package-lock.json',
    'pnpm-lock.yaml', 'poetry.lock', 'cargo.lock'
}


def _is_text_bytes(data: bytes) -> bool:
    if b'\x00' in data[:2048]:
        return False
    try:
        data[:4096].decode('utf-8')
        return True
    except UnicodeDecodeError:
        return False


def _should_secret_scan(path: Path, repo_dir: str) -> bool:
    rel = path.relative_to(repo_dir)
    parts = set(rel.parts)
    if parts & SECRET_SCAN_SKIP_DIRS:
        return False
    lower_name = path.name.lower()
    return not any(lower_name.endswith(suffix) for suffix in SECRET_SCAN_SKIP_SUFFIXES)


def _detect_layer_violations(import_graph, layer_map: dict, repo_dir: str) -> list:
    violations = []
    if not layer_map:
        return violations

    def file_layer(filename: str):
        for layer, prefixes in layer_map.items():
            for prefix in prefixes:
                if filename.startswith(prefix.rstrip('/') + '/') or filename == prefix:
                    return layer
        return None

    forbidden_pairs = [("infra", "domain")]
    for src_file, dst_file in import_graph.edges():
        src_layer = file_layer(src_file)
        dst_layer = file_layer(dst_file)
        if src_layer and dst_layer and src_layer != dst_layer:
            if (src_layer, dst_layer) in forbidden_pairs:
                violations.append({
                    'file': src_file,
                    'line': 1,
                    'type': 'layer_violation',
                    'severity': 'high',
                    'msg': f'Layer boundary violation: {src_layer} → {dst_layer} (import of {dst_file})',
                })
    return violations


# ── Tests ─────────────────────────────────────────────────────────────────────

class IsTextBytesTests(unittest.TestCase):
    def test_plain_ascii(self):
        self.assertTrue(_is_text_bytes(b"hello world\nfoo bar\n"))

    def test_null_byte_is_binary(self):
        self.assertFalse(_is_text_bytes(b"hello\x00world"))

    def test_valid_utf8(self):
        self.assertTrue(_is_text_bytes("print('héllo')".encode("utf-8")))

    def test_invalid_utf8_is_binary(self):
        self.assertFalse(_is_text_bytes(b"\xff\xfe" + b"A" * 100))

    def test_empty_bytes_is_text(self):
        self.assertTrue(_is_text_bytes(b""))

    def test_null_byte_after_2048_not_detected(self):
        # null beyond the 2048-byte window — not detected, treated as text
        data = b"A" * 2048 + b"\x00"
        self.assertTrue(_is_text_bytes(data))


class ShouldSecretScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()

    def _make(self, rel: str) -> Path:
        p = Path(self.tmp) / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
        return p

    def test_python_scanned(self):
        self.assertTrue(_should_secret_scan(self._make("src/app.py"), self.tmp))

    def test_typescript_scanned(self):
        self.assertTrue(_should_secret_scan(self._make("src/config.ts"), self.tmp))

    def test_node_modules_skipped(self):
        self.assertFalse(_should_secret_scan(self._make("node_modules/lodash/index.js"), self.tmp))

    def test_venv_skipped(self):
        self.assertFalse(_should_secret_scan(self._make("venv/lib/foo.py"), self.tmp))

    def test_dist_skipped(self):
        self.assertFalse(_should_secret_scan(self._make("dist/bundle.js"), self.tmp))

    def test_png_skipped(self):
        self.assertFalse(_should_secret_scan(self._make("assets/logo.png"), self.tmp))

    def test_lock_file_skipped(self):
        self.assertFalse(_should_secret_scan(self._make("package-lock.json"), self.tmp))

    def test_pyc_skipped(self):
        self.assertFalse(_should_secret_scan(self._make("app/__pycache__/foo.pyc"), self.tmp))


class DetectLayerViolationsTests(unittest.TestCase):
    def _graph(self, edges):
        class FakeGraph:
            def __init__(self, edges):
                self._edges = edges
            def edges(self):
                return self._edges
        return FakeGraph(edges)

    def test_no_layer_map_returns_empty(self):
        g = self._graph([("src/db/repo.py", "src/domain/model.py")])
        self.assertEqual(_detect_layer_violations(g, {}, "/repo"), [])

    def test_infra_imports_domain_flagged(self):
        g = self._graph([("src/db/repo.py", "src/domain/model.py")])
        layer_map = {"infra": ["src/db"], "domain": ["src/domain"]}
        result = _detect_layer_violations(g, layer_map, "/repo")
        self.assertEqual(len(result), 1)
        self.assertEqual(result[0]["type"], "layer_violation")
        self.assertIn("infra", result[0]["msg"])
        self.assertIn("domain", result[0]["msg"])

    def test_domain_to_domain_not_flagged(self):
        g = self._graph([("src/domain/a.py", "src/domain/b.py")])
        layer_map = {"infra": ["src/db"], "domain": ["src/domain"]}
        self.assertEqual(_detect_layer_violations(g, layer_map, "/repo"), [])

    def test_no_edges_no_violations(self):
        self.assertEqual(_detect_layer_violations(self._graph([]), {"infra": ["src/db"]}, "/repo"), [])

    def test_unknown_layer_not_flagged(self):
        g = self._graph([("src/utils/helper.py", "src/domain/model.py")])
        layer_map = {"infra": ["src/db"], "domain": ["src/domain"]}
        self.assertEqual(_detect_layer_violations(g, layer_map, "/repo"), [])


if __name__ == "__main__":
    unittest.main()
