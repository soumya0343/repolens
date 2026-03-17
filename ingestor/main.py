from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import asyncio
from worker import run_backfill_job

app = FastAPI()

class BackfillRequest(BaseModel):
    repo_id: str
    github_token: str

@app.get("/health")
def health_check():
    return {"status": "ok"}

@app.post("/backfill")
async def backfill_repository(request: BackfillRequest):
    """Trigger backfill for a repository"""
    try:
        # Create a mock context for the worker function
        ctx = {}
        result = await run_backfill_job(ctx, request.repo_id, request.github_token)
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
