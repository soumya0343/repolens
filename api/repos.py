from fastapi import APIRouter, Depends, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func
import httpx
import jwt
import os

from database import get_db
from models import User, Repo, UserRepo, Commit, PullRequest, PRComment, ArchAnalysis, CommitFile, CIRun
from worker_pool import get_redis_pool, BACKFILL_QUEUE, CI_QUEUE, ARCH_QUEUE
from cochange_oracle import get_cochange_oracle
from churn_analyzer import get_churn_analyzer
from chronos_graph import get_chronos_graph
from release_health import get_release_health_tracker
from risk_scorer import get_unified_risk_scorer

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
    await redis_pool.enqueue_job('run_backfill_job', str(repo.id), user.github_token, _queue_name=BACKFILL_QUEUE)
    
    # Also dispatch CI logs backfill
    await redis_pool.enqueue_job('run_ci_backfill', str(repo.id), repo.owner, repo.name, user.github_token, _queue_name=CI_QUEUE)
    
    # Finally, dispatch Codebase Snapshot
    await redis_pool.enqueue_job('run_arch_snapshot', str(repo.id), repo.owner, repo.name, user.github_token, repo.default_branch, _queue_name=ARCH_QUEUE)

    return {"status": "syncing", "repo_id": str(repo.id), "message": "Backfill job enqueued"}


