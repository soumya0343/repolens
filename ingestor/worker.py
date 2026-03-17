import os
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env'))

import uuid
import httpx
from datetime import datetime, timezone
from github_client import fetch_commits_batch
from database import AsyncSessionLocal
from models import Repo
from sqlalchemy.future import select
from db_writer import bulk_insert_commits

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

                # Format raw nodes to match our DB schema
                commits_to_insert = []
                for node in nodes:
                    author_email = node.get("author", {}).get("email", "")
                    author_login = ""
                    if node.get("author", {}).get("user"):
                        author_login = node["author"]["user"].get("login", "")

                    commits_to_insert.append({
                        "id": str(uuid.uuid4()),
                        "repo_id": str(repo.id),
                        "oid": node["oid"],
                        "message": node["message"],
                        "author_email": author_email,
                        "author_login": author_login,
                        "committed_date": node["committedDate"],
                        "additions": node["additions"],
                        "deletions": node["deletions"],
                    })

                # Bulk insert into PostgreSQL using asyncpg copy
                await bulk_insert_commits(db, commits_to_insert)

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

        # mark repo as synced so dashboard reflects completion
        repo.synced_at = datetime.now(timezone.utc)
        await db.commit()

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
    # ARQ defaults to looking for Redis on localhost:6379 natively.
    # In docker it will use the `redis` host.
    # redis_settings = RedisSettings(host='localhost')
