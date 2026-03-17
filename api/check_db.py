import asyncio
import os
from database import AsyncSessionLocal
from models import Repo, Commit, PullRequest, Issue, CIRun
from sqlalchemy.future import select
from sqlalchemy import func

async def check():
    async with AsyncSessionLocal() as db:
        # Get all repos
        result = await db.execute(select(Repo))
        repos = result.scalars().all()
        print(f'Found {len(repos)} repos')
        for repo in repos:
            print(f'Repo: {repo.owner}/{repo.name}, synced_at: {repo.synced_at}')
            # Count commits
            commit_count = await db.execute(select(func.count(Commit.id)).where(Commit.repo_id == repo.id))
            pr_count = await db.execute(select(func.count(PullRequest.id)).where(PullRequest.repo_id == repo.id))
            issue_count = await db.execute(select(func.count(Issue.id)).where(Issue.repo_id == repo.id))
            ci_count = await db.execute(select(func.count(CIRun.id)).where(CIRun.repo_id == repo.id))
            print(f'  Commits: {commit_count.scalar()}, PRs: {pr_count.scalar()}, Issues: {issue_count.scalar()}, CI: {ci_count.scalar()}')

asyncio.run(check())