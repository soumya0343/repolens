from fastapi import APIRouter, Depends, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from database import get_db
from models import CIRun
from pydantic import BaseModel
from typing import Dict, Any, Optional

router = APIRouter(prefix='/internal', tags=['internal'])

class CIAnalysis(BaseModel):
    repo_id: str
    run_id: str
    conclusion: Optional[str] = None
    analysis: Dict[str, Any]
    head_sha: Optional[str] = None
    name: Optional[str] = None

@router.post('/ci_analysis')
async def ci_analysis(data: CIAnalysis = Body(...), db: AsyncSession = Depends(get_db)):
    stmt = select(CIRun).where(CIRun.github_id == str(data.run_id))
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()
    
    if run:
        run.analysis_results = data.analysis
        run.conclusion = data.conclusion or ""
        if data.head_sha:
            run.head_sha = data.head_sha
        await db.commit()
    else:
        # Create new record if not exists
        import uuid
        new_run = CIRun(
            github_id=str(data.run_id),
            repo_id=data.repo_id,
            name=data.name or "CI",
            head_sha=data.head_sha or "",
            conclusion=data.conclusion or "",
            status="completed",
            analysis_results=data.analysis
        )
        db.add(new_run)
        await db.commit()
        
    return {'status': 'saved'}
