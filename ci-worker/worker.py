import asyncio
import os
from ci_client import fetch_workflow_runs, download_run_logs

async def run_ci_backfill(ctx, repo_id: str, owner: str, name: str, github_token: str):
    """
    ARQ background task to execute the CI log backfill for a repository.
    """
    print(f"Starting CI backfill for repo: {owner}/{name}")
    
    try:
        runs = await fetch_workflow_runs(github_token, owner, name)
        print(f"Found {len(runs)} workflow runs.")
        
        for run in runs:
            run_id = run["id"]
            conclusion = run["conclusion"] # success, failure, neutral, cancelled
            
            # For TestPulse, we care heavily about failures.
            print(f"Processing Run {run_id} ({conclusion})")
            
            logs = await download_run_logs(github_token, owner, name, run_id)
            if logs:
                print(f"  Downloaded {len(logs)} log files")
                # Simple analysis: count errors
                error_count = sum('error' in log.lower() for log in logs.values())
                analysis = {
                    'failure_rate': conclusion == 'failure',
                    'error_count': error_count,
                    'log_files': len(logs)
                }
                # POST to API
                async with httpx.AsyncClient() as client:
                    await client.post("http://api:8000/internal/ci_analysis", json={
                        'repo_id': repo_id,  # stub
                        'run_id': run_id,
                        'analysis': analysis
                    })
            else:
                print(f"  No logs available for run {run_id}")
                
    except Exception as e:
        print(f"CI Backfill failed: {e}")

    print(f"CI Backfill complete for {owner}/{name}.")
    return True

import os
from arq.connections import RedisSettings

async def startup(ctx):
    print("CI Worker starting up...")

async def shutdown(ctx):
    print("CI Worker shutting down...")

class WorkerSettings:
    functions = [run_ci_backfill]
    on_startup = startup
    on_shutdown = shutdown
    queue_name = os.getenv('CI_QUEUE', 'arq:ci')
    redis_settings = RedisSettings(host=os.getenv('REDIS_HOST', 'localhost'))
