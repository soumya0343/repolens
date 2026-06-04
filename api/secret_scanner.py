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
    "__tests__",
    "fixtures",
    "mocks",
    "__mocks__",
    "testdata",
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
    ".md",
    ".rst",
    ".txt",
    ".svg",
    "package-lock.json",
    "pnpm-lock.yaml",
    "poetry.lock",
    "cargo.lock",
}

# Files whose names indicate example/template/test content
SKIP_FILE_NAME_PARTS = {
    ".example",
    ".sample",
    ".template",
    ".test.",
    ".spec.",
    "_test.",
    "_spec.",
    "test_",
    "mock_",
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
    "replace",
    "insert",
    "<",
    ">",
    "none",
    "null",
    "undefined",
    "n/a",
    "default",
}

# Patterns that indicate the value is an env/config reference, not a real secret
ENV_REF_RE = re.compile(
    r"""
    os\.environ|
    os\.getenv|
    process\.env\.|
    getenv\(|
    environ\[|
    \$\{[A-Z_]+\}|       # ${VAR}
    \$[A-Z_]{3,}|        # $VAR_NAME
    %\([A-Za-z_]+\)s|    # %(VAR)s  Python format
    \{\{[A-Za-z_]+\}\}|  # {{VAR}}  Jinja/template
    config\.[a-z]|
    settings\.[a-z]|
    secrets\.[a-z]
    """,
    re.VERBOSE,
)

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
    # ── Source control ────────────────────────────────────────────────────────
    Detector(
        "github_token",
        re.compile(r"\b((?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,})\b"),
        "critical", 0.95,
        "GitHub personal access token detected.",
    ),
    Detector(
        "github_pat",
        re.compile(r"\b(github_pat_[A-Za-z0-9_]{30,})\b"),
        "critical", 0.95,
        "GitHub fine-grained token detected.",
    ),
    Detector(
        "gitlab_token",
        re.compile(r"\b(glpat-[A-Za-z0-9_-]{20,})\b"),
        "critical", 0.95,
        "GitLab personal access token detected.",
    ),

    # ── Cloud providers ───────────────────────────────────────────────────────
    Detector(
        "aws_access_key",
        re.compile(r"\b((?:AKIA|ASIA)[A-Z0-9]{16})\b"),
        "critical", 0.95,
        "AWS access key ID detected.",
    ),
    Detector(
        "google_api_key",
        re.compile(r"\b(AIza[0-9A-Za-z_-]{35})\b"),
        "high", 0.9,
        "Google API key detected.",
    ),
    Detector(
        "gcp_service_account",
        re.compile(r'"type"\s*:\s*"service_account"'),
        "critical", 0.97,
        "GCP service account JSON detected.",
        group=0,
    ),
    Detector(
        "azure_subscription_key",
        re.compile(r"\b(Ocp-Apim-Subscription-Key['\"]?\s*[:=]\s*['\"]?([A-Za-z0-9]{32}))\b", re.I),
        "critical", 0.88,
        "Azure Cognitive Services subscription key detected.",
    ),

    # ── LLM / AI providers ────────────────────────────────────────────────────
    Detector(
        "openai_key",
        re.compile(r"\b(sk-(?:proj-|org-)?[A-Za-z0-9]{20,}T3BlbkFJ[A-Za-z0-9]{20,})\b"),
        "critical", 0.97,
        "OpenAI API key detected.",
    ),
    Detector(
        "openai_key_legacy",
        # Legacy/test format: sk- + 32–60 alphanumeric (distinguishes from Stability AI at 98-102)
        re.compile(r"\b(sk-[A-Za-z0-9]{32,60})\b"),
        "high", 0.85,
        "OpenAI-style API key detected (legacy format).",
    ),
    Detector(
        "anthropic_key",
        re.compile(r"\b(sk-ant-(?:api\d+-)?[A-Za-z0-9_-]{88,})\b"),
        "critical", 0.97,
        "Anthropic API key detected.",
    ),
    Detector(
        "huggingface_token",
        re.compile(r"\b(hf_[A-Za-z0-9]{34,})\b"),
        "critical", 0.95,
        "Hugging Face access token detected.",
    ),
    Detector(
        "replicate_token",
        re.compile(r"\b(r8_[A-Za-z0-9]{38,})\b"),
        "critical", 0.95,
        "Replicate API token detected.",
    ),
    Detector(
        "groq_key",
        re.compile(r"\b(gsk_[A-Za-z0-9]{50,})\b"),
        "critical", 0.95,
        "Groq API key detected.",
    ),
    Detector(
        "perplexity_key",
        re.compile(r"\b(pplx-[A-Za-z0-9]{48,})\b"),
        "critical", 0.95,
        "Perplexity AI API key detected.",
    ),
    Detector(
        "mistral_key",
        # Mistral keys are random 32-char alphanumeric — match only when clearly assigned
        re.compile(r"(?:mistral[_-]?(?:api[_-]?)?key|MISTRAL[_-]?API[_-]?KEY)\s*[:=]\s*['\"]([A-Za-z0-9]{32})['\"]", re.I),
        "critical", 0.88,
        "Mistral AI API key detected.",
    ),
    Detector(
        "cohere_key",
        re.compile(r"(?:cohere[_-]?(?:api[_-]?)?key|CO_API_KEY)\s*[:=]\s*['\"]([A-Za-z0-9]{40})['\"]", re.I),
        "critical", 0.88,
        "Cohere API key detected.",
    ),
    Detector(
        "together_ai_key",
        re.compile(r"(?:together[_-]?(?:api[_-]?)?key|TOGETHER_API_KEY)\s*[:=]\s*['\"]([A-Za-z0-9]{64})['\"]", re.I),
        "critical", 0.88,
        "Together AI API key detected.",
    ),
    Detector(
        "elevenlabs_key",
        re.compile(r"(?:eleven(?:labs)?[_-]?(?:api[_-]?)?key|ELEVEN(?:LABS)?_API_KEY)\s*[:=]\s*['\"]([a-f0-9]{32})['\"]", re.I),
        "critical", 0.88,
        "ElevenLabs API key detected.",
    ),
    Detector(
        "stability_ai_key",
        re.compile(r"\b(sk-[A-Za-z0-9]{98,102})\b"),
        "high", 0.82,
        "Stability AI API key detected.",
    ),

    # ── Comms & infra ─────────────────────────────────────────────────────────
    Detector(
        "slack_token",
        re.compile(r"\b(xox[baprs]-[A-Za-z0-9-]{20,})\b"),
        "critical", 0.92,
        "Slack token detected.",
    ),
    Detector(
        "stripe_key",
        re.compile(r"\b((?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{24,})\b"),
        "critical", 0.95,
        "Stripe API key detected.",
    ),
    Detector(
        "twilio_key",
        re.compile(r"\b(SK[a-f0-9]{32})\b"),
        "high", 0.85,
        "Twilio API key detected.",
    ),
    Detector(
        "sendgrid_key",
        re.compile(r"\b(SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43})\b"),
        "critical", 0.95,
        "SendGrid API key detected.",
    ),
    Detector(
        "npm_token",
        re.compile(r"\b(npm_[A-Za-z0-9]{36})\b"),
        "high", 0.92,
        "npm access token detected.",
    ),

    # ── Crypto material ───────────────────────────────────────────────────────
    Detector(
        "private_key",
        re.compile(r"-----BEGIN ([A-Z ]+ )?PRIVATE KEY-----"),
        "critical", 0.98,
        "Private key material detected.",
        group=0,
    ),
    Detector(
        "database_url_password",
        re.compile(r"\b([a-z][a-z0-9+.-]*://[^:\s/@]+:[A-Za-z0-9!@#$%^&*_+=]{8,}@(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^'\")\s]+)", re.I),
        "critical", 0.9,
        "Connection URL with embedded password detected.",
    ),
    Detector(
        "jwt",
        re.compile(r"\b(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,})\b"),
        "high", 0.8,
        "JWT token detected.",
    ),
)

