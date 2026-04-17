import unittest
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
from secret_scanner import scan_text


class SecretScannerTests(unittest.TestCase):
    def test_detects_provider_tokens_without_returning_raw_value(self):
        raw = "ghp_1234567890abcdefghijklmnopqrstuvwxyz"
        findings = scan_text("app/config.py", f"GITHUB_TOKEN = '{raw}'")

        self.assertTrue(any(f["detector"] == "github_token" for f in findings))
        self.assertFalse(any(raw in str(f) for f in findings))
        self.assertTrue(all("masked_value" in f and "fingerprint_hash" in f for f in findings))

    def test_ignores_placeholders(self):
        findings = scan_text("README.md", "OPENAI_API_KEY=your_openai_api_key")
        self.assertEqual(findings, [])

    def test_scans_only_added_patch_lines(self):
        raw = "sk-abcdefghijklmnopqrstuvwxyz1234567890"
        patch = (
            "@@ -1,2 +1,2 @@\n"
            f"-OPENAI_API_KEY={raw}\n"
            "+OPENAI_API_KEY=your_openai_api_key\n"
        )

        findings = scan_text("src/app.ts", patch, mode="pull_request")
        self.assertEqual(findings, [])

        patch = (
            "@@ -1,2 +1,2 @@\n"
            "-OPENAI_API_KEY=your_openai_api_key\n"
            f"+OPENAI_API_KEY={raw}\n"
        )
        findings = scan_text("src/app.ts", patch, mode="pull_request")
        self.assertTrue(any(f["detector"] == "openai_key" for f in findings))

    def test_detects_generic_high_entropy_assignment(self):
        findings = scan_text("settings.py", "api_key = 'A1b2C3d4E5f6G7h8I9j0K1l2'")
        self.assertTrue(any(f["detector"].startswith("generic_") for f in findings))


if __name__ == "__main__":
    unittest.main()
