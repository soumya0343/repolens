from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
import httpx
import jwt
import os

from database import get_db
from models import User, Repo, UserRepo
from worker_pool import get_redis_pool

router = APIRouter(prefix="/repos", tags=["repos"])
JWT_SECRET = os.getenv("JWT_SECRET", "super_secret_jwt_key")

async def get_current_user(authorization: str = Header(None), db: AsyncSession = Depends(get_db)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid token")
    
    token = authorization.split(" ")[1]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
        user_id = payload.get("sub")
        if not user_id:
            raise HTTPException(status_code=401, detail="Invalid token payload")
        
        result = await db.execute(select(User).where(User.id == user_id))
        user = result.scalars().first()
        if not user:
            raise HTTPException(status_code=404, detail="User not found")
        return user
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Invalid token")

@router.get("/github/available")
async def get_available_github_repos(user: User = Depends(get_current_user)):
    """Fetch repositories the user has access to on GitHub"""
    
    if user.github_token == "mock_github_token":
        # Return mock data for local development if auth flow was mocked
        return [
            {"id": 101, "name": "frontend-monorepo", "owner": {"login": "acme-corp"}, "private": True},
            {"id": 102, "name": "payment-service", "owner": {"login": "acme-corp"}, "private": True},
            {"id": 103, "name": "repolens-demo", "owner": {"login": user.login}, "private": False}
        ]

    async with httpx.AsyncClient() as client:
        response = await client.get(
            "https://api.github.com/user/repos?sort=updated&per_page=100",
            headers={
                "Authorization": f"Bearer {user.github_token}",
                "Accept": "application/vnd.github.v3+json"
            }
        )
        if response.status_code != 200:
            raise HTTPException(status_code=response.status_code, detail="Failed to fetch repos from GitHub")
        return response.json()

@router.post("/")
async def connect_repository(payload: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Connect a new repository and trigger backfill"""
    github_id = str(payload.get("github_id"))
    owner = payload.get("owner")
    name = payload.get("name")
    default_branch = payload.get("default_branch", "main")
    
    if not github_id or not owner or not name:
        raise HTTPException(status_code=400, detail="Missing repository details")

    # Check if repo exists globally
    result = await db.execute(select(Repo).where(Repo.github_id == github_id))
    repo = result.scalars().first()

    if not repo:
        repo = Repo(
            github_id=github_id,
            owner=owner,
            name=name,
            default_branch=default_branch,
            config={"weights": {"coupling": 1.0, "arch": 1.0, "congruence": 1.0}}
        )
        db.add(repo)
        await db.commit()
        await db.refresh(repo)

    # Link repo to user
    link_result = await db.execute(select(UserRepo).where(UserRepo.user_id == user.id, UserRepo.repo_id == repo.id))
    link = link_result.scalars().first()
    
    if not link:
        link = UserRepo(user_id=user.id, repo_id=repo.id, role="admin")
        db.add(link)
        await db.commit()

    # Dispatch ARQ job to start the backfill worker
    redis_pool = await get_redis_pool()
    await redis_pool.enqueue_job('run_backfill_job', str(repo.id), user.github_token)
    
    # Also dispatch CI logs backfill
    await redis_pool.enqueue_job('run_ci_backfill', str(repo.id), repo.owner, repo.name, user.github_token)
    
    # Finally, dispatch Codebase Snapshot
    await redis_pool.enqueue_job('run_arch_snapshot', str(repo.id), repo.owner, repo.name, user.github_token, repo.default_branch)

    return {"status": "syncing", "repo_id": str(repo.id), "message": "Backfill job enqueued"}

@router.get("/")
async def list_connected_repos(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """List already connected repos for the user"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(UserRepo.user_id == user.id)
    )
    repos = result.scalars().all()
    return [{"id": str(r.id), "name": r.name, "owner": r.owner, "synced_at": r.synced_at} for r in repos]
