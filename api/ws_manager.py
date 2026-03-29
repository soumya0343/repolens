from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from typing import Dict

router = APIRouter(tags=["ws"])

# Store active connections per repository
class ConnectionManager:
    def __init__(self):
        self.active_connections: Dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, repo_id: str):
        await websocket.accept()
        if repo_id not in self.active_connections:
            self.active_connections[repo_id] = []
        self.active_connections[repo_id].append(websocket)

    def disconnect(self, websocket: WebSocket, repo_id: str):
        self.active_connections[repo_id].remove(websocket)
        if not self.active_connections[repo_id]:
            del self.active_connections[repo_id]

    async def broadcast_progress(self, repo_id: str, message: dict):
        if repo_id in self.active_connections:
            for connection in self.active_connections[repo_id]:
                await connection.send_json(message)

manager = ConnectionManager()

# ── Backfill progress WebSocket ─────────────────────────────────────────────

@router.websocket("/ws/progress/{repo_id}")
async def websocket_endpoint(websocket: WebSocket, repo_id: str):
    await manager.connect(websocket, repo_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, repo_id)

@router.post("/internal/progress")
async def update_progress(payload: dict):
    """Called by ARQ workers to broadcast backfill progress over WebSocket."""
    repo_id = payload.get("repo_id")
    if not repo_id:
        return {"status": "error", "message": "Missing repo_id"}
    await manager.broadcast_progress(repo_id, payload)
    return {"status": "ok"}

# ── Live PR score WebSocket ─────────────────────────────────────────────────

class LiveConnectionManager:
    """Separate manager for live PR score events on /ws/repos/{id}/live."""

    def __init__(self):
        self.active_connections: Dict[str, list[WebSocket]] = {}

    async def connect(self, websocket: WebSocket, repo_id: str):
        await websocket.accept()
        self.active_connections.setdefault(repo_id, []).append(websocket)

    def disconnect(self, websocket: WebSocket, repo_id: str):
        conns = self.active_connections.get(repo_id, [])
        if websocket in conns:
            conns.remove(websocket)
        if not conns:
            self.active_connections.pop(repo_id, None)

    async def broadcast(self, repo_id: str, message: dict):
        for ws in list(self.active_connections.get(repo_id, [])):
            try:
                await ws.send_json(message)
            except Exception:
                self.disconnect(ws, repo_id)


live_manager = LiveConnectionManager()


@router.websocket("/ws/repos/{repo_id}/live")
async def live_websocket_endpoint(websocket: WebSocket, repo_id: str):
    """Live PR score stream — emits {type, pr_id, score, label} events."""
    await live_manager.connect(websocket, repo_id)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        live_manager.disconnect(websocket, repo_id)


@router.post("/internal/pr_scored")
async def pr_scored_event(payload: dict):
    """Called by risk_scorer or workers when a PR score is finalized."""
    repo_id = payload.get("repo_id")
    if not repo_id:
        return {"status": "error", "message": "Missing repo_id"}
    await live_manager.broadcast(repo_id, {"type": "pr_scored", **payload})
    return {"status": "ok"}
