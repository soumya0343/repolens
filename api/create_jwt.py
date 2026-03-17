import os
import asyncio
import jwt
from database import AsyncSessionLocal
from models import User
from sqlalchemy.future import select

async def main():
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User).where(User.login == 'soumya0343'))
        user = result.scalars().first()
        if not user:
            print('User not found')
            return
        secret = os.getenv('JWT_SECRET', 'super_secret_jwt_key')
        token = jwt.encode({'sub': str(user.id)}, secret, algorithm='HS256')
        print('JWT:', token)

asyncio.run(main())
