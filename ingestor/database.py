import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base

# The API database url but accessed from the ingestor service
DATABASE_URL = os.getenv(
    "DATABASE_URL", 
    "postgresql+asyncpg://repolens_user:repolens_password@localhost:5432/repolens"
)

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

Base = declarative_base()

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
