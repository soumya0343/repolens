import asyncio
from database import AsyncSessionLocal
from models import Repo
from sqlalchemy.future import select

async def main():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(Repo))
        for repo in result.scalars().all():
            print('uuid', repo.id, 'github_id', repo.github_id, 'owner/name', f'{repo.owner}/{repo.name}')

asyncio.run(main())
