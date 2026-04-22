from fastapi import APIRouter, Depends, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from database import get_db
from models import CIRun
from pydantic import BaseModel
from typing import Dict, Any, Optional
from datetime import datetime, timezone

router = APIRouter(prefix='/internal', tags=['internal'])

class CIAnalysis(BaseModel):
    repo_id: str
    run_id: str
    conclusion: Optional[str] = None
    analysis: Dict[str, Any]
    head_sha: Optional[str] = None
    name: Optional[str] = None
    event: Optional[str] = None
    head_branch: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


def _parse_ts(val: Optional[str]) -> Optional[datetime]:
    if not val:
        return None
    try:
        return datetime.fromisoformat(val.replace("Z", "+00:00"))
    except Exception:
        return None


@router.post('/ci_analysis')
async def ci_analysis(data: CIAnalysis = Body(...), db: AsyncSession = Depends(get_db)):
    stmt = select(CIRun).where(CIRun.github_id == str(data.run_id))
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()

    ts_created = _parse_ts(data.created_at)
    ts_updated = _parse_ts(data.updated_at)

    if run:
        run.analysis_results = data.analysis
        run.conclusion = data.conclusion or ""
        if data.head_sha:
            run.head_sha = data.head_sha
        if data.event:
            run.event = data.event
        if data.head_branch:
            run.head_branch = data.head_branch
        if ts_created and run.created_at is None:
            run.created_at = ts_created
        if ts_updated:
            run.updated_at = ts_updated
        await db.commit()
    else:
        import uuid
        new_run = CIRun(
            github_id=str(data.run_id),
            repo_id=data.repo_id,
            name=data.name or "CI",
            head_sha=data.head_sha or "",
            head_branch=data.head_branch,
            event=data.event,
            conclusion=data.conclusion or "",
            status="completed",
            analysis_results=data.analysis,
            created_at=ts_created,
            updated_at=ts_updated,
        )
        db.add(new_run)
        await db.commit()

    return {'status': 'saved'}
