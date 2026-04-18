import os
from arq import create_pool
from arq.connections import RedisSettings

# In development via Docker Compose this will be "redis" 
REDIS_HOST = os.getenv("REDIS_HOST", "localhost")
BACKFILL_QUEUE = os.getenv("BACKFILL_QUEUE", "arq:backfill")
CI_QUEUE = os.getenv("CI_QUEUE", "arq:ci")
ARCH_QUEUE = os.getenv("ARCH_QUEUE", "arq:arch")
_redis_pool = None

async def get_redis_pool():
    global _redis_pool
    if _redis_pool is None:
        _redis_pool = await create_pool(RedisSettings(host=REDIS_HOST))
    return _redis_pool
