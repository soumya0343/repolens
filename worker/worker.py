from arq import Worker
import asyncio
import logging
import os
import sys
import uuid
import httpx
from arq.connections import RedisSettings

# Add parent directory to path to import from ingestor
sys.path.insert(0, '/app')

# Set up logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

async def startup(ctx):
    logger.info("Worker starting up...")

async def shutdown(ctx):
    logger.info("Worker shutting down...")

async def run_backfill_job(ctx, repo_id: str, github_token: str):
    """Main backfill job for repository data"""
    logger.info(f"Starting backfill for repo {repo_id}")
    
    try:
        # Call the ingestor service via HTTP instead of importing
        async with httpx.AsyncClient() as client:
            response = await client.post(
                "http://ingestor:8000/backfill",
                json={"repo_id": repo_id, "github_token": github_token},
                timeout=300.0  # 5 minute timeout
            )
            response.raise_for_status()
            result = response.json()
            logger.info(f"Backfill completed for repo {repo_id}")
            return result
    except Exception as e:
        logger.error(f"Backfill failed for repo {repo_id}: {e}")
        raise

class WorkerSettings:
    functions = [run_backfill_job]
    on_startup = startup
    on_shutdown = shutdown
    queue_name = os.getenv('BACKFILL_QUEUE', 'arq:backfill')
    redis_settings = RedisSettings(host=os.getenv('REDIS_HOST', 'localhost'))
