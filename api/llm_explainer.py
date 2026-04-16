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


def _make_model(system_instruction: str):
    if not _HAS_GEMINI:
        return None
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return None
    genai.configure(api_key=api_key)
    return genai.GenerativeModel(
        model_name="gemini-1.5-flash",
        system_instruction=system_instruction,
    )


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

        model = _make_model(EXPLAIN_SYSTEM)
        if model is None:
            return self._fallback_explain(repo_name, pr_details, risk_data)

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
            response = await model.generate_content_async(user_prompt)
            text = response.text.strip()
            # Strip markdown fences if model adds them despite instructions
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            result = json.loads(text)
            await self._cache_set(key, result)
        except Exception as e:
            # Do not cache errors — a transient failure should not poison the cache for 30 days
            return {"error": "Unable to generate risk explanation.", "_error": str(e)}

        return result

    async def generate_arch_policy(self, repo_stats: Dict, violations: List) -> str:
        """Generate OPA Rego policy stubs from violation patterns."""
        key = _cache_key("arch_policy", json.dumps(violations, sort_keys=True))

        cached = await self._cache_get(key)
        if cached:
            return cached.get("policy", "")

        model = _make_model(ARCH_POLICY_SYSTEM)
        if model is None:
            return None
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
            response = await model.generate_content_async(user_prompt)
            text = response.text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            result = json.loads(text)
            await self._cache_set(key, result)
            return result.get("policy", "")
        except Exception as e:
            # Do not cache errors
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

        model = _make_model(REFACTOR_SYSTEM)
        if model is None:
            return {"error": "Unable to generate refactoring suggestions: GEMINI_API_KEY not configured."}
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
            response = await model.generate_content_async(user_prompt)
            text = response.text.strip()
            if text.startswith("```"):
                text = text.split("```")[1]
                if text.startswith("json"):
                    text = text[4:]
            result = json.loads(text)
            await self._cache_set(key, result)
        except Exception as e:
            # Do not cache errors
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

        model = _make_model("Classify commit messages. Return only valid JSON array.")
        if model is None:
            return [{"sha": c.get("sha"), "category": None} for c in commits]

        batch_prompt = f"""Classify each commit message into exactly one category:
feature, bugfix, hotfix, refactor, chore, test, docs

Return a JSON array of {{"sha": "...", "category": "..."}} objects. No explanation.

Commits:
{json.dumps([{{"sha": c.get("sha", ""), "message": c.get("message", "")}} for c in commits[:20]], indent=2)}"""

        try:
            response = await model.generate_content_async(batch_prompt)
            text = response.text.strip()
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
