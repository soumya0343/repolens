import os
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.orm import sessionmaker, declarative_base

# Default to the docker-compose postgres url
DATABASE_URL = os.getenv(
    "DATABASE_URL", 
    "postgresql+asyncpg://repolens_user:repolens_password@localhost:5454/repolens"
)

# When inside docker container, postgres operates on the container name `postgres`
# But for local alembic runs we might use localhost. We'll handle this dynamically later.

engine = create_async_engine(DATABASE_URL, echo=False)
AsyncSessionLocal = sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

Base = declarative_base()

async def get_db():
    async with AsyncSessionLocal() as session:
        yield session
