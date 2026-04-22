import os
import fnmatch
import datetime
from fastapi import APIRouter, Depends, Body, HTTPException, Header
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select
from sqlalchemy import func
from database import get_db
from models import ArchAnalysis, Repo, SecretFinding, UserRepo
from pydantic import BaseModel
import uuid
from typing import Dict, Any, List, Optional
from secret_scanner import scan_text

router = APIRouter(prefix='/internal', tags=['internal'])

INTERNAL_API_KEY = os.getenv("REPOLENS_API_KEY", "internal_key")

def _verify_internal(x_internal_key: str = Header(None)):
    if x_internal_key != INTERNAL_API_KEY:
        raise HTTPException(status_code=403, detail="Forbidden")
    return True

class ArchData(BaseModel):
    repo_id: str
    data: Dict[str, Any]


class BaselineFile(BaseModel):
    path: str
    content: str


class BaselineScanData(BaseModel):
    repo_id: str
    files: List[BaselineFile]


class PatchFile(BaseModel):
    path: str
    patch: str


class PRScanData(BaseModel):
    repo_id: str
    pr_number: int
    commit_sha: Optional[str] = None
    files: List[PatchFile]


async def _save_secret_findings(
    db: AsyncSession,
    repo_id: uuid.UUID,
    source: str,
    findings: List[Dict[str, Any]],
    pr_number: Optional[int] = None,
    commit_sha: Optional[str] = None,
    resolve_missing: bool = False,
) -> Dict[str, int]:
    created = 0
    updated = 0
    current_fingerprints = {finding["fingerprint_hash"] for finding in findings}

    for finding in findings:
        stmt = select(SecretFinding).where(
            SecretFinding.repo_id == repo_id,
            SecretFinding.source == source,
            SecretFinding.pr_number == pr_number,
            SecretFinding.fingerprint_hash == finding["fingerprint_hash"],
        )
        result = await db.execute(stmt)
        existing = result.scalar_one_or_none()
        if existing:
            existing.file_path = finding["file_path"]
            existing.line_number = finding["line_number"]
            existing.detector = finding["detector"]
            existing.severity = finding["severity"]
            existing.confidence = finding["confidence"]
            existing.masked_value = finding["masked_value"]
            existing.message = finding["message"]
            existing.commit_sha = commit_sha or existing.commit_sha
            if existing.status == "resolved":
                existing.status = "active"
                existing.resolved_at = None
            updated += 1
        else:
            db.add(SecretFinding(
                repo_id=repo_id,
                source=source,
                pr_number=pr_number,
                commit_sha=commit_sha,
                file_path=finding["file_path"],
                line_number=finding["line_number"],
                detector=finding["detector"],
                severity=finding["severity"],
                confidence=finding["confidence"],
                masked_value=finding["masked_value"],
                fingerprint_hash=finding["fingerprint_hash"],
                status="active",
                message=finding["message"],
            ))
            created += 1

    resolved = 0
    if resolve_missing:
        stmt = select(SecretFinding).where(
            SecretFinding.repo_id == repo_id,
            SecretFinding.source == source,
            SecretFinding.pr_number == pr_number,
            SecretFinding.status == "active",
        )
        result = await db.execute(stmt)
        for existing in result.scalars().all():
            if existing.fingerprint_hash not in current_fingerprints:
                existing.status = "resolved"
                existing.resolved_at = datetime.datetime.now(datetime.timezone.utc)
                resolved += 1

    await db.commit()
    return {"created": created, "updated": updated, "resolved": resolved}


