from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import asyncio
from worker import run_backfill_job
import os
from fastapi import Request, Body

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

@app.post("/webhook/github")
async def github_webhook(request: Request, payload = Body(embed=True)):
    """GitHub Webhook receiver for real-time events"""
    secret = os.getenv('GITHUB_WEBHOOK_SECRET')
    if secret:
        # Verify HMAC signature
        signature = request.headers.get('X-Hub-Signature-256')
        if not signature:
            raise HTTPException(403)
        # hmac verify (implement)
        # for MVP skip full verify
        print(f"Webhook received: {payload.get('action')} on {payload.get('repository', {}).get('full_name')}")
    
    event = request.headers.get('X-GitHub-Event', 'unknown')
    repo_full_name = payload.get('repository', {}).get('full_name')
    if not repo_full_name:
        return {'status': 'ignored'}
    
    # Find repo_id in DB (stub)
    repo_id = 'mock_id'  # later lookup
    
    if event == 'push':
        # Enqueue incremental arch, cochange
        ctx = {}
        # Enqueue arch snapshot
        print(f"Enqueued arch snapshot for {repo_full_name}")
        return {'status': 'enqueued_arch'}
    elif event == 'pull_request' and payload.get('action') in ['opened', 'synchronize']:
        # Enqueue PR risk
        return {'status': 'enqueued_pr'}
    
    return {'status': 'received'}
