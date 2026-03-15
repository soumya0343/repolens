import os
from arq import create_pool
from arq.connections import RedisSettings

# In development via Docker Compose this will be "redis" 
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")

async def get_redis_pool():
    return await create_pool(RedisSettings(host=REDIS_HOST))
