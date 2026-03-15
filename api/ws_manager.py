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

@router.websocket("/ws/progress/{repo_id}")
async def websocket_endpoint(websocket: WebSocket, repo_id: str):
    await manager.connect(websocket, repo_id)
    try:
        while True:
            # We don't expect messages from the client in this flow
            # We just ping to keep the connection alive
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket, repo_id)

@router.post("/internal/progress")
async def update_progress(payload: dict):
    """
    Internal endpoint called by the ARQ workers (ingestor, ci-worker, arch-worker)
    to push their task status up to the FastAPI layer, which broadcasts it over Websockets.
    """
    repo_id = payload.get("repo_id")
    if not repo_id:
        return {"status": "error", "message": "Missing repo_id"}
        
    await manager.broadcast_progress(repo_id, payload)
    return {"status": "ok"}
