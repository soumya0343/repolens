import os
import asyncio
from dotenv import load_dotenv
load_dotenv()

from openai import AsyncOpenAI
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.future import select, update
from sqlalchemy import and_
import json
from arq.connections import RedisSettings
from database import AsyncSessionLocal
from models import Commit
from openai import AsyncOpenAI

client = AsyncOpenAI(api_key=os.getenv('OPENAI_API_KEY'))

async def run_commit_classification(ctx, repo_id: str):
    async with AsyncSessionLocal() as db:
        # Fetch unclassified commits
        stmt = select(Commit).where(and_(Commit.repo_id == repo_id, Commit.risk_score.is_(None)))
        result = await db.execute(stmt)
        commits = result.scalars().all()
        
        batch = []
        for commit in commits:
            batch.append(commit.message)
        
        if not batch:
            return 0
        
        # OpenAI batch
        response = await client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "system", "content": "Classify commit risk score 1-10 (10 high risk). Respond JSON list [score1, score2...]"} , {"role": "user", "content": "\\n".join(batch)}]
        )
        
        scores_str = response.choices[0].message.content
        scores = json.loads(scores_str)
        
        # Update
        for i, commit in enumerate(commits):
            commit.risk_score = scores[i]
        
        await db.commit()
        return len(commits)

class WorkerSettings:
    functions = [run_commit_classification]
    redis_settings = RedisSettings(host=os.getenv('REDIS_HOST', 'localhost'))
    queue_name = 'classifier_queue'
