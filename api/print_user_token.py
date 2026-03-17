import asyncio
from database import AsyncSessionLocal
from models import User
from sqlalchemy.future import select

async def main():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User))
        users = result.scalars().all()
        for u in users:
            print('user', u.login, 'token', u.github_token)

asyncio.run(main())
