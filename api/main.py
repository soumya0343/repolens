import os
import logging
import time
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env'))

from fastapi import FastAPI
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from auth import router as auth_router
from repos import router as repos_router
from prs import router as prs_router
from ws_manager import router as ws_router
from internal import router as internal_router
from internal_ci import router as internal_ci_router
from chat import router as chat_router
from database import engine, Base
import models  # ensure all model classes are registered with Base

app = FastAPI()
logger = logging.getLogger("repolens.api")


_WEAK_SECRETS = {"super_secret_jwt_key", "internal_key", ""}
_DEV_MODE = os.getenv("DEV_MODE", "false").lower() == "true"

@app.on_event("startup")
async def on_startup():
    """Create any missing tables on startup (idempotent — won't touch existing tables)."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    if not _DEV_MODE:
        jwt_secret = os.getenv("JWT_SECRET", "super_secret_jwt_key")
        api_key = os.getenv("REPOLENS_API_KEY", "internal_key")
        if jwt_secret in _WEAK_SECRETS:
            raise RuntimeError("FATAL: JWT_SECRET is using an insecure default. Set a strong value in .env")
        if api_key in _WEAK_SECRETS:
            raise RuntimeError("FATAL: REPOLENS_API_KEY is using an insecure default. Set a strong value in .env")
 
app.include_router(internal_router)
app.include_router(internal_ci_router)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def log_request_timing(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    duration_ms = (time.perf_counter() - started) * 1000
    if duration_ms >= 250:
        logger.info(
            "slow_request method=%s path=%s status=%s duration_ms=%.1f",
            request.method,
            request.url.path,
            response.status_code,
            duration_ms,
        )
    response.headers["X-Process-Time-Ms"] = f"{duration_ms:.1f}"
    return response

app.include_router(auth_router)
app.include_router(repos_router)
app.include_router(prs_router)
app.include_router(ws_router)
app.include_router(chat_router)

@app.get("/health")
def health_check():
    return {"status": "ok"}
