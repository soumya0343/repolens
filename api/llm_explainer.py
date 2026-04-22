"""
LLM Explainer - Root-Cause, Policy Generation and Refactoring

Uses Google Gemini (gemini-1.5-flash) with Redis caching (30-day TTL).
Requires GEMINI_API_KEY env var. Falls back to structured placeholder if not set.

Note: execution plan references Anthropic API — this implementation uses Gemini.
To switch, replace google.generativeai calls with anthropic SDK.
"""

import os
import json
import hashlib
from typing import Dict, List, Optional

import redis.asyncio as aioredis

try:
    import google.generativeai as genai
    _HAS_GEMINI = True
except ImportError:
    _HAS_GEMINI = False

REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
REDIS_PORT = int(os.getenv("REDIS_PORT", 6379))
CACHE_TTL = 60 * 60 * 24 * 30  # 30 days

EXPLAIN_SYSTEM = """You are a senior software architect reviewing a pull request risk assessment.
You receive structured signals from analysis engines and must explain the risk in plain English
that a mid-level developer can act on immediately.
Be specific — name exact files and rules. Never be vague.
Output ONLY valid JSON matching the schema provided. No markdown fences."""

ARCH_POLICY_SYSTEM = """You are a software architect generating architectural policy rules.
Given violation patterns, produce OPA-compatible Rego policy stubs.
Output ONLY valid JSON. No markdown."""

REFACTOR_SYSTEM = """You are a senior engineer suggesting concrete refactoring steps.
Given a list of architectural issues, produce specific, actionable suggestions.
Output ONLY valid JSON. No markdown."""


def _cache_key(prefix: str, data: str) -> str:
    h = hashlib.sha256(data.encode()).hexdigest()[:16]
    return f"llm:{prefix}:{h}"


def _gemini_keys() -> list[str]:
    return [v.strip() for s in ["", "_2", "_3"] if (v := os.getenv(f"GEMINI_API_KEY{s}", ""))]


def _make_model(system_instruction: str):
    if not _HAS_GEMINI:
        return None
    keys = _gemini_keys()
    if not keys:
        return None
    genai.configure(api_key=keys[0])
    return genai.GenerativeModel(
        model_name="gemini-1.5-flash",
        system_instruction=system_instruction,
    )


async def _generate_with_fallback(system_instruction: str, prompt: str) -> str | None:
    """Try each Gemini key in order, rotate on quota errors."""
    if not _HAS_GEMINI:
        return None
    for key in _gemini_keys():
        try:
            genai.configure(api_key=key)
            model = genai.GenerativeModel(
                model_name="gemini-1.5-flash",
                system_instruction=system_instruction,
            )
            resp = await model.generate_content_async(prompt)
            return resp.text
        except Exception as e:
            if "429" in str(e) or "quota" in str(e).lower():
                continue
            raise
    return None


