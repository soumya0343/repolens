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
            
            # If we were doing deep analysis now:
            # logs = await download_run_logs(github_token, owner, name, run_id)
            # if logs:
            #     print(f"  Downloaded {len(logs)} log files")
            #     # Pass logs to Logparser3/Drain for failure clustering
                
    except Exception as e:
        print(f"CI Backfill failed: {e}")

    print(f"CI Backfill complete for {owner}/{name}.")
    return True

async def startup(ctx):
    print("CI Worker starting up...")

async def shutdown(ctx):
    print("CI Worker shutting down...")

class WorkerSettings:
    functions = [run_ci_backfill]
    on_startup = startup
    on_shutdown = shutdown
