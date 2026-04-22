import asyncio
import os
import httpx
from arq import cron
from ci_client import fetch_workflow_runs, download_run_logs
from test_pulse import TestPulse

INTERNAL_API_KEY = os.getenv("REPOLENS_API_KEY", "internal_key")

async def scheduled_ci_refresh(ctx):
    """Hourly cron: enqueue CI backfill for all repos via internal API."""
    try:
        async with httpx.AsyncClient() as client:
            r = await client.post(
                "http://api:8000/internal/ci_refresh_all",
                headers={"x-internal-key": INTERNAL_API_KEY},
                timeout=30,
            )
            data = r.json()
            print(f"Scheduled CI refresh: enqueued {data.get('enqueued', '?')} repos")
    except Exception as e:
        print(f"Scheduled CI refresh failed: {e}")

async def run_ci_backfill(ctx, repo_id: str, owner: str, name: str, github_token: str):
    """
    ARQ background task to execute the CI log backfill for a repository.
    """
    print(f"Starting CI backfill for repo: {owner}/{name}")

    test_pulse = TestPulse()

    try:
        runs = await fetch_workflow_runs(github_token, owner, name)
    except Exception as e:
        print(f"CI Backfill: failed to fetch runs for {owner}/{name}: {e}")
        return False

    print(f"Found {len(runs)} workflow runs.")

    for run in runs:
        try:
            run_id = run["id"]
            conclusion = run.get("conclusion")
            print(f"Processing Run {run_id} ({conclusion})")

            logs = await download_run_logs(github_token, owner, name, run_id)
            if not logs:
                print(f"  No logs available for run {run_id}")
                continue

            print(f"  Downloaded {len(logs)} log files, analyzing...")
            analysis = test_pulse.analyze_logs(logs)

            async with httpx.AsyncClient() as client:
                await client.post("http://api:8000/internal/ci_analysis", json={
                    'repo_id': repo_id,
                    'run_id': str(run_id),
                    'conclusion': conclusion or "",
                    'analysis': analysis,
                    'head_sha': run.get("head_sha", ""),
                    'name': run.get("name", "CI"),
                    'event': run.get("event"),
                    'head_branch': run.get("head_branch"),
                    'created_at': run.get("created_at"),
                    'updated_at': run.get("updated_at"),
                })
        except Exception as e:
            print(f"  Run {run.get('id')} failed, skipping: {e}")
            continue

    print(f"CI Backfill complete for {owner}/{name}.")
    return True

import os
from arq.connections import RedisSettings

async def startup(ctx):
    print("CI Worker starting up...")

async def shutdown(ctx):
    print("CI Worker shutting down...")

class WorkerSettings:
    functions = [run_ci_backfill, scheduled_ci_refresh]
    cron_jobs = [
        cron(scheduled_ci_refresh, hour=None, minute=0),  # every hour on the hour
    ]
    on_startup = startup
    on_shutdown = shutdown
    queue_name = os.getenv('CI_QUEUE', 'arq:ci')
    redis_settings = RedisSettings(host=os.getenv('REDIS_HOST', 'localhost'))