class LLMExplainer:
    def __init__(self):
        self._redis: Optional[aioredis.Redis] = None

    async def _get_redis(self) -> aioredis.Redis:
        if self._redis is None:
            self._redis = aioredis.from_url(
                f"redis://{REDIS_HOST}:{REDIS_PORT}", decode_responses=True
            )
        return self._redis

    async def _cache_get(self, key: str) -> Optional[Dict]:
        try:
            r = await self._get_redis()
            raw = await r.get(key)
            return json.loads(raw) if raw else None
        except Exception:
            return None

    async def _cache_set(self, key: str, value: Dict):
        try:
            r = await self._get_redis()
            await r.setex(key, CACHE_TTL, json.dumps(value))
        except Exception:
            pass

    async def explain_risk(
        self,
        repo_name: str,
        pr_details: Dict,
        risk_data: Dict,
    ) -> Dict:
        """Explain PR risk — cached by (repo, pr details, risk data) hash."""
        raw = json.dumps({"repo": repo_name, "pr": pr_details, "risk": risk_data}, sort_keys=True)
        key = _cache_key("explain", raw)

        cached = await self._cache_get(key)
        if cached:
            return cached

        user_prompt = f"""Repository: {repo_name}
PR Title: {pr_details.get('title', 'N/A')}
Changed files: {', '.join(pr_details.get('files', []))}

Signals:
- Coupling risk: {risk_data.get('coupling', 'N/A')}
- Architecture violations: {risk_data.get('architecture', 'N/A')}
- Bus factor risk: {risk_data.get('bus_factor', 'N/A')}
- CI flakiness: {risk_data.get('ci', 'N/A')}
- Collaboration score: {risk_data.get('collaboration', 'N/A')}

Return JSON:
{{
  "summary": "<one sentence>",
  "root_causes": ["<cause 1>", "<cause 2>"],
  "mitigation_steps": ["<step 1>", "<step 2>"],
  "risk_level": "low|medium|high|critical",
  "actions": [
    {{"type": "add_file|fix_violation|add_reviewer|fix_test|warning", "file": "<path or null>", "description": "<what to do>"}}
  ]
}}"""

        try:
            text = await _generate_with_fallback(EXPLAIN_SYSTEM, user_prompt)
            if text is None:
                return self._fallback_explain(repo_name, pr_details, risk_data)
            text = text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            result = json.loads(text)
            await self._cache_set(key, result)
        except Exception as e:
            return {"error": "Unable to generate risk explanation.", "_error": str(e)}

        return result

    async def generate_arch_policy(self, repo_stats: Dict, violations: List) -> str:
        """Generate OPA Rego policy stubs from violation patterns."""
        key = _cache_key("arch_policy", json.dumps(violations, sort_keys=True))

        cached = await self._cache_get(key)
        if cached:
            return cached.get("policy", "")

        if not violations:
            return None

        user_prompt = f"""Violations detected:
{json.dumps(violations[:20], indent=2)}

Generate a Rego policy JSON with this schema:
{{
  "policy": "<rego policy string>",
  "rules": [{{"id": "<id>", "description": "<what it enforces>"}}]
}}"""

        try:
            text = await _generate_with_fallback(ARCH_POLICY_SYSTEM, user_prompt)
            if text is None:
                return None
            text = text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            result = json.loads(text)
            await self._cache_set(key, result)
            return result.get("policy", "")
        except Exception:
            return None

    async def suggest_refactoring(self, issues: List, file_content: str = "") -> Dict:
        """Suggest code refactorings for architectural issues.

        file_content: actual source code of the affected file. Pass empty string only
        if the file is genuinely unavailable — without content, suggestions are generic.
        """
        # Cache key includes content so different file versions don't collide
        raw = json.dumps({"issues": issues, "content_hash": hashlib.sha256(file_content.encode()).hexdigest()[:8]}, sort_keys=True)
        key = _cache_key("refactor", raw)

        cached = await self._cache_get(key)
        if cached:
            return cached

        if not issues:
            return {"error": "Unable to generate refactoring suggestions: no issues provided."}

        content_section = (
            f"File content (first 3000 chars):\n```\n{file_content[:3000]}\n```\n\n"
            if file_content.strip()
            else "(File content not available — suggestions may be less specific.)\n\n"
        )

        user_prompt = f"""{content_section}Issues detected:
{json.dumps(issues[:10], indent=2)}

Return JSON:
{{
  "suggestions": [
    {{"type": "<pattern name>", "description": "<what to change>", "benefit": "<why>"}}
  ],
  "priority": "low|medium|high"
}}"""

        try:
            text = await _generate_with_fallback(REFACTOR_SYSTEM, user_prompt)
            if text is None:
                return {"error": "Unable to generate refactoring suggestions: no API keys available."}
            text = text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            result = json.loads(text)
            await self._cache_set(key, result)
        except Exception as e:
            return {"error": "Unable to generate refactoring suggestions.", "_error": str(e)}

        return result

    async def classify_commits(self, commits: List[Dict]) -> List[Dict]:
        """Batch-classify commit messages. Returns [{sha, category}]."""
        if not commits:
            return []

        key = _cache_key("classify", json.dumps([c.get("sha", "") for c in commits]))
        cached = await self._cache_get(key)
        if cached:
            return cached

        batch_prompt = f"""Classify each commit message into exactly one category:
feature, bugfix, hotfix, refactor, chore, test, docs

Return a JSON array of {{"sha": "...", "category": "..."}} objects. No explanation.

Commits:
{json.dumps([{{"sha": c.get("sha", ""), "message": c.get("message", "")}} for c in commits[:20]], indent=2)}"""

        try:
            text = await _generate_with_fallback("Classify commit messages. Return only valid JSON array.", batch_prompt)
            if text is None:
                return [{"sha": c.get("sha"), "category": None} for c in commits]
            text = text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            result = json.loads(text)
            if isinstance(result, list):
                await self._cache_set(key, result)
                return result
        except Exception:
            pass

        return [{"sha": c.get("sha"), "category": None} for c in commits]


async def get_llm_explainer() -> LLMExplainer:
    return LLMExplainer()
