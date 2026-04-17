"""
SecretSentinel scanner.

The scanner must never return raw secret values. Findings contain only masked
values and stable fingerprints for deduplication.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Iterable, List, Optional


SKIP_DIR_PARTS = {
    ".git",
    ".hg",
    ".svn",
    "__pycache__",
    "node_modules",
    "venv",
    ".venv",
    "dist",
    "build",
    "coverage",
    ".next",
    ".turbo",
}

SKIP_FILE_SUFFIXES = {
    ".lock",
    ".png",
    ".jpg",
    ".jpeg",
    ".gif",
    ".webp",
    ".ico",
    ".pdf",
    ".zip",
    ".gz",
    ".tar",
    ".pyc",
    ".woff",
    ".woff2",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "cargo.lock",
}

PLACEHOLDER_PARTS = {
    "your_",
    "example",
    "dummy",
    "sample",
    "placeholder",
    "changeme",
    "change_me",
    "mock_",
    "test_",
    "fake_",
    "xxxx",
    "todo",
}

GENERIC_KEYWORDS = (
    "api_key",
    "apikey",
    "access_key",
    "secret",
    "token",
    "password",
    "passwd",
    "private_key",
)


@dataclass(frozen=True)
class Detector:
    name: str
    pattern: re.Pattern
    severity: str
    confidence: float
    message: str
    group: int = 1


DETECTORS: tuple[Detector, ...] = (
    Detector(
        "github_token",
        re.compile(r"\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,})\b"),
        "critical",
        0.95,
        "GitHub token-like credential detected.",
    ),
    Detector(
        "github_pat",
        re.compile(r"\b(github_pat_[A-Za-z0-9_]{30,})\b"),
        "critical",
        0.95,
        "GitHub fine-grained token-like credential detected.",
    ),
    Detector(
        "aws_access_key",
        re.compile(r"\b((?:AKIA|ASIA)[A-Z0-9]{16})\b"),
        "critical",
        0.95,
        "AWS access key id detected.",
    ),
    Detector(
        "openai_key",
        re.compile(r"\b(sk-[A-Za-z0-9_-]{32,})\b"),
        "critical",
        0.92,
        "OpenAI-style API key detected.",
    ),
    Detector(
        "google_api_key",
        re.compile(r"\b(AIza[0-9A-Za-z_-]{35})\b"),
        "high",
        0.9,
        "Google API key-like credential detected.",
    ),
    Detector(
        "slack_token",
        re.compile(r"\b(xox[baprs]-[A-Za-z0-9-]{20,})\b"),
        "critical",
        0.92,
        "Slack token-like credential detected.",
    ),
    Detector(
        "private_key",
        re.compile(r"-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----"),
        "critical",
        0.98,
        "Private key material detected.",
        group=0,
    ),
    Detector(
        "database_url_password",
        re.compile(r"\b([a-z][a-z0-9+.-]*://[^:\s/@]+:[^@\s/]+@[^'\")\s]+)", re.I),
        "critical",
        0.9,
        "Connection URL with embedded password detected.",
    ),
    Detector(
        "jwt",
        re.compile(r"\b(eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})\b"),
        "high",
        0.8,
        "JWT-like token detected.",
    ),
)

GENERIC_ASSIGNMENT_RE = re.compile(
    r"""(?ix)
    \b(api[_-]?key|access[_-]?key|secret|token|password|passwd|private[_-]?key)\b
    \s*[:=]\s*
    ["']?([A-Za-z0-9_./+=:@-]{16,})["']?
    """
)


def should_scan_path(file_path: str) -> bool:
    normalized = file_path.replace("\\", "/")
    parts = {p for p in normalized.split("/") if p}
    if parts & SKIP_DIR_PARTS:
        return False
    lower = normalized.lower()
    return not any(lower.endswith(suffix) for suffix in SKIP_FILE_SUFFIXES)


def is_probably_text(data: bytes) -> bool:
    if b"\x00" in data[:2048]:
        return False
    try:
        data[:4096].decode("utf-8")
        return True
    except UnicodeDecodeError:
        return False


def mask_secret(value: str) -> str:
    value = value.strip()
    if len(value) <= 8:
        return "****"
    return f"{value[:4]}...{value[-4:]}"


def fingerprint_secret(detector: str, value: str) -> str:
    normalized = value.strip()
    return hashlib.sha256(f"{detector}:{normalized}".encode("utf-8")).hexdigest()


def entropy(value: str) -> float:
    if not value:
        return 0.0
    counts = {c: value.count(c) for c in set(value)}
    length = len(value)
    return -sum((count / length) * math.log2(count / length) for count in counts.values())


def is_placeholder(value: str) -> bool:
    lower = value.strip().lower()
    if not lower:
        return True
    return any(part in lower for part in PLACEHOLDER_PARTS)


def _line_iter_from_patch(patch: str) -> Iterable[tuple[int, str]]:
    current_new_line: Optional[int] = None
    for line in patch.splitlines():
        if line.startswith("@@"):
            match = re.search(r"\+(\d+)", line)
            current_new_line = int(match.group(1)) if match else None
            continue
        if current_new_line is None:
            continue
        if line.startswith("+") and not line.startswith("+++"):
            yield current_new_line, line[1:]
            current_new_line += 1
        elif line.startswith("-") and not line.startswith("---"):
            continue
        else:
            current_new_line += 1


def _line_iter_from_content(content: str) -> Iterable[tuple[int, str]]:
    for idx, line in enumerate(content.splitlines(), start=1):
        yield idx, line


def _finding(file_path: str, line_number: int, detector: Detector | str, value: str, severity: str = "medium", confidence: float = 0.65, message: str = "Potential secret detected.") -> dict:
    detector_name = detector.name if isinstance(detector, Detector) else detector
    if isinstance(detector, Detector):
        severity = detector.severity
        confidence = detector.confidence
        message = detector.message
    return {
        "file_path": file_path,
        "line_number": line_number,
        "detector": detector_name,
        "severity": severity,
        "confidence": confidence,
        "masked_value": mask_secret(value),
        "fingerprint_hash": fingerprint_secret(detector_name, value),
        "message": message,
    }


def scan_text(file_path: str, content: str, mode: str = "baseline") -> List[dict]:
    if not should_scan_path(file_path):
        return []

    lines = _line_iter_from_patch(content) if mode == "pull_request" else _line_iter_from_content(content)
    findings: list[dict] = []
    seen: set[str] = set()

    for line_number, line in lines:
        for detector in DETECTORS:
            for match in detector.pattern.finditer(line):
                value = match.group(detector.group)
                if is_placeholder(value):
                    continue
                finding = _finding(file_path, line_number, detector, value)
                if finding["fingerprint_hash"] not in seen:
                    findings.append(finding)
                    seen.add(finding["fingerprint_hash"])

        for match in GENERIC_ASSIGNMENT_RE.finditer(line):
            value = match.group(2)
            keyword = match.group(1).lower().replace("-", "_")
            if is_placeholder(value):
                continue
            if entropy(value) < 3.4 and len(value) < 24:
                continue
            detector_name = f"generic_{keyword}"
            finding = _finding(
                file_path,
                line_number,
                detector_name,
                value,
                severity="high" if keyword in GENERIC_KEYWORDS else "medium",
                confidence=0.7,
                message=f"High-entropy value assigned to {keyword}.",
            )
            if finding["fingerprint_hash"] not in seen:
                findings.append(finding)
                seen.add(finding["fingerprint_hash"])

    return findings
