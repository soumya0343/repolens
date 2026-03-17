from fastapi import APIRouter, Depends, Body
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from database import get_db
from models import ArchAnalysis
from pydantic import BaseModel
import uuid
from typing import Dict, Any

router = APIRouter(prefix='/internal', tags=['internal'])

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