GENERIC_ASSIGNMENT_RE = re.compile(
    r"""(?ix)
    \b(api[_-]?key|access[_-]?key|secret[_-]?key|password|passwd|private[_-]?key)\b
    \s*[:=]\s*
    ["']([A-Za-z0-9_./+=:@!#$%^&*-]{20,})["']
    """
)


def should_scan_path(file_path: str) -> bool:
    normalized = file_path.replace("\\", "/")
    parts = {p for p in normalized.split("/") if p}
    if parts & SKIP_DIR_PARTS:
        return False
    lower = normalized.lower()
    if any(lower.endswith(suffix) for suffix in SKIP_FILE_SUFFIXES):
        return False
    # Skip example/template/test files
    filename = normalized.split("/")[-1].lower()
    if any(part in filename for part in SKIP_FILE_NAME_PARTS):
        return False
    return True


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
    if any(part in lower for part in PLACEHOLDER_PARTS):
        return True
    return False


def _is_env_reference(line: str, value: str) -> bool:
    """Return True if the value is clearly an env/config reference, not a literal secret."""
    if ENV_REF_RE.search(line):
        return True
    # Value itself looks like a variable reference (e.g. process.env.SECRET_KEY)
    if ENV_REF_RE.search(value):
        return True
    return False


def _looks_like_real_secret(value: str) -> bool:
    """
    Real secrets have high entropy AND contain mixed character types.
    Rejects: all-lowercase words, file paths, version strings, plain variable names.
    """
    v = value.strip()
    # File paths
    if v.startswith(("/", "./", "../", "~/")):
        return False
    # Version strings like 1.2.3 or v1.2.3
    if re.match(r"^v?\d+\.\d+", v):
        return False
    # All lowercase alpha (plain word/variable reference)
    if re.match(r"^[a-z_]+$", v):
        return False
    # All uppercase alpha (constant name)
    if re.match(r"^[A-Z_]+$", v):
        return False
    # Must contain at least one digit — real secrets almost always do
    if not re.search(r"\d", v):
        return False
    # Must contain at least one letter
    if not re.search(r"[A-Za-z]", v):
        return False
    return True


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
        # Skip comment lines — high false positive rate
        stripped = line.lstrip()
        if stripped.startswith(("#", "//", "*", "<!--", "/*")):
            continue

        for detector in DETECTORS:
            for match in detector.pattern.finditer(line):
                value = match.group(detector.group)
                if is_placeholder(value):
                    continue
                if _is_env_reference(line, value):
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
            if _is_env_reference(line, value):
                continue
            # Require high entropy + mixed chars for generic detection
            if entropy(value) < 4.2:
                continue
            if not _looks_like_real_secret(value):
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
