import os
from arq import create_pool
from arq.connections import RedisSettings

# In development via Docker Compose this will be "redis" 
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
BACKFILL_QUEUE = os.getenv("BACKFILL_QUEUE", "arq:backfill")
CI_QUEUE = os.getenv("CI_QUEUE", "arq:ci")
ARCH_QUEUE = os.getenv("ARCH_QUEUE", "arq:arch")

async def get_redis_pool():
    return await create_pool(RedisSettings(host=REDIS_HOST))
