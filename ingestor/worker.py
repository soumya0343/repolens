import os
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env'))

import asyncio
import uuid
import httpx
from datetime import datetime, timezone
from arq.connections import RedisSettings
from github_client import fetch_commits_batch, fetch_commit_files, fetch_prs_batch, fetch_repo_default_branch
from database import AsyncSessionLocal
from models import Repo
from sqlalchemy.future import select
from db_writer import bulk_insert_commits, bulk_insert_commit_files, bulk_insert_prs, bulk_insert_pr_files
from models import Commit, CommitFile, PullRequest
from sqlalchemy import update

async def run_backfill_job(ctx, repo_id: str, github_token: str):
    """
    ARQ background task to execute the historical backfill for a repository.
    """
    print(f"Starting backfill for repo: {repo_id}")

    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Repo).where(Repo.id == repo_id))
        repo = result.scalars().first()

        if not repo:
            print(f"Repo {repo_id} not found in DB.")
            return

        owner = repo.owner
        name = repo.name

        # Re-fetch default_branch to detect drift (rename master→main, switch to develop, etc.)
        try:
            current_default_branch = await fetch_repo_default_branch(github_token, owner, name)
            if repo.default_branch != current_default_branch:
                print(f"[INFO] default_branch drifted: '{repo.default_branch}' → '{current_default_branch}'")
                repo.default_branch = current_default_branch
                await db.commit()
        except Exception as e:
            print(f"[WARN] Could not re-fetch default_branch for {owner}/{name}: {e}")

        cursor = None
        has_next_page = True
        total_commits = 0

        # We loop until we exhaust the history or hit our 12 month limit
        while has_next_page:
            try:
                data = await fetch_commits_batch(github_token, owner, name, cursor)

                # Navigate GraphQL response tree
                history = data.get("data", {}).get("repository", {}).get("defaultBranchRef", {}).get("target", {}).get("history", {})
                nodes = history.get("nodes", [])
                page_info = history.get("pageInfo", {})

                if not nodes:
                    break

                total_commits += len(nodes)
                print(f"Fetched {len(nodes)} commits... Total so far: {total_commits}")

                # Get existing oids to dedup
                existing_stmt = select(Commit.oid).where(Commit.repo_id == repo.id)
                existing_result = await db.execute(existing_stmt)
                existing_oids = set(existing_result.scalars().all())

                # Format raw nodes to match our DB schema
                commits_to_insert = []
                for node in nodes:
                    oid = node["oid"]
                    if oid in existing_oids:
                        continue  # skip dup

                    author_email = node.get("author", {}).get("email", "")
                    author_login = ""
                    if node.get("author", {}).get("user"):
                        author_login = node["author"]["user"].get("login", "")

                    parent_count = node.get("parents", {}).get("totalCount", 1)
                    commits_to_insert.append({
                        "id": str(uuid.uuid4()),
                        "repo_id": str(repo.id),
                        "oid": oid,
                        "message": node["message"],
                        "author_email": author_email,
                        "author_login": author_login,
                        "committed_date": node["committedDate"],
                        "additions": node["additions"],
                        "deletions": node["deletions"],
                        "is_merge_commit": parent_count > 1,
                    })

                if commits_to_insert:
                    print(f"Inserting {len(commits_to_insert)} new commits")
                    # Bulk insert into PostgreSQL using asyncpg copy
                    await bulk_insert_commits(db, commits_to_insert)

                    # Now fetch files for each new commit
                    print(f"Fetching files for {len(commits_to_insert)} commits...")
                    commit_files_to_insert = []
                    failed_commit_ids = []

                    for commit_data in commits_to_insert:
                        # Skip merge commits flagged in GraphQL response
                        if commit_data.get('is_merge_commit'):
                            continue
                        try:
                            files = await fetch_commit_files(
                                github_token, owner, name, commit_data['oid']
                            )
                            for f in files:
                                commit_files_to_insert.append({
                                    'id': str(uuid.uuid4()),
                                    'commit_id': commit_data['id'],
                                    'file_path': f['path'],
                                    'additions': f.get('additions', 0),
                                    'deletions': f.get('deletions', 0),
                                    'change_type': f.get('change_type', 'MODIFIED'),
                                })
                            await asyncio.sleep(0.1)  # throttle to avoid GitHub rate limits
                        except Exception as e:
                            failed_commit_ids.append(commit_data['id'])
                            print(f"[ERROR] Failed to fetch files for commit {commit_data['oid']}: {e}")

                    if failed_commit_ids:
                        print(f"[WARN] {len(failed_commit_ids)}/{len(commits_to_insert)} commits missing file data — marking files_fetch_failed")
                        await db.execute(
                            update(Commit)
                            .where(Commit.id.in_(failed_commit_ids))
                            .values(files_fetch_failed=True)
                        )
                        await db.commit()

                    if commit_files_to_insert:
                        print(f"Inserting {len(commit_files_to_insert)} commit files")
                        try:
                            await bulk_insert_commit_files(db, commit_files_to_insert)
                        except Exception as e:
                            print(f"Error inserting commit files (commits still saved): {e}")
                else:
                    print("No new commits to insert")

                # Retry file fetch for existing commits that have no files yet
                missing_files_result = await db.execute(
                    select(Commit.id, Commit.oid)
                    .where(
                        Commit.repo_id == repo.id,
                        Commit.is_merge_commit == False,
                        ~Commit.id.in_(
                            select(CommitFile.commit_id).where(CommitFile.commit_id == Commit.id).correlate(Commit).scalar_subquery()
                        )
                    )
                    .limit(50)
                )
                missing_commits = missing_files_result.all()
                if missing_commits:
                    print(f"Retrying file fetch for {len(missing_commits)} commits missing files...")
                    retry_files = []
                    for commit_id, commit_oid in missing_commits:
                        try:
                            files = await fetch_commit_files(github_token, owner, name, commit_oid)
                            for f in files:
                                retry_files.append({
                                    'id': str(uuid.uuid4()),
                                    'commit_id': str(commit_id),
                                    'file_path': f['path'],
                                    'additions': f.get('additions', 0),
                                    'deletions': f.get('deletions', 0),
                                    'change_type': f.get('change_type', 'MODIFIED'),
                                })
                            await asyncio.sleep(0.15)
                        except Exception as e:
                            print(f"[WARN] Retry failed for {commit_oid}: {e}")
                    if retry_files:
                        try:
                            await bulk_insert_commit_files(db, retry_files)
                            print(f"  Retry inserted {len(retry_files)} commit files")
                        except Exception as e:
                            print(f"  Retry insert error: {e}")

                # Broadcast progress
                async with httpx.AsyncClient() as client:
                    await client.post("http://api:8000/internal/progress", json={
                        "repo_id": repo_id,
                        "status": "Ingesting commits",
                        "details": f"Processed {total_commits} commits"
                    })

                has_next_page = page_info.get("hasNextPage", False)
                cursor = page_info.get("endCursor")

            except Exception as e:
                print(f"Backfill failed or rate-limited: {e}")
                break

        # Send final complete status
        async with httpx.AsyncClient() as client:
            await client.post("http://api:8000/internal/progress", json={
                "repo_id": repo_id,
                "status": "complete",
                "details": f"Finished fetching {total_commits} commits"
            })

        # Fetch pull requests
        print("Fetching pull requests...")
        pr_cursor = None
        pr_has_next = True
        total_prs = 0

        # Pre-load existing github_ids to dedup on re-backfill
        existing_pr_ids_result = await db.execute(
            select(PullRequest.github_id).where(PullRequest.repo_id == repo.id)
        )
        existing_pr_github_ids = set(existing_pr_ids_result.scalars().all())

        while pr_has_next:
            try:
                pr_data = await fetch_prs_batch(github_token, owner, name, pr_cursor)
                pr_page = pr_data.get("data", {}).get("repository", {}).get("pullRequests", {})
                pr_nodes = pr_page.get("nodes", [])
                if not pr_nodes:
                    break

                prs_to_insert = []
                pr_files_to_insert = []
                for node in pr_nodes:
                    github_id = str(node.get("databaseId", ""))
                    if not github_id:
                        continue
                    pr_id = str(uuid.uuid4())
                    prs_to_insert.append({
                        "id": pr_id,
                        "repo_id": str(repo.id),
                        "github_id": github_id,
                        "number": node.get("number", 0),
                        "title": node.get("title", ""),
                        "state": node.get("state", ""),
                        "author_login": (node.get("author") or {}).get("login", ""),
                        "created_at": node.get("createdAt", ""),
                        "closed_at": node.get("closedAt", "") or "",
                        "merged_at": node.get("mergedAt", "") or "",
                    })

                    # Ingest PR files (first 100 — pagination skipped for v1 per spec)
                    files_data = node.get("files", {}).get("nodes", [])
                    for f in files_data:
                        path = f.get("path", "")
                        if not path:
                            continue
                        pr_files_to_insert.append({
                            "id": str(uuid.uuid4()),
                            "pr_id": pr_id,
                            "path": path,
                            "additions": f.get("additions", 0),
                            "deletions": f.get("deletions", 0),
                            "change_type": (f.get("changeType") or "MODIFIED").upper(),
                        })

                # keep only new PRs and their associated files
                new_pr_ids = {p["id"] for p in prs_to_insert if p["github_id"] not in existing_pr_github_ids}
                prs_to_insert = [p for p in prs_to_insert if p["id"] in new_pr_ids]
                pr_files_to_insert = [f for f in pr_files_to_insert if f["pr_id"] in new_pr_ids]

                if prs_to_insert:
                    await bulk_insert_prs(db, prs_to_insert)
                    for p in prs_to_insert:
                        existing_pr_github_ids.add(p["github_id"])
                    total_prs += len(prs_to_insert)
                    print(f"  Inserted {len(prs_to_insert)} PRs (total {total_prs})")

                if pr_files_to_insert:
                    await bulk_insert_pr_files(db, pr_files_to_insert)
                    print(f"  Inserted {len(pr_files_to_insert)} PR file records")

                pr_has_next = pr_page.get("pageInfo", {}).get("hasNextPage", False)
                pr_cursor = pr_page.get("pageInfo", {}).get("endCursor")
                await asyncio.sleep(0.1)
            except Exception as e:
                print(f"PR fetch failed, stopping: {e}")
                break

        print(f"PR ingestion complete. {total_prs} PRs inserted.")

        # mark repo as synced so dashboard reflects completion
        repo.synced_at = datetime.now(timezone.utc)
        await db.commit()

        # Auto-trigger ChronosGraph build now that commit+PR data is populated
        try:
            async with httpx.AsyncClient(timeout=120.0) as client:
                resp = await client.post(
                    f"http://api:8000/internal/build_graph/{repo_id}",
                    headers={"X-Internal-Key": os.getenv("REPOLENS_API_KEY", "internal_key")},
                )
                print(f"ChronosGraph build triggered: {resp.status_code} {resp.text[:200]}")
        except Exception as e:
            print(f"[WARN] ChronosGraph build trigger failed (non-fatal): {e}")

    print(f"Backfill complete for {owner}/{name}. Processed {total_commits} commits.")
    return total_commits

async def startup(ctx):
    print("Ingestor Worker starting up...")

async def shutdown(ctx):
    print("Ingestor Worker shutting down...")

class WorkerSettings:
    functions = [run_backfill_job]
    on_startup = startup
    on_shutdown = shutdown
    queue_name = os.getenv('BACKFILL_QUEUE', 'arq:backfill')
    redis_settings = RedisSettings(host=os.getenv('REDIS_HOST', 'localhost'))
