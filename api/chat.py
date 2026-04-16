"""
LLM Chat Assistant — conversational interface with tool use (Groq).

POST /repos/{repo_id}/chat
  body: { "message": str, "history": [...] }
  returns: { "response": str, "history": [...] }

Tools available to the assistant:
  get_repo_overview, get_flaky_tests, get_coupling_rules,
  get_file_risk, get_bus_factor, get_risk_score
"""

import os
import json
from typing import Any, Dict, List

from fastapi import APIRouter, Depends, HTTPException, Header
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func

import jwt

from database import get_db
from models import User, Repo, UserRepo, Commit, PullRequest, CIRun, CommitFile, ArchAnalysis, PRFile

router = APIRouter(prefix="/repos", tags=["chat"])
JWT_SECRET = os.getenv("JWT_SECRET", "super_secret_jwt_key")


# ── Auth ────────────────────────────────────────────────────────────────────

async def get_current_user(authorization: str = Header(None), db: AsyncSession = Depends(get_db)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    token = authorization.split(" ")[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        user_id = payload.get("sub")
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalars().first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")


# ── Request / response models ───────────────────────────────────────────────

class ChatRequest(BaseModel):
    message: str
    history: List[Dict[str, Any]] = []


# ── Tool implementations ────────────────────────────────────────────────────

async def tool_get_repo_overview(repo_id: str, db: AsyncSession) -> Dict:
    commit_count = (await db.execute(
        select(func.count(Commit.id)).where(Commit.repo_id == repo_id)
    )).scalar() or 0

    pr_count = (await db.execute(
        select(func.count(PullRequest.id)).where(PullRequest.repo_id == repo_id)
    )).scalar() or 0

    open_prs = (await db.execute(
        select(func.count(PullRequest.id)).where(
            PullRequest.repo_id == repo_id, PullRequest.state == "OPEN"
        )
    )).scalar() or 0

    ci_count = (await db.execute(
        select(func.count(CIRun.id)).where(CIRun.repo_id == repo_id)
    )).scalar() or 0

    arch_result = await db.execute(
        select(ArchAnalysis).where(ArchAnalysis.repo_id == repo_id)
    )
    arch = arch_result.scalar_one_or_none()
    violations = len(arch.violations) if arch and arch.violations else 0

    return {
        "commits": commit_count,
        "pull_requests": pr_count,
        "open_prs": open_prs,
        "ci_runs": ci_count,
        "arch_violations": violations,
    }


async def tool_get_flaky_tests(repo_id: str, limit: int, db: AsyncSession) -> List[Dict]:
    ci_result = await db.execute(
        select(CIRun)
        .where(CIRun.repo_id == repo_id, CIRun.analysis_results.isnot(None))
        .order_by(CIRun.created_at.desc())
        .limit(100)
    )
    runs = ci_result.scalars().all()
    items = []
    for run in runs:
        ar = run.analysis_results or {}
        fp = ar.get("flakiness_prob", 0.0)
        if fp > 0:
            items.append({
                "run_name": run.name,
                "head_sha": run.head_sha,
                "flakiness_prob": round(fp, 3),
                "total_errors": ar.get("total_errors", 0),
            })
    items.sort(key=lambda x: x["flakiness_prob"], reverse=True)
    return items[:limit]


async def tool_get_coupling_rules(repo_id: str, file_path: str, db: AsyncSession) -> List[Dict]:
    from cochange_oracle import get_cochange_oracle
    oracle = await get_cochange_oracle(db)
    data = await oracle.analyze_repository(repo_id)
    links = data.get("links", [])
    if file_path:
        links = [l for l in links if file_path in (l.get("source", ""), l.get("target", ""))]
    return links[:20]


async def tool_get_file_risk(repo_id: str, file_path: str, db: AsyncSession) -> Dict:
    # Fetch target file stats
    result = await db.execute(
        select(
            CommitFile.file_path,
            func.count(CommitFile.id).label("change_count"),
            func.sum(CommitFile.additions).label("additions"),
            func.sum(CommitFile.deletions).label("deletions"),
        )
        .join(Commit, Commit.id == CommitFile.commit_id)
        .where(Commit.repo_id == repo_id, CommitFile.file_path == file_path)
        .group_by(CommitFile.file_path)
    )
    row = result.first()
    if not row:
        return {"error": f"File '{file_path}' not found in commit history"}
    change_count = row[1]

    # Compute percentile rank against all files in the repo for a meaningful risk score
    all_counts_result = await db.execute(
        select(func.count(CommitFile.id).label("change_count"))
        .join(Commit, Commit.id == CommitFile.commit_id)
        .where(Commit.repo_id == repo_id)
        .group_by(CommitFile.file_path)
    )
    all_counts = sorted(r[0] for r in all_counts_result.all())
    if all_counts:
        below = sum(1 for c in all_counts if c < change_count)
        percentile = below / len(all_counts)
        risk_score = round(percentile * 100, 1)
    else:
        risk_score = 0.0

    return {
        "file_path": file_path,
        "change_count": change_count,
        "additions": row[2] or 0,
        "deletions": row[3] or 0,
        "risk_score": risk_score,
        "risk_score_note": "Percentile rank by change frequency within this repo (0=least changed, 100=most changed)",
    }


async def tool_get_bus_factor(repo_id: str, db: AsyncSession) -> Dict:
    from churn_analyzer import get_churn_analyzer
    analyzer = await get_churn_analyzer(db)
    data = await analyzer.analyze_repository(repo_id)
    return {
        "overall_bus_factor_hhi": data.get("overall_bus_factor"),
        "risk_level": data.get("risk_level"),
        "top_contributors": data.get("contributors", [])[:5],
        "recommendations": data.get("recommendations", []),
    }


async def tool_get_risk_score(repo_id: str, db: AsyncSession) -> Dict:
    from risk_scorer import get_unified_risk_scorer
    scorer = await get_unified_risk_scorer(db)
    return await scorer.calculate_repo_risk(repo_id)


async def tool_get_dora_metrics(repo_id: str, days: int, db: AsyncSession) -> Dict:
    from release_health import get_release_health_tracker
    tracker = await get_release_health_tracker(db)
    return await tracker.get_dora_metrics(repo_id, days=days)


async def tool_get_arch_violations(repo_id: str, db: AsyncSession) -> Dict:
    arch_result = await db.execute(
        select(ArchAnalysis)
        .where(ArchAnalysis.repo_id == repo_id)
        .order_by(ArchAnalysis.parsed_at.desc())
        .limit(1)
    )
    arch = arch_result.scalar_one_or_none()
    if not arch:
        return {"violations": [], "import_cycles": []}
    violations = [
        {k: v for k, v in v.items() if k != "file_content"}  # strip large field
        for v in (arch.violations or [])
    ]
    return {
        "violations": violations,
        "import_cycles": arch.import_cycles or [],
        "violation_count": len(violations),
    }


# ── Tool dispatch ────────────────────────────────────────────────────────────

# Groq/OpenAI function-calling format
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_repo_overview",
            "description": "Get total commits, PRs, CI runs, and arch violation count for the repository.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_flaky_tests",
            "description": "Get CI runs ranked by flakiness probability.",
            "parameters": {
                "type": "object",
                "properties": {
                    "limit": {"type": "integer", "description": "Max results to return (default 10)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_coupling_rules",
            "description": "Get logical coupling rules, optionally filtered by file path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Filter rules involving this file"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_file_risk",
            "description": "Get change frequency and risk score for a specific file.",
            "parameters": {
                "type": "object",
                "properties": {
                    "file_path": {"type": "string", "description": "Path of the file"},
                },
                "required": ["file_path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_bus_factor",
            "description": "Get bus factor and code ownership concentration metrics.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_risk_score",
            "description": "Get the unified risk score and breakdown by signal.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_dora_metrics",
            "description": "Get DORA metrics: deployment frequency, lead time, change failure rate, MTTR.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {"type": "integer", "description": "Lookback window in days (default 30)"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "get_arch_violations",
            "description": "Get architectural violations and import cycles detected by ArchSentinel.",
            "parameters": {
                "type": "object",
                "properties": {},
                "required": [],
            },
        },
    },
]

CHAT_SYSTEM = """You are a senior software engineer assistant embedded in RepoLens, a repository intelligence platform.
You have access to tools that query real data about this repository: coupling rules, risk scores, bus factor, flaky tests, and more.
Answer questions concisely and accurately using the data from your tools.
When referencing files or developers, be specific. Do not invent data."""


async def _run_tool(name: str, inputs: Dict, repo_id: str, db: AsyncSession) -> Any:
    if name == "get_repo_overview":
        return await tool_get_repo_overview(repo_id, db)
    elif name == "get_flaky_tests":
        return await tool_get_flaky_tests(repo_id, inputs.get("limit", 10), db)
    elif name == "get_coupling_rules":
        return await tool_get_coupling_rules(repo_id, inputs.get("file_path", ""), db)
    elif name == "get_file_risk":
        return await tool_get_file_risk(repo_id, inputs.get("file_path", ""), db)
    elif name == "get_bus_factor":
        return await tool_get_bus_factor(repo_id, db)
    elif name == "get_risk_score":
        return await tool_get_risk_score(repo_id, db)
    elif name == "get_dora_metrics":
        return await tool_get_dora_metrics(repo_id, inputs.get("days", 30), db)
    elif name == "get_arch_violations":
        return await tool_get_arch_violations(repo_id, db)
    return {"error": f"Unknown tool: {name}"}


# ── Endpoint ─────────────────────────────────────────────────────────────────

@router.post("/{repo_id}/chat")
async def chat(
    repo_id: str,
    body: ChatRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    # Verify access
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    groq_api_key = os.getenv("GROQ_API_KEY")
    if not groq_api_key:
        return {
            "response": "LLM chat requires GROQ_API_KEY to be set.",
            "history": body.history,
        }

    try:
        from groq import AsyncGroq
        client = AsyncGroq(api_key=groq_api_key)
    except ImportError:
        return {
            "response": "groq package is not installed. Run: pip install groq",
            "history": body.history,
        }

    system_msg = {
        "role": "system",
        "content": f"{CHAT_SYSTEM}\n\nRepository: {repo.owner}/{repo.name} (id: {repo_id})",
    }

    # Serialize history — strip any non-serializable assistant message objects
    messages = []
    for m in body.history:
        if isinstance(m, dict):
            messages.append(m)

    messages.append({"role": "user", "content": body.message})

    try:
        # First call — may trigger tool use
        response = await client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=2048,
            messages=[system_msg] + messages,
            tools=TOOLS,
            tool_choice="auto",
        )

        # Agentic tool-use loop (max 3 rounds)
        for _ in range(3):
            choice = response.choices[0]
            if choice.finish_reason != "tool_calls":
                break

            # Append assistant message as a plain dict — Groq Message objects
            # are not JSON-serializable and break on consecutive tool-call rounds
            assistant_msg: Dict = {"role": "assistant", "content": choice.message.content}
            if choice.message.tool_calls:
                assistant_msg["tool_calls"] = [
                    {
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments,
                        },
                    }
                    for tc in choice.message.tool_calls
                ]
            messages.append(assistant_msg)

            # Execute each tool call
            for tc in choice.message.tool_calls:
                try:
                    inputs = json.loads(tc.function.arguments) if tc.function.arguments else {}
                except json.JSONDecodeError:
                    inputs = {}
                tool_output = await _run_tool(tc.function.name, inputs, repo_id, db)
                messages.append({
                    "role": "tool",
                    "tool_call_id": tc.id,
                    "content": json.dumps(tool_output),
                })

            response = await client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                max_tokens=2048,
                messages=[system_msg] + messages,
                tools=TOOLS,
                tool_choice="auto",
            )

        final_text = response.choices[0].message.content or ""
        messages.append({"role": "assistant", "content": final_text})
    except Exception as e:
        return {
            "response": f"LLM error: {e}",
            "history": body.history,
        }

    return {"response": final_text, "history": messages}
