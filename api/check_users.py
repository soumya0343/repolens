import asyncio
from database import AsyncSessionLocal
from models import User
from sqlalchemy.future import select

async def check():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User))
        users = result.scalars().all()
        print(f'Users: {len(users)}')
        for u in users:
            print(f'  {u.login}')

asyncio.run(check())