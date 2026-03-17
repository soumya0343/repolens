import asyncio
import os
from worker import run_backfill_job

async def main():
    try:
        token = os.getenv('GITHUB_TOKEN')
        if not token:
            raise ValueError('GITHUB_TOKEN environment variable not set')
        result = await run_backfill_job({}, 'a12f8207-c175-44b0-9a4d-921ec1f1ea1a', token)
        print('result', result)
    except Exception as e:
        import traceback
        traceback.print_exc()

asyncio.run(main())