@router.post("/{repo_id}/backfill")
async def trigger_backfill(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Manual trigger for re-running backfill + dependent jobs"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    redis_pool = await get_redis_pool()
    await redis_pool.enqueue_job('run_backfill_job', repo_id, user.github_token, _queue_name=BACKFILL_QUEUE)
    await redis_pool.enqueue_job('run_ci_backfill', repo_id, repo.owner, repo.name, user.github_token, _queue_name=CI_QUEUE)
    await redis_pool.enqueue_job('run_arch_snapshot', repo_id, repo.owner, repo.name, user.github_token, repo.default_branch, _queue_name=ARCH_QUEUE)

    repo.synced_at = None
    await db.commit()

    return {"status": "enqueued", "repo_id": repo_id, "message": "Backfill job requeued"}

@router.get("/")
async def list_connected_repos(user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """List already connected repos for the user"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(UserRepo.user_id == user.id)
    )
    repos = result.scalars().all()
    return [{"id": str(r.id), "name": r.name, "owner": r.owner, "synced_at": r.synced_at} for r in repos]

@router.get("/{repo_id}")
async def get_repo_details(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get detailed information about a specific repository"""
    # Verify user has access to this repo
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    # Get basic stats
    commit_count = await db.execute(
        select(func.count(Commit.id)).where(Commit.repo_id == repo_id)
    )
    pr_count = await db.execute(
        select(func.count(PullRequest.id)).where(PullRequest.repo_id == repo_id)
    )

    return {
        "id": str(repo.id),
        "name": repo.name,
        "owner": repo.owner,
        "github_id": repo.github_id,
        "default_branch": repo.default_branch,
        "synced_at": repo.synced_at,
        "stats": {
            "commits": commit_count.scalar(),
            "pull_requests": pr_count.scalar()
        }
    }

@router.patch("/{repo_id}")
async def update_repo_config(
    repo_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update repository configuration (e.g. risk weight overrides)"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    config = dict(repo.config or {})
    config.update(payload.get("config", {}))
    repo.config = config
    await db.commit()
    return {"status": "updated", "config": repo.config}


@router.get("/{repo_id}/files")
async def get_repo_files(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get files in a repository with their risk scores"""
    # Verify user has access to this repo
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    # Query actual files from commit_files table
    files_result = await db.execute(
        select(
            CommitFile.file_path,
            func.count(CommitFile.id).label('change_count'),
            func.sum(CommitFile.additions).label('additions'),
            func.sum(CommitFile.deletions).label('deletions')
        )
        .join(Commit, Commit.id == CommitFile.commit_id)
        .where(Commit.repo_id == repo_id)
        .group_by(CommitFile.file_path)
        .order_by(func.count(CommitFile.id).desc())
    )
    
    file_rows = files_result.all()
    
    if file_rows:
        # Build file list from actual data
        files = []
        for row in file_rows:
            file_path = row[0]
            change_count = row[1]
            additions = row[2] or 0
            deletions = row[3] or 0
            
            # Calculate risk score based on change frequency
            # More changes = higher risk (up to 95)
            risk = min(20 + change_count * 5, 95)
            
            files.append({
                "path": file_path,
                "language": get_language_from_extension(file_path),
                "lines": additions + deletions,
                "risk_score": risk,
                "changes": change_count,
                "additions": additions,
                "deletions": deletions,
                "violations": []
            })
    else:
        # Fallback to empty list if no files in DB yet
        files = []
    
    return files[:50]  # Limit to 50 files

def get_language_from_extension(file_path: str) -> str:
    """Map file extension to language"""
    ext = file_path.split('.')[-1] if '.' in file_path else ''
    lang_map = {
        'py': 'python',
        'js': 'javascript',
        'ts': 'typescript',
        'jsx': 'javascript',
        'tsx': 'typescript',
        'go': 'go',
        'java': 'java',
        'rb': 'ruby',
        'rs': 'rust',
    }
    return lang_map.get(ext, 'unknown')

@router.get("/{repo_id}/coupling")
async def get_repo_coupling(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get file coupling analysis for the repository"""
    # Verify user has access to this repo
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    # Get CoChangeOracle instance and analyze
    oracle = await get_cochange_oracle(db)
    coupling_data = await oracle.analyze_repository(repo_id)

    return coupling_data

@router.get("/{repo_id}/violations")
async def get_repo_violations(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get architectural violations for the repository"""
    # Verify user has access to this repo
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    # Try to get violations from ArchAnalysis table
    arch_result = await db.execute(
        select(ArchAnalysis).where(ArchAnalysis.repo_id == repo_id)
    )
    arch_analysis = arch_result.scalar_one_or_none()
    
    if arch_analysis and arch_analysis.violations:
        return arch_analysis.violations
    
    # If no stored violations, return sample
    return [
        {
            "type": "no_analysis",
            "severity": "info",
            "file": "N/A",
            "line": 0,
            "description": "Architecture analysis pending. Run backfill to analyze."
        }
    ]


@router.get("/{repo_id}/risk")
async def get_repo_risk(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Unified risk score aggregated from all engines"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    config = repo.config or {}
    weights = config.get("weights_normalized")  # None = use defaults

    scorer = await get_unified_risk_scorer(db)
    return await scorer.calculate_repo_risk(repo_id, weights)


@router.get("/{repo_id}/releases")
async def get_repo_releases(
    repo_id: str,
    days: int = 30,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """DORA metrics for the repository"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    tracker = await get_release_health_tracker(db)
    return await tracker.get_dora_metrics(repo_id, days)


@router.get("/{repo_id}/tests/flaky")
async def get_flaky_tests(
    repo_id: str,
    limit: int = 20,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """CI runs ranked by flakiness probability from TestPulse analysis"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    # Query CI runs that have been analyzed
    ci_result = await db.execute(
        select(CIRun)
        .where(
            CIRun.repo_id == repo_id,
            CIRun.analysis_results.isnot(None),
        )
        .order_by(CIRun.created_at.desc())
        .limit(200)
    )
    ci_runs = ci_result.scalars().all()

    # Aggregate flakiness signals across runs
    tests = []
    for run in ci_runs:
        ar = run.analysis_results or {}
        tests.append({
            "ci_run_id": str(run.id),
            "run_name": run.name,
            "head_sha": run.head_sha,
            "conclusion": run.conclusion,
            "flakiness_prob": round(ar.get("flakiness_prob", 0.0), 3),
            "total_errors": ar.get("total_errors", 0),
            "failure_signatures": [
                {"template": c.get("template", ""), "count": c.get("count", 0)}
                for c in ar.get("clusters", [])[:3]
            ],
            "created_at": run.created_at,
        })

    # Sort by flakiness probability descending
    tests.sort(key=lambda x: x["flakiness_prob"], reverse=True)
    return tests[:limit]


@router.get("/{repo_id}/team/bus-factor")
async def get_bus_factor(
    repo_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bus factor and code ownership analysis"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    churn_a = await get_churn_analyzer(db)
    return await churn_a.analyze_repository(repo_id)


@router.get("/{repo_id}/team/graph")
async def get_team_graph(
    repo_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Social graph nodes and edges for D3.js visualization"""
    result = await db.execute(
        select(Repo).join(UserRepo).where(Repo.id == repo_id, UserRepo.user_id == user.id)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    # Get developer list from commits
    devs_result = await db.execute(
        select(Commit.author_login, func.count(Commit.id).label("commit_count"))
        .where(Commit.repo_id == repo_id, Commit.author_login.isnot(None))
        .group_by(Commit.author_login)
        .order_by(func.count(Commit.id).desc())
        .limit(30)
    )
    devs = devs_result.all()

    # Get review interactions (edges)
    interactions_result = await db.execute(
        select(PullRequest.author_login, PRComment.author_login, func.count(PRComment.id).label("weight"))
        .join(PRComment, PRComment.pr_id == PullRequest.id)
        .where(PullRequest.repo_id == repo_id)
        .where(PullRequest.author_login.isnot(None))
        .where(PRComment.author_login.isnot(None))
        .where(PullRequest.author_login != PRComment.author_login)
        .group_by(PullRequest.author_login, PRComment.author_login)
    )
    interactions = interactions_result.all()

    nodes = [
        {"id": d[0], "commit_count": d[1]}
        for d in devs
    ]
    edges = [
        {"source": i[0], "target": i[1], "weight": i[2]}
        for i in interactions
    ]

    return {"nodes": nodes, "edges": edges}


@router.post("/{repo_id}/graph/build")
async def build_repo_graph(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Build the multi-layer graph for a repository in Neo4j"""
    # Verify user has access to this repo
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    # Build the graph
    chronos = await get_chronos_graph(db)
    stats = await chronos.build_graph(repo_id)
    
    return {"status": "built", "stats": stats}


@router.get("/{repo_id}/graph/stmc")
async def get_stmc_score(repo_id: str, file1: str, file2: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get STMC coupling score between two files"""
    # Verify user has access
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    chronos = await get_chronos_graph(db)
    score = await chronos.get_stmc_score(repo_id, file1, file2)
    
    return {"file1": file1, "file2": file2, "stmc_score": score}


@router.get("/{repo_id}/reviewers/suggest")
async def suggest_reviewers(repo_id: str, pr_id: str = None, exclude: str = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Suggest reviewers for a PR based on expertise"""
    # Verify user has access
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    exclude_list = exclude.split(",") if exclude else []
    
    chronos = await get_chronos_graph(db)
    suggestions = await chronos.suggest_reviewers(repo_id, pr_id, exclude_list)
    
    return {"suggestions": suggestions}


@router.get("/{repo_id}/developer/{login}/expertise")
async def get_developer_expertise(repo_id: str, login: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get expertise profile for a developer"""
    # Verify user has access
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")

    chronos = await get_chronos_graph(db)
    expertise = await chronos.get_developer_expertise(repo_id, login)
    
    return expertise
