from fastapi import APIRouter, Depends, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from database import get_db
from models import CIRun
from pydantic import BaseModel
from typing import Dict, Any

router = APIRouter(prefix='/internal', tags=['internal'])

class CIAnalysis(BaseModel):
    run_id: int
    analysis: Dict[str, Any]

@router.post('/ci_analysis')
async def ci_analysis(data: CIAnalysis = Body(...), db: AsyncSession = Depends(get_db)):
    stmt = select(CIRun).where(CIRun.github_id == str(data.run_id))
    result = await db.execute(stmt)
    run = result.scalar_one_or_none()
    if run:
        run.analysis_results = data.analysis
        await db.commit()
    return {'status': 'saved'}
