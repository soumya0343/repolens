"""
Tests for pure functions in classifier-worker/worker.py.
Functions are copied here to avoid loading heavy deps (sqlalchemy, arq, etc.)
that aren't installed in CI without Docker.
"""
import json
import os
import unittest


# ── Functions under test (copied from worker.py — keep in sync) ──────────────

def _parse_scores(text: str) -> list | None:
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
    try:
        result = json.loads(text)
        return result if isinstance(result, list) else None
    except Exception:
        return None


def _get_keys(env_var: str) -> list[str]:
    keys = []
    for suffix in ["", "_2", "_3"]:
        v = os.getenv(f"{env_var}{suffix}", "").strip()
        if v:
            keys.append(v)
    return keys


# ── Tests ─────────────────────────────────────────────────────────────────────

class ParseScoresTests(unittest.TestCase):
    def test_plain_json_array(self):
        self.assertEqual(_parse_scores("[1, 2, 3]"), [1, 2, 3])

    def test_fenced_json(self):
        self.assertEqual(_parse_scores("```json\n[5, 7, 2]\n```"), [5, 7, 2])

    def test_fenced_no_lang(self):
        self.assertEqual(_parse_scores("```\n[3]\n```"), [3])

    def test_invalid_returns_none(self):
        self.assertIsNone(_parse_scores("not json"))

    def test_non_list_returns_none(self):
        self.assertIsNone(_parse_scores('{"key": 1}'))

    def test_whitespace_stripped(self):
        self.assertEqual(_parse_scores("  [4, 5]  "), [4, 5])

    def test_empty_array(self):
        self.assertEqual(_parse_scores("[]"), [])


class GetKeysTests(unittest.TestCase):
    def setUp(self):
        for k in ["TEST_KEY", "TEST_KEY_2", "TEST_KEY_3"]:
            os.environ.pop(k, None)

    def tearDown(self):
        for k in ["TEST_KEY", "TEST_KEY_2", "TEST_KEY_3"]:
            os.environ.pop(k, None)

    def test_no_keys_returns_empty(self):
        self.assertEqual(_get_keys("TEST_KEY"), [])

    def test_single_key(self):
        os.environ["TEST_KEY"] = "abc"
        self.assertEqual(_get_keys("TEST_KEY"), ["abc"])

    def test_multiple_keys(self):
        os.environ["TEST_KEY"] = "k1"
        os.environ["TEST_KEY_2"] = "k2"
        os.environ["TEST_KEY_3"] = "k3"
        self.assertEqual(_get_keys("TEST_KEY"), ["k1", "k2", "k3"])

    def test_gap_skipped_but_continues(self):
        # _2 unset — primary AND _3 both returned; gaps don't stop iteration
        os.environ["TEST_KEY"] = "k1"
        os.environ["TEST_KEY_3"] = "k3"
        self.assertEqual(_get_keys("TEST_KEY"), ["k1", "k3"])

    def test_whitespace_stripped(self):
        os.environ["TEST_KEY"] = "  key_with_spaces  "
        self.assertEqual(_get_keys("TEST_KEY"), ["key_with_spaces"])


if __name__ == "__main__":
    unittest.main()
