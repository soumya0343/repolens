import os
from fastapi import APIRouter, Depends, Body, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from database import get_db
from models import ArchAnalysis, Repo, UserRepo
from pydantic import BaseModel
import uuid
from typing import Dict, Any

router = APIRouter(prefix='/internal', tags=['internal'])

INTERNAL_API_KEY = os.getenv("REPOLENS_API_KEY", "internal_key")

def _verify_internal(x_internal_key: str = Header(None)):
    if x_internal_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="Forbidden")
    return True

class ArchData(BaseModel):
    repo_id: str
    data: Dict[str, Any]

@router.post('/arch_complete')
async def arch_complete(data: ArchData = Body(...), db: AsyncSession = Depends(get_db)):
    # Upsert logic - delete old, add new
    stmt = select(ArchAnalysis).where(ArchAnalysis.repo_id == data.repo_id)
    result = await db.execute(stmt)
    old = result.scalar_one_or_none()
    if old:
        await db.delete(old)
    analysis = ArchAnalysis(
        repo_id=data.repo_id,
        violations=data.data.get('violations'),
        import_cycles=data.data.get('import_cycles')
    )
    db.add(analysis)
    await db.commit()
    await db.refresh(analysis)
    return {'status': 'saved', 'id': str(analysis.id)}


# ── Bot-facing internal endpoints ──────────────────────────────────────────

@router.get('/repos/lookup', dependencies=[Depends(_verify_internal)])
async def lookup_repo(owner: str, name: str, db: AsyncSession = Depends(get_db)):
    """Find a RepoLens repo by GitHub owner/name — called by the bot."""
    result = await db.execute(
        select(Repo).where(Repo.owner == owner, Repo.name == name)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not connected to RepoLens")
    return {"id": str(repo.id), "owner": repo.owner, "name": repo.name}


@router.get('/repos/{repo_id}/analysis', dependencies=[Depends(_verify_internal)])
async def get_bot_analysis(repo_id: str, db: AsyncSession = Depends(get_db)):
    """Return full risk analysis for the bot to include in PR comments."""
    from risk_scorer import get_unified_risk_scorer
    from llm_explainer import get_llm_explainer
    from models import Commit, PullRequest

    result = await db.execute(select(Repo).where(Repo.id == repo_id))
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    scorer = await get_unified_risk_scorer(db)
    risk = await scorer.calculate_repo_risk(repo_id)

    # Latest merged PR for explanation context
    pr_result = await db.execute(
        select(PullRequest)
        .where(PullRequest.repo_id == repo_id)
        .order_by(PullRequest.created_at.desc())
        .limit(1)
    )
    latest_pr = pr_result.scalars().first()

    explanation = None
    if latest_pr:
        explainer = await get_llm_explainer()
        explanation = await explainer.explain_risk(
            repo_name=f"{repo.owner}/{repo.name}",
            pr_details={"title": latest_pr.title or "", "files": []},
            risk_data={
                "coupling": risk["breakdown"]["coupling"] / 100,
                "architecture": risk["breakdown"]["architecture"] / 100,
                "bus_factor": risk["breakdown"]["bus_factor"] / 100,
                "ci": risk["breakdown"]["ci"] / 100,
                "collaboration": risk["breakdown"]["collaboration"] / 100,
            },
        )

    # Arch violations for inline PR annotations
    arch_result = await db.execute(
        select(ArchAnalysis)
        .where(ArchAnalysis.repo_id == repo_id)
        .order_by(ArchAnalysis.parsed_at.desc())
        .limit(1)
    )
    arch = arch_result.scalars().first()
    violations = (arch.violations or []) if arch else []

    # Bot config from repo settings
    config = repo.config or {}
    bot_config = {
        "block_threshold": config.get("block_threshold", 75),
        "warn_only": config.get("warn_only", False),
    }

    return {"risk": risk, "explanation": explanation, "violations": violations, "config": bot_config}
