from arq import Worker
import asyncio

async def startup(ctx):
    print("Worker starting up...")

async def shutdown(ctx):
    print("Worker shutting down...")

class WorkerSettings:
    functions = []
    on_startup = startup
    on_shutdown = shutdown
    redis_settings = None # Can be configured later