def _filter_allowed_findings(repo: Repo, findings: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    config = repo.config or {}
    allowlist = config.get("secret_allowlist") or {}
    fingerprints = set(allowlist.get("fingerprints") or [])
    detectors = set(allowlist.get("detectors") or [])
    path_globs = allowlist.get("path_globs") or []

    filtered = []
    for finding in findings:
        if finding["fingerprint_hash"] in fingerprints:
            continue
        if finding["detector"] in detectors:
            continue
        if any(fnmatch.fnmatch(finding["file_path"], pattern) for pattern in path_globs):
            continue
        filtered.append(finding)
    return filtered

@router.post('/arch_complete', dependencies=[Depends(_verify_internal)])
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


@router.post('/security/baseline_scan', dependencies=[Depends(_verify_internal)])
async def baseline_secret_scan(data: BaselineScanData = Body(...), db: AsyncSession = Depends(get_db)):
    repo_uuid = uuid.UUID(data.repo_id)
    repo = await db.get(Repo, repo_uuid)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    findings: List[Dict[str, Any]] = []
    for file in data.files:
        findings.extend(scan_text(file.path, file.content, mode="baseline"))
    findings = _filter_allowed_findings(repo, findings)

    result = await _save_secret_findings(db, repo_uuid, "baseline", findings)
    return {"status": "saved", "findings": len(findings), **result}


@router.post('/security/pr_scan', dependencies=[Depends(_verify_internal)])
async def pr_secret_scan(data: PRScanData = Body(...), db: AsyncSession = Depends(get_db)):
    repo_uuid = uuid.UUID(data.repo_id)
    repo = await db.get(Repo, repo_uuid)
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    findings: List[Dict[str, Any]] = []
    for file in data.files:
        findings.extend(scan_text(file.path, file.patch, mode="pull_request"))
    findings = _filter_allowed_findings(repo, findings)

    result = await _save_secret_findings(
        db,
        repo_uuid,
        "pull_request",
        findings,
        pr_number=data.pr_number,
        commit_sha=data.commit_sha,
        resolve_missing=True,
    )
    return {"status": "saved", "findings": len(findings), **result}


# ── Bot-facing internal endpoints ──────────────────────────────────────────

@router.get('/repos/lookup', dependencies=[Depends(_verify_internal)])
async def lookup_repo(owner: str, name: str, db: AsyncSession = Depends(get_db)):
    """Find a RepoLens repo by GitHub owner/name — called by the bot."""
    result = await db.execute(
        select(Repo).where(Repo.owner == owner, Repo.name == name)
    )
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not connected to RepoLens")
    return {"id": str(repo.id), "owner": repo.owner, "name": repo.name}


@router.get('/repos/{repo_id}/analysis', dependencies=[Depends(_verify_internal)])
async def get_bot_analysis(repo_id: str, db: AsyncSession = Depends(get_db)):
    """Return full risk analysis for the bot to include in PR comments."""
    from risk_scorer import get_unified_risk_scorer
    from llm_explainer import get_llm_explainer
    from models import Commit, PullRequest

    result = await db.execute(select(Repo).where(Repo.id == repo_id))
    repo = result.scalars().first()
    if not repo:
        raise HTTPException(status_code=404, detail="Repository not found")

    scorer = await get_unified_risk_scorer(db)
    risk = await scorer.calculate_repo_risk(repo_id)

    # Latest merged PR for explanation context
    pr_result = await db.execute(
        select(PullRequest)
        .where(PullRequest.repo_id == repo_id)
        .order_by(PullRequest.created_at.desc())
        .limit(1)
    )
    latest_pr = pr_result.scalars().first()

    explanation = None
    if latest_pr:
        explainer = await get_llm_explainer()
        explanation = await explainer.explain_risk(
            repo_name=f"{repo.owner}/{repo.name}",
            pr_details={"title": latest_pr.title or "", "files": []},
            risk_data={
                "coupling": (risk["breakdown"]["coupling"] / 100) if risk["breakdown"].get("coupling") is not None else None,
                "architecture": (risk["breakdown"]["architecture"] / 100) if risk["breakdown"].get("architecture") is not None else None,
                "bus_factor": (risk["breakdown"]["bus_factor"] / 100) if risk["breakdown"].get("bus_factor") is not None else None,
                "ci": (risk["breakdown"]["ci"] / 100) if risk["breakdown"].get("ci") is not None else None,
                "collaboration": (risk["breakdown"]["collaboration"] / 100) if risk["breakdown"].get("collaboration") is not None else None,
            },
        )

    # Arch violations for inline PR annotations
    arch_result = await db.execute(
        select(ArchAnalysis)
        .where(ArchAnalysis.repo_id == repo_id)
        .order_by(ArchAnalysis.parsed_at.desc())
        .limit(1)
    )
    arch = arch_result.scalars().first()
    violations = (arch.violations or []) if arch else []

    secret_result = await db.execute(
        select(SecretFinding)
        .where(SecretFinding.repo_id == repo_id, SecretFinding.status == "active")
        .order_by(SecretFinding.severity.desc(), SecretFinding.last_seen_at.desc())
        .limit(10)
    )
    secret_findings = secret_result.scalars().all()

    secret_counts_result = await db.execute(
        select(SecretFinding.severity, func.count(SecretFinding.id))
        .where(SecretFinding.repo_id == repo_id, SecretFinding.status == "active")
        .group_by(SecretFinding.severity)
    )
    secret_counts = {row[0]: row[1] for row in secret_counts_result.all()}

    # Bot config from repo settings
    config = repo.config or {}
    bot_config = {
        "block_threshold": config.get("block_threshold", 75),
        "warn_only": config.get("warn_only", False),
    }

    return {
        "risk": risk,
        "explanation": explanation,
        "violations": violations,
        "secrets": {
            "counts": secret_counts,
            "findings": [
                {
                    "id": str(f.id),
                    "file_path": f.file_path,
                    "line_number": f.line_number,
                    "detector": f.detector,
                    "severity": f.severity,
                    "confidence": f.confidence,
                    "masked_value": f.masked_value,
                    "source": f.source,
                    "message": f.message,
                }
                for f in secret_findings
            ],
        },
        "config": bot_config,
    }


@router.post('/build_graph/{repo_id}', dependencies=[Depends(_verify_internal)])
async def trigger_build_graph(repo_id: str, db: AsyncSession = Depends(get_db)):
    """Trigger ChronosGraph build for a repo — called by ingestor worker post-backfill."""
    from chronos_graph import get_chronos_graph
    graph = await get_chronos_graph(db)
    try:
        stats = await graph.build_graph(repo_id)
        return {"status": "built", "stats": stats}
    except Exception as e:
        # Graph build failure must not block the backfill response
        return {"status": "error", "detail": str(e)}


@router.post('/ci_refresh_all', dependencies=[Depends(_verify_internal)])
async def ci_refresh_all(db: AsyncSession = Depends(get_db)):
    """Enqueue CI backfill for every connected repo — called by CI worker cron."""
    from worker_pool import get_redis_pool, CI_QUEUE
    from models import User

    result = await db.execute(
        select(Repo.id, Repo.owner, Repo.name, UserRepo.user_id)
        .join(UserRepo, UserRepo.repo_id == Repo.id)
    )
    rows = result.all()

    # Collect one token per repo (first user with access)
    repo_tokens: dict = {}
    for repo_id, owner, name, user_id in rows:
        key = str(repo_id)
        if key not in repo_tokens:
            repo_tokens[key] = (owner, name, user_id)

    if not repo_tokens:
        return {"enqueued": 0}

    # Fetch tokens for all user_ids in one query
    user_ids = list({v[2] for v in repo_tokens.values()})
    users_result = await db.execute(select(User.id, User.github_token).where(User.id.in_(user_ids)))
    token_map = {str(row[0]): row[1] for row in users_result.all()}

    redis_pool = await get_redis_pool()
    enqueued = 0
    for repo_id_str, (owner, name, user_id) in repo_tokens.items():
        token = token_map.get(str(user_id))
        if not token:
            continue
        await redis_pool.enqueue_job(
            'run_ci_backfill', repo_id_str, owner, name, token,
            _queue_name=CI_QUEUE,
        )
        enqueued += 1

    return {"enqueued": enqueued}


@router.post('/refresh_risk/{repo_id}', dependencies=[Depends(_verify_internal)])
async def refresh_risk_score(repo_id: str, db: AsyncSession = Depends(get_db)):
    """Compute and persist a fresh risk score — called by ingestor after backfill completes."""
    from risk_scorer import get_unified_risk_scorer
    from models import RepoScoreSnapshot
    try:
        scorer = await get_unified_risk_scorer(db)
        risk = await scorer.calculate_repo_risk(repo_id)
        if risk.get("score") is not None:
            db.add(RepoScoreSnapshot(
                repo_id=repo_id,
                score=int(risk["score"]),
                label=risk.get("label", "unknown"),
                breakdown=risk.get("breakdown"),
            ))
            await db.commit()
        return {"status": "ok", "score": risk.get("score"), "label": risk.get("label")}
    except Exception as e:
        return {"status": "error", "detail": str(e)}
