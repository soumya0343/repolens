import os
import json
from dotenv import load_dotenv
load_dotenv()

from sqlalchemy.future import select
from sqlalchemy import and_
from arq.connections import RedisSettings
from database import AsyncSessionLocal
from models import Commit

_SYSTEM = (
    "You are given numbered commit messages. Classify each with a risk score 1-10 (10 = highest risk). "
    "Respond with ONLY a JSON array of numbers, exactly one per numbered commit, in order. No explanation."
)

def _get_keys(env_var: str) -> list[str]:
    """Collect all non-empty values for KEY, KEY_2, KEY_3, ..."""
    keys = []
    for suffix in ["", "_2", "_3"]:
        v = os.getenv(f"{env_var}{suffix}", "").strip()
        if v:
            keys.append(v)
    return keys


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


async def _classify_with_gemini(messages: list[str]) -> list[float] | None:
    from google import genai
    from google.genai import types

    numbered = "\n".join(f"{i+1}. {m.splitlines()[0]}" for i, m in enumerate(messages))
    for key in _get_keys("GEMINI_API_KEY"):
        try:
            client = genai.Client(api_key=key)
            resp = await client.aio.models.generate_content(
                model="gemini-2.0-flash",
                contents=numbered,
                config=types.GenerateContentConfig(system_instruction=_SYSTEM),
            )
            scores = _parse_scores(resp.text)
            if isinstance(scores, list) and len(scores) == len(messages):
                return scores
        except Exception:
            continue
    return None


async def _classify_with_groq(messages: list[str]) -> list[float] | None:
    from groq import AsyncGroq

    chunk_size = 20
    keys = _get_keys("GROQ_API_KEY")
    if not keys:
        return None

    all_scores: list[float] = []
    key_idx = 0

    for i in range(0, len(messages), chunk_size):
        chunk = messages[i:i + chunk_size]
        numbered = "\n".join(f"{j+1}. {m.splitlines()[0]}" for j, m in enumerate(chunk))
        success = False
        # Try each key until one works for this chunk
        for attempt in range(len(keys)):
            key = keys[(key_idx + attempt) % len(keys)]
            try:
                client = AsyncGroq(api_key=key)
                resp = await client.chat.completions.create(
                    model="llama-3.3-70b-versatile",
                    max_tokens=256,
                    timeout=30,
                    messages=[
                        {"role": "system", "content": _SYSTEM},
                        {"role": "user", "content": numbered},
                    ],
                )
                scores = _parse_scores(resp.choices[0].message.content)
                if isinstance(scores, list) and len(scores) == len(chunk):
                    all_scores.extend(scores)
                    key_idx = (key_idx + attempt) % len(keys)
                    success = True
                    break
            except Exception:
                continue
        if not success:
            return None

    return all_scores if len(all_scores) == len(messages) else None


async def run_commit_classification(ctx, repo_id: str):
    async with AsyncSessionLocal() as db:
        stmt = select(Commit).where(and_(Commit.repo_id == repo_id, Commit.risk_score.is_(None)))
        result = await db.execute(stmt)
        commits = result.scalars().all()

        if not commits:
            return 0

        batch = [c.message for c in commits]

        scores = await _classify_with_gemini(batch)
        if not isinstance(scores, list) or len(scores) != len(commits):
            scores = await _classify_with_groq(batch)
        if not isinstance(scores, list) or len(scores) != len(commits):
            return 0

        for commit, score in zip(commits, scores):
            try:
                commit.risk_score = float(score)
            except (TypeError, ValueError):
                pass

        await db.commit()
        return len(commits)


class WorkerSettings:
    functions = [run_commit_classification]
    redis_settings = RedisSettings(host=os.getenv("REDIS_HOST", "localhost"))
    queue_name = "classifier_queue"
