from fastapi import APIRouter, Depends, HTTPException, Header, BackgroundTasks, Query
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func, text
import httpx
import jwt
import os
import datetime
from collections import defaultdict

from database import get_db
from models import User, Repo, UserRepo, Commit, PullRequest, PRComment, ArchAnalysis, CommitFile, CIRun, RepoScoreSnapshot, SecretFinding
from worker_pool import get_redis_pool, BACKFILL_QUEUE, CI_QUEUE, ARCH_QUEUE
from cochange_oracle import get_cochange_oracle
from churn_analyzer import get_churn_analyzer
from chronos_graph import get_chronos_graph
from release_health import get_release_health_tracker
from risk_scorer import get_unified_risk_scorer
from llm_explainer import get_llm_explainer

router = APIRouter(prefix="/repos", tags=["repos"])
JWT_SECRET = os.getenv("JWT_SECRET", "super_secret_jwt_key")
DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"
SECRET_SEVERITY_RANK = {"critical": 4, "high": 3, "medium": 2, "low": 1}

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


async def _require_repo_access(repo_id: str, user: User, db: AsyncSession) -> Repo:
    result = await db.execute(
        select(Repo).join(UserRepo).where(
            Repo.id == repo_id,
            UserRepo.user_id == user.id,
        )
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found or access denied")
    return repo

@router.get("/github/available")
async def get_available_github_repos(user: User = Depends(get_current_user)):
    """Fetch repositories the user has access to on GitHub"""
    
    if DEV_MODE and user.github_token == "mock_github_token":
        # Return mock data only in DEV_MODE
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

async def _fetch_default_branch(token: str, owner: str, name: str) -> str:
    """Fetch current default branch from GitHub — do not trust frontend payload."""
    import httpx as _httpx
    async with _httpx.AsyncClient() as client:
        resp = await client.get(
            f"https://api.github.com/repos/{owner}/{name}",
            headers={"Authorization": f"Bearer {token}", "Accept": "application/vnd.github.v3+json"},
            timeout=15.0,
        )
        resp.raise_for_status()
        return resp.json()["default_branch"]


@router.post("/")
async def connect_repository(payload: dict, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Connect a new repository and trigger backfill"""
    github_id = str(payload.get("github_id"))
    owner = payload.get("owner")
    name = payload.get("name")

    if not github_id or not owner or not name:
        raise HTTPException(status_code=400, detail="Missing repository details")

    # Validate default_branch server-side — do not trust frontend payload
    try:
        default_branch = await _fetch_default_branch(user.github_token, owner, name)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Unable to verify repository with GitHub: {e}")

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
    repo = await _require_repo_access(repo_id, user, db)

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
        select(Repo.id, Repo.name, Repo.owner, Repo.synced_at)
        .join(UserRepo, UserRepo.repo_id == Repo.id)
        .where(UserRepo.user_id == user.id)
        .order_by(Repo.created_at.desc())
    )
    return [
        {"id": str(row.id), "name": row.name, "owner": row.owner, "synced_at": row.synced_at}
        for row in result.all()
    ]

@router.get("/{repo_id}")
async def get_repo_details(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get detailed information about a specific repository"""
    repo = await _require_repo_access(repo_id, user, db)

    # Get basic stats
    counts_result = await db.execute(
        select(
            select(func.count(Commit.id)).where(Commit.repo_id == repo_id).scalar_subquery().label("commit_count"),
            select(func.count(PullRequest.id)).where(PullRequest.repo_id == repo_id).scalar_subquery().label("pr_count"),
        )
    )
    counts = counts_result.one()

    return {
        "id": str(repo.id),
        "name": repo.name,
        "owner": repo.owner,
        "github_id": repo.github_id,
        "default_branch": repo.default_branch,
        "synced_at": repo.synced_at,
        "config": repo.config or {},
        "stats": {
            "commits": counts.commit_count,
            "pull_requests": counts.pr_count
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
    repo = await _require_repo_access(repo_id, user, db)

    config = dict(repo.config or {})
    config.update(payload.get("config", {}))
    repo.config = config
    await db.commit()
    return {"status": "updated", "config": repo.config}


def _serialize_secret_finding(finding: SecretFinding) -> dict:
    return {
        "id": str(finding.id),
        "source": finding.source,
        "pr_number": finding.pr_number,
        "commit_sha": finding.commit_sha,
        "file_path": finding.file_path,
        "line_number": finding.line_number,
        "detector": finding.detector,
        "severity": finding.severity,
        "confidence": finding.confidence,
        "masked_value": finding.masked_value,
        "fingerprint_hash": finding.fingerprint_hash,
        "status": finding.status,
        "message": finding.message,
        "first_seen_at": finding.first_seen_at,
        "last_seen_at": finding.last_seen_at,
        "resolved_at": finding.resolved_at,
    }


@router.get("/{repo_id}/secrets")
async def get_repo_secrets(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """List masked secret findings for a repository."""
    await _require_repo_access(repo_id, user, db)

    findings_result = await db.execute(
        select(SecretFinding)
        .where(SecretFinding.repo_id == repo_id)
        .order_by(SecretFinding.status.asc(), SecretFinding.last_seen_at.desc())
    )
    findings = findings_result.scalars().all()
    return [_serialize_secret_finding(f) for f in findings]


@router.patch("/{repo_id}/secrets/{finding_id}")
async def update_secret_finding(
    repo_id: str,
    finding_id: str,
    payload: dict,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update secret finding status without exposing raw secret values."""
    await _require_repo_access(repo_id, user, db)

    status = payload.get("status")
    allowed = {"active", "resolved", "false_positive", "accepted_risk"}
    if status not in allowed:
        raise HTTPException(status_code=400, detail=f"Invalid status. Use one of: {', '.join(sorted(allowed))}")

    finding = await db.get(SecretFinding, finding_id)
    if not finding or str(finding.repo_id) != repo_id:
        raise HTTPException(status_code=404, detail="Secret finding not found")

    finding.status = status
    finding.resolved_at = datetime.datetime.now(datetime.timezone.utc) if status == "resolved" else None
    await db.commit()
    await db.refresh(finding)
    return _serialize_secret_finding(finding)


@router.get("/{repo_id}/files")
async def get_repo_files(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get files in a repository with their risk scores"""
    await _require_repo_access(repo_id, user, db)

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

    if not file_rows:
        return []

    max_changes = max(row[1] for row in file_rows) or 1

    # Load arch violations once → dict keyed by file path
    violations_by_file: dict = defaultdict(list)
    try:
        arch_result = await db.execute(
            select(ArchAnalysis).where(ArchAnalysis.repo_id == repo_id)
            .order_by(ArchAnalysis.parsed_at.desc()).limit(1)
        )
        arch = arch_result.scalar_one_or_none()
        for v in (arch.violations or [] if arch else []):
            fpath = v.get("file") or v.get("source_file") or ""
            if fpath:
                violations_by_file[fpath].append(v)
    except Exception:
        pass

    # Load per-file bus-factor HHI once → dict keyed by file path
    hhi_by_file: dict = {}
    try:
        churn_a = await get_churn_analyzer(db)
        churn_data = await churn_a.analyze_repository(repo_id)
        for fo in churn_data.get("file_ownership", []):
            hhi_by_file[fo["file_path"]] = fo.get("bus_factor_hhi", 0.0)
    except Exception:
        pass

    # Load coupling scores once → dict keyed by file path (max coupling score)
    coupling_by_file: dict = {}
    try:
        oracle = await get_cochange_oracle(db)
        coupling_data = await oracle.analyze_repository(repo_id)
        for lnk in coupling_data.get("links", []):
            src, tgt, val = lnk.get("source", ""), lnk.get("target", ""), lnk.get("value", 0)
            coupling_by_file[src] = max(coupling_by_file.get(src, 0), val)
            coupling_by_file[tgt] = max(coupling_by_file.get(tgt, 0), val)
    except Exception:
        pass

    # Load active secret findings once → dict keyed by file path
    secrets_by_file: dict = defaultdict(list)
    try:
        secret_result = await db.execute(
            select(SecretFinding).where(
                SecretFinding.repo_id == repo_id,
                SecretFinding.status == "active",
            )
        )
        for finding in secret_result.scalars().all():
            secrets_by_file[finding.file_path].append(finding)
    except Exception:
        pass

    files = []
    for row in file_rows:
        file_path = row[0]
        change_count = row[1]
        additions = row[2] or 0
        deletions = row[3] or 0

        # Risk = blend of churn (35pts) + bus-factor HHI (35pts) + violations (30pts)
        churn_score = (change_count / max_changes) * 35
        hhi_score = hhi_by_file.get(file_path, 0.0) * 35
        violation_count = len(violations_by_file.get(file_path, []))
        violation_score = min(violation_count * 10, 30)
        file_secrets = secrets_by_file.get(file_path, [])
        secret_count = len(file_secrets)
        highest_secret_severity = None
        if file_secrets:
            highest_secret_severity = max(
                (f.severity for f in file_secrets),
                key=lambda s: SECRET_SEVERITY_RANK.get(s, 0),
            )
        # Coupling adds up to 10 bonus points on top
        coupling_bonus = coupling_by_file.get(file_path, 0.0) * 10
        secret_bonus = min(secret_count * 25, 50)
        risk = min(round(churn_score + hhi_score + violation_score + coupling_bonus + secret_bonus), 100)

        files.append({
            "path": file_path,
            "language": get_language_from_extension(file_path),
            "lines": additions + deletions,
            "risk_score": risk,
            "changes": change_count,
            "additions": additions,
            "deletions": deletions,
            "violations": violations_by_file.get(file_path, []),
            "secret_count": secret_count,
            "highest_secret_severity": highest_secret_severity,
        })

    return files[:50]

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
    await _require_repo_access(repo_id, user, db)

    try:
        oracle = await get_cochange_oracle(db)
        return await oracle.analyze_repository(repo_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Coupling analysis failed: {e}")

@router.get("/{repo_id}/violations")
async def get_repo_violations(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get architectural violations for the repository"""
    await _require_repo_access(repo_id, user, db)

    # Try to get violations from ArchAnalysis table
    arch_result = await db.execute(
        select(ArchAnalysis)
        .where(ArchAnalysis.repo_id == repo_id)
        .order_by(ArchAnalysis.parsed_at.desc())
        .limit(1)
    )
    arch_analysis = arch_result.scalars().first()
    
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


async def _save_score_snapshot(repo_id: str, risk: dict):
    """Background task: save a score snapshot if none recorded in the last 6 hours."""
    from database import AsyncSessionLocal
    try:
        async with AsyncSessionLocal() as session:
            cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=6)
            recent = await session.execute(
                select(RepoScoreSnapshot)
                .where(RepoScoreSnapshot.repo_id == repo_id, RepoScoreSnapshot.recorded_at >= cutoff)
                .limit(1)
            )
            if recent.scalars().first():
                return
            snapshot = RepoScoreSnapshot(
                repo_id=repo_id,
                score=risk.get("score", 0),
                label=risk.get("label", "unknown"),
                breakdown=risk.get("breakdown"),
            )
            session.add(snapshot)
            await session.commit()
    except Exception:
        pass  # Never fail the main request due to snapshot errors


@router.get("/{repo_id}/risk")
async def get_repo_risk(
    repo_id: str,
    background_tasks: BackgroundTasks,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Unified risk score aggregated from all engines"""
    repo = await _require_repo_access(repo_id, user, db)

    config = repo.config or {}
    weights = config.get("weights_normalized")  # None = use defaults

    scorer = await get_unified_risk_scorer(db)
    risk = await scorer.calculate_repo_risk(repo_id, weights)
    risk["config"] = config
    background_tasks.add_task(_save_score_snapshot, repo_id, risk)
    return risk


@router.get("/{repo_id}/releases")
async def get_repo_releases(
    repo_id: str,
    days: int = 30,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """DORA metrics for the repository"""
    await _require_repo_access(repo_id, user, db)

    try:
        tracker = await get_release_health_tracker(db)
        return await tracker.get_dora_metrics(repo_id, days)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"DORA metrics failed: {e}")


@router.get("/{repo_id}/ci/stats")
async def get_ci_stats(
    repo_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Latest CI run summary for the CI dashboard."""
    repo = await _require_repo_access(repo_id, user, db)

    latest_result = await db.execute(
        select(CIRun)
        .where(CIRun.repo_id == repo_id)
        .order_by(CIRun.created_at.desc())
        .limit(1)
    )
    latest = latest_result.scalars().first()
    if not latest:
        return {
            "pipeline_status": "unknown",
            "total_duration_seconds": None,
            "test_coverage": None,
            "coverage_delta": None,
            "unit_tests_passed": 0,
            "unit_tests_total": 0,
            "unit_duration_seconds": None,
            "unit_flaky_count": 0,
            "integration_tests_passed": 0,
            "integration_tests_total": 0,
            "integration_duration_seconds": None,
            "integration_failures": 0,
            "branch": repo.default_branch,
            "head_sha": "",
            "run_started_at": None,
            "job_log": [],
        }

    analysis = latest.analysis_results or {}
    clusters = analysis.get("clusters") or []
    job_log = [
        f"{cluster.get('count', 0)}x {cluster.get('template', '')}"
        for cluster in clusters[:20]
        if cluster.get("template")
    ]

    return {
        "pipeline_status": latest.conclusion or latest.status or "unknown",
        "total_duration_seconds": analysis.get("total_duration_seconds"),
        "test_coverage": analysis.get("test_coverage"),
        "coverage_delta": analysis.get("coverage_delta"),
        "unit_tests_passed": analysis.get("unit_tests_passed", 0),
        "unit_tests_total": analysis.get("unit_tests_total", 0),
        "unit_duration_seconds": analysis.get("unit_duration_seconds"),
        "unit_flaky_count": analysis.get("unit_flaky_count", 0),
        "integration_tests_passed": analysis.get("integration_tests_passed", 0),
        "integration_tests_total": analysis.get("integration_tests_total", 0),
        "integration_duration_seconds": analysis.get("integration_duration_seconds"),
        "integration_failures": analysis.get("integration_failures", 0),
        "branch": latest.head_branch or repo.default_branch,
        "head_sha": latest.head_sha or "",
        "run_started_at": latest.created_at.isoformat() if latest.created_at else None,
        "job_log": job_log,
    }


@router.get("/{repo_id}/tests/flaky")
async def get_flaky_tests(
    repo_id: str,
    limit: int = 20,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """CI runs ranked by flakiness probability from TestPulse analysis"""
    await _require_repo_access(repo_id, user, db)

    try:
        from test_pulse import get_test_pulse
        pulse = await get_test_pulse(db=db)
        flaky_workflows = await pulse.analyze_flakiness(repo_id)
        return flaky_workflows[:limit]
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Flaky test analysis failed: {e}")


@router.get("/{repo_id}/team/bus-factor")
async def get_bus_factor(
    repo_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Bus factor and code ownership analysis"""
    await _require_repo_access(repo_id, user, db)

    try:
        churn_a = await get_churn_analyzer(db)
        return await churn_a.analyze_repository(repo_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Bus factor analysis failed: {e}")


@router.get("/{repo_id}/team/graph")
async def get_team_graph(
    repo_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Social graph nodes and edges for D3.js visualization"""
    await _require_repo_access(repo_id, user, db)

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

    nodes = [{"id": d[0], "commit_count": d[1]} for d in devs]
    edges = [{"source": i[0], "target": i[1], "weight": i[2]} for i in interactions]

    # Compute betweenness centrality (Brandes' algorithm, pure Python)
    node_ids = [n["id"] for n in nodes]
    adj: dict = defaultdict(set)
    for e in edges:
        adj[e["source"]].add(e["target"])
        adj[e["target"]].add(e["source"])

    betweenness: dict = {n: 0.0 for n in node_ids}
    for s in node_ids:
        stack, pred, sigma, dist = [], defaultdict(list), defaultdict(float), {s: 0}
        sigma[s] = 1.0
        queue = [s]
        while queue:
            v = queue.pop(0)
            stack.append(v)
            for w in adj.get(v, []):
                if w not in dist:
                    dist[w] = dist[v] + 1
                    queue.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    pred[w].append(v)
        delta: dict = defaultdict(float)
        while stack:
            w = stack.pop()
            for v in pred[w]:
                if sigma[w]:
                    delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
            if w != s:
                betweenness[w] += delta[w]

    # Normalize to 0-1
    max_b = max(betweenness.values(), default=1) or 1
    for n in nodes:
        n["betweenness"] = round(betweenness.get(n["id"], 0) / max_b, 4)

    return {"nodes": nodes, "edges": edges}


@router.post("/{repo_id}/graph/build")
async def build_repo_graph(repo_id: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Build the multi-layer graph for a repository in Neo4j"""
    await _require_repo_access(repo_id, user, db)

    # Build the graph
    chronos = await get_chronos_graph(db)
    stats = await chronos.build_graph(repo_id)
    
    return {"status": "built", "stats": stats}


@router.get("/{repo_id}/graph/stmc")
async def get_stmc_score(repo_id: str, file1: str, file2: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get STMC coupling score between two files"""
    await _require_repo_access(repo_id, user, db)

    chronos = await get_chronos_graph(db)
    score = await chronos.get_stmc_score(repo_id, file1, file2)
    
    return {"file1": file1, "file2": file2, "stmc_score": score}


@router.get("/{repo_id}/reviewers/suggest")
async def suggest_reviewers(repo_id: str, pr_id: str = None, exclude: str = None, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Suggest reviewers for a PR based on expertise"""
    await _require_repo_access(repo_id, user, db)

    exclude_list = exclude.split(",") if exclude else []
    
    chronos = await get_chronos_graph(db)
    suggestions = await chronos.suggest_reviewers(repo_id, pr_id, exclude_list)
    
    return {"suggestions": suggestions}


@router.get("/{repo_id}/developer/{login}/expertise")
async def get_developer_expertise(repo_id: str, login: str, user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)):
    """Get expertise profile for a developer"""
    await _require_repo_access(repo_id, user, db)

    chronos = await get_chronos_graph(db)
    expertise = await chronos.get_developer_expertise(repo_id, login)

    return expertise


# ── Score History ─────────────────────────────────────────────────────────────

@router.get("/{repo_id}/score/history")
async def get_score_history(
    repo_id: str,
    days: int = Query(default=30, ge=1, le=365),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """30-day risk score history for the overview sparkline"""
    await _require_repo_access(repo_id, user, db)

    cutoff = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=days)
    rows = await db.execute(
        select(RepoScoreSnapshot)
        .where(RepoScoreSnapshot.repo_id == repo_id, RepoScoreSnapshot.recorded_at >= cutoff)
        .order_by(RepoScoreSnapshot.recorded_at.asc())
    )
    return [
        {"recorded_at": r.recorded_at.isoformat(), "score": r.score, "label": r.label}
        for r in rows.scalars().all()
    ]


# ── File Detail ───────────────────────────────────────────────────────────────

@router.get("/{repo_id}/files/detail")
async def get_file_detail(
    repo_id: str,
    path: str = Query(..., description="File path relative to repo root"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Detailed metrics for a single file: churn history, ownership, coupling rules, violations"""
    await _require_repo_access(repo_id, user, db)

    # Churn history — weekly buckets for last 90 days
    cutoff_90 = datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=90)
    churn_rows = await db.execute(
        select(
            func.date_trunc("week", Commit.committed_date).label("week"),
            func.sum(CommitFile.additions).label("additions"),
            func.sum(CommitFile.deletions).label("deletions"),
        )
        .join(Commit, Commit.id == CommitFile.commit_id)
        .where(
            Commit.repo_id == repo_id,
            CommitFile.file_path == path,
            Commit.committed_date >= cutoff_90,
        )
        .group_by(text("week"))
        .order_by(text("week"))
    )
    churn_history = [
        {"week": str(r.week)[:10], "additions": int(r.additions or 0), "deletions": int(r.deletions or 0)}
        for r in churn_rows.all()
    ]

    # Ownership — per-developer commit share for this file
    owner_rows = await db.execute(
        select(
            Commit.author_login,
            func.count(CommitFile.id).label("commits"),
        )
        .join(Commit, Commit.id == CommitFile.commit_id)
        .where(
            Commit.repo_id == repo_id,
            CommitFile.file_path == path,
            Commit.author_login.isnot(None),
        )
        .group_by(Commit.author_login)
        .order_by(func.count(CommitFile.id).desc())
    )
    owner_data = owner_rows.all()
    total_commits = sum(r.commits for r in owner_data) or 1
    ownership = [
        {"contributor": r.author_login, "commits": r.commits, "share": round(r.commits / total_commits, 4)}
        for r in owner_data
    ]

    # Coupling rules — files that co-change with this file
    try:
        oracle = await get_cochange_oracle(db)
        coupling_result = await oracle.analyze_repository(repo_id)
        all_links = coupling_result.get("links", [])
        coupling_rules = [
            {"file": lnk["target"] if lnk["source"] == path else lnk["source"], "score": lnk.get("value", 0)}
            for lnk in all_links
            if lnk.get("source") == path or lnk.get("target") == path
        ]
        coupling_rules.sort(key=lambda x: x["score"], reverse=True)
    except Exception:
        coupling_rules = []

    # Violations for this file from the latest arch analysis
    arch_result = await db.execute(
        select(ArchAnalysis)
        .where(ArchAnalysis.repo_id == repo_id)
        .order_by(ArchAnalysis.parsed_at.desc())
        .limit(1)
    )
    arch = arch_result.scalars().first()
    all_violations = (arch.violations or []) if arch else []
    violations = [
        v for v in all_violations
        if v.get("file") == path or v.get("source_file") == path
    ]

    return {
        "path": path,
        "churn_history": churn_history,
        "ownership": ownership,
        "coupling_rules": coupling_rules,
        "violations": violations,
    }


# ── Policy Generator ──────────────────────────────────────────────────────────

@router.post("/{repo_id}/policy/generate")
async def generate_arch_policy_endpoint(
    repo_id: str,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Auto-generate an architectural policy from violations and repo structure"""
    await _require_repo_access(repo_id, user, db)

    arch_result = await db.execute(
        select(ArchAnalysis)
        .where(ArchAnalysis.repo_id == repo_id)
        .order_by(ArchAnalysis.parsed_at.desc())
        .limit(1)
    )
    arch = arch_result.scalars().first()
    violations = (arch.violations or []) if arch else []

    explainer = await get_llm_explainer()
    policy = await explainer.generate_arch_policy(repo_stats={}, violations=violations)
    return {"policy": policy}


@router.get("/{repo_id}/arch/suggest")
async def suggest_refactoring(
    repo_id: str,
    file: str = "",
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Suggest concrete refactoring steps for architectural violations in a file."""
    await _require_repo_access(repo_id, user, db)

    arch_result = await db.execute(
        select(ArchAnalysis)
        .where(ArchAnalysis.repo_id == repo_id)
        .order_by(ArchAnalysis.parsed_at.desc())
        .limit(1)
    )
    arch = arch_result.scalars().first()
    all_violations = (arch.violations or []) if arch else []

    if file:
        violations = [v for v in all_violations if v.get("file", "") == file]
    else:
        violations = all_violations

    if not violations:
        return {"suggestions": {}, "detail": "No violations found for the specified file."}

    # Pass file_content from the first matched violation (stored by arch-worker)
    file_content = violations[0].get("file_content", "") if violations else ""
    issues = [{k: v for k, v in v.items() if k != "file_content"} for v in violations]

    explainer = await get_llm_explainer()
    suggestions = await explainer.suggest_refactoring(issues=issues, file_content=file_content)
    return {"suggestions": suggestions, "violation_count": len(violations)}
