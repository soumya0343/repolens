from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import desc
import jwt
import os

from database import get_db
from models import User, Repo, UserRepo, PullRequest, PRComment, Commit, CommitFile

from llm_explainer import get_llm_explainer
from risk_scorer import get_unified_risk_scorer

router = APIRouter(prefix="/prs", tags=["pull-requests"])

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

@router.get("/")
async def list_pull_requests(
    repo_id: str = None,
    state: str = "all",  # open, closed, merged, all
    limit: int = 50,
    offset: int = 0,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """List pull requests, optionally filtered by repository"""
    query = select(PullRequest)

    # If repo_id is provided, verify user has access and filter by repo
    if repo_id:
        # Verify user has access to this repo
        repo_result = await db.execute(
            select(Repo).join(UserRepo).where(
                Repo.id == repo_id,
                UserRepo.user_id == user.id
            )
        )
        repo = repo_result.scalars().first()
        if not repo:
            raise HTTPException(status_code=404, detail="Repository not found or access denied")

        query = query.where(PullRequest.repo_id == repo_id)

    # Filter by state
    if state != "all":
        if state == "merged":
            query = query.where(PullRequest.state == "MERGED")
        else:
            query = query.where(PullRequest.state == state.upper())

    # Apply pagination
    query = query.limit(limit).offset(offset)

    result = await db.execute(query)
    prs = result.scalars().all()

    return [
        {
            "id": str(pr.id),
            "github_id": pr.github_id,
            "number": pr.number,
            "title": pr.title,
            "state": pr.state,
            "author_login": pr.author_login,
            "created_at": pr.created_at,
            "closed_at": pr.closed_at,
            "merged_at": pr.merged_at,
            "predicted_risk_score": pr.predicted_risk_score,
            "repo_id": str(pr.repo_id) if pr.repo_id else None
        }
        for pr in prs
    ]

@router.get("/{pr_id}")
async def get_pull_request_details(
    pr_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get detailed information about a specific pull request"""
    # Get PR and verify user has access to the repo
    result = await db.execute(
        select(PullRequest, Repo)
        .join(Repo, PullRequest.repo_id == Repo.id)
        .join(UserRepo, Repo.id == UserRepo.repo_id)
        .where(
            PullRequest.id == pr_id,
            UserRepo.user_id == user.id
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Pull request not found or access denied")

    pr, repo = row

    # Get comments for this PR
    comments_result = await db.execute(
        select(PRComment).where(PRComment.pr_id == pr_id)
    )
    comments = comments_result.scalars().all()

    return {
        "id": str(pr.id),
        "github_id": pr.github_id,
        "number": pr.number,
        "title": pr.title,
        "state": pr.state,
        "author_login": pr.author_login,
        "created_at": pr.created_at,
        "closed_at": pr.closed_at,
        "merged_at": pr.merged_at,
        "predicted_risk_score": pr.predicted_risk_score,
        "explanation": pr.explanation,
        "repo": {
            "id": str(repo.id),
            "name": repo.name,
            "owner": repo.owner
        },
        "comments": [
            {
                "id": str(comment.id),
                "author_login": comment.author_login,
                "body": comment.body,
                "created_at": comment.created_at
            }
            for comment in comments
        ]
    }


@router.post("/{pr_id}/explain")
async def explain_pr_risk(
    pr_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db)
):
    """Get LLM explanation for PR risk"""
    # Verify access
    result = await db.execute(
        select(PullRequest, Repo)
        .join(Repo, PullRequest.repo_id == Repo.id)
        .join(UserRepo, Repo.id == UserRepo.repo_id)
        .where(
            PullRequest.id == pr_id,
            UserRepo.user_id == user.id
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=404, detail="Pull request not found or access denied")

    pr, repo = row

    # Get real risk data from the unified scorer
    scorer = await get_unified_risk_scorer(db)
    risk_result = await scorer.calculate_repo_risk(str(pr.repo_id))
    breakdown = risk_result.get("breakdown", {})
    risk_data = {
        "coupling":      breakdown.get("coupling", 0) / 100,
        "architecture":  breakdown.get("architecture", 0) / 100,
        "bus_factor":    breakdown.get("bus_factor", 0) / 100,
        "ci":            breakdown.get("ci", 0) / 100,
        "collaboration": breakdown.get("collaboration", 0) / 100,
    }

    # Get real files changed in recent commits for this repo
    files_result = await db.execute(
        select(CommitFile.file_path)
        .join(Commit, Commit.id == CommitFile.commit_id)
        .where(Commit.repo_id == pr.repo_id)
        .order_by(desc(Commit.committed_date))
        .limit(50)
    )
    files = list(dict.fromkeys(row[0] for row in files_result.all()))[:10]
    pr_details = {"title": pr.title, "files": files}

    explainer = await get_llm_explainer()
    explanation = await explainer.explain_risk(repo.name, pr_details, risk_data)

    # Save explanation to DB
    pr.explanation = explanation
    await db.commit()

    return explanation
