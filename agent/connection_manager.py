from fastapi import WebSocket
from typing import List

class ConnectionManager:
    def __init__(self):
        # save active connections
        self.active_connections: List[WebSocket] = []

    # when a new websocket connection is made
    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    # when a websocket connection is closed
    def disconnect(self, websocket: WebSocket):
        self.active_connections.remove(websocket)

    # send message to designated websocket
    async def send_personal_message(self, message: str, websocket: WebSocket):
        await websocket.send_text(message)

    async def send_personal_bytes(self, data: bytes, websocket: WebSocket):
        await websocket.send_bytes(data)

manager = ConnectionManager()
