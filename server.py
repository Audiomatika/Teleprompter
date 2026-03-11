"""
Teleprompter Server – Python / FastAPI
Port of the original Node.js implementation.
"""

import io
import json
import os
import socket
from pathlib import Path

import docx
import uvicorn
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, UploadFile, File
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

# ---------------------------------------------------------------------------
# Setup
# ---------------------------------------------------------------------------

BASE_DIR = Path(__file__).resolve().parent

app = FastAPI()

PORT = 3000

# ---------------------------------------------------------------------------
# Server-side state
# ---------------------------------------------------------------------------

# Holds the most recently loaded script text so late-joining clients get it
current_script: str = ""

# Track connected WebSocket clients: ws -> {"role": str | None, "ip": str}
clients: dict[WebSocket, dict] = {}

# ---------------------------------------------------------------------------
# Helper utilities
# ---------------------------------------------------------------------------


async def safe_send(ws: WebSocket, obj: dict) -> None:
    """Safely send a JSON message to a single WebSocket client."""
    try:
        await ws.send_json(obj)
    except Exception:
        pass


async def broadcast(obj: dict) -> None:
    """Broadcast a JSON message to ALL connected clients."""
    for ws in list(clients.keys()):
        await safe_send(ws, obj)


async def send_to_role(role: str, obj: dict) -> None:
    """Send a JSON message only to clients registered with a specific role."""
    for ws, meta in list(clients.items()):
        if meta.get("role") == role:
            await safe_send(ws, obj)


def get_local_ips() -> list[dict]:
    """Detect and return all local network IPv4 addresses.

    Returns a list of dicts with keys "name" and "address". The primary IP
    (determined via UDP socket trick) is listed first, followed by any
    additional addresses discovered via getaddrinfo. Loopback (127.x.x.x)
    and link-local (169.254.x.x) addresses are excluded.
    """
    addresses: list[dict] = []
    seen: set[str] = set()

    def _add(name: str, addr: str) -> None:
        """Add an address if it hasn't been seen and isn't filtered."""
        if addr in seen:
            return
        if addr.startswith("127.") or addr.startswith("169.254."):
            return
        seen.add(addr)
        addresses.append({"name": name, "address": addr})

    # 1. UDP socket trick — reveals the "primary" outbound interface IP.
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Doesn't actually send anything; just determines the routing IP.
        s.connect(("8.8.8.8", 80))
        primary_addr = s.getsockname()[0]
        s.close()
        _add("primary", primary_addr)
    except Exception:
        pass

    # 2. getaddrinfo — collects all IPv4 addresses bound to all interfaces.
    try:
        results = socket.getaddrinfo(socket.gethostname(), None)
        for item in results:
            family, _type, _proto, _canonname, sockaddr = item
            if family == socket.AF_INET:
                addr = str(sockaddr[0])
                _add("network", addr)
    except Exception:
        pass

    return addresses


def extract_text_from_docx(file_bytes: bytes) -> str:
    """Extract raw text from a .docx file using python-docx (in-memory)."""
    document = docx.Document(io.BytesIO(file_bytes))
    paragraphs = [para.text for para in document.paragraphs]
    return "\n".join(paragraphs)


# ---------------------------------------------------------------------------
# REST API – Ping (pre-flight check used by teleprompter.js)
# ---------------------------------------------------------------------------


@app.get("/api/ping")
async def ping():
    return {"status": "ok"}


@app.get("/api/server-url")
async def server_url():
    """Return the server's LAN URL(s) for QR code generation.

    Returns a "primary" string for backward compatibility and a "urls" list
    with one entry per detected network interface.
    """
    ips = get_local_ips()
    if ips:
        urls = [
            {
                "label": ip["name"],
                "url": f"http://{ip['address']}:{PORT}/teleprompter.html",
            }
            for ip in ips
        ]
        primary = urls[0]["url"]
    else:
        primary = f"http://localhost:{PORT}/teleprompter.html"
        urls = [{"label": "localhost", "url": primary}]
    return {"primary": primary, "urls": urls}


# ---------------------------------------------------------------------------
# REST API – File Upload
# ---------------------------------------------------------------------------


@app.post("/upload")
async def upload_file(script: UploadFile = File(...)):
    """
    Accepts a .docx file, extracts the raw text via python-docx, stores it,
    and broadcasts the script content to all connected WebSocket clients.
    """
    global current_script
    try:
        content = await script.read()
        script_text = extract_text_from_docx(content)
        current_script = script_text
        await broadcast({"type": "script:loaded", "data": script_text})
        return JSONResponse({"success": True, "script": script_text})
    except Exception as e:
        print(f"Upload/parse error: {e}")
        return JSONResponse({"success": False, "error": str(e)}, status_code=500)


# ---------------------------------------------------------------------------
# WebSocket Endpoint
# ---------------------------------------------------------------------------


@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """
    Main WebSocket endpoint. Handles client registration, playback controls,
    and synchronization between controllers and teleprompter displays.
    """
    global current_script

    await ws.accept()
    client_ip = ws.client.host if ws.client else "unknown"
    clients[ws] = {"role": None, "ip": client_ip}
    print(f"[WS] Client connected from {client_ip}. Total clients: {len(clients)}")

    try:
        while True:
            raw = await ws.receive_text()
            try:
                msg = json.loads(raw)
            except json.JSONDecodeError as e:
                print(f"[WS] Failed to parse message: {e}")
                continue

            msg_type = msg.get("type")
            data = msg.get("data")

            # ----- Registration ------------------------------------------------
            if msg_type == "register":
                role = data.get("role") if data else None
                clients[ws] = {"role": role, "ip": client_ip}
                print(f'[WS] Client registered as "{role}" from {client_ip}')

                if role == "teleprompter":
                    # Notify all controllers that a teleprompter has connected
                    await send_to_role(
                        "controller", {"type": "status:teleprompter_connected"}
                    )
                    # If there's already a script loaded, send it to the new teleprompter
                    if current_script:
                        await safe_send(
                            ws, {"type": "script:loaded", "data": current_script}
                        )

                elif role == "controller":
                    # Check if any teleprompter is currently connected
                    has_teleprompter = any(
                        meta.get("role") == "teleprompter" for meta in clients.values()
                    )
                    if has_teleprompter:
                        await safe_send(ws, {"type": "status:teleprompter_connected"})
                    # Also send the current script if available
                    if current_script:
                        await safe_send(
                            ws, {"type": "script:loaded", "data": current_script}
                        )

            # ----- Playback controls (forwarded to all teleprompters) ----------
            elif msg_type == "control:play":
                await send_to_role("teleprompter", {"type": "control:play"})

            elif msg_type == "control:pause":
                await send_to_role("teleprompter", {"type": "control:pause"})

            elif msg_type == "control:scroll":
                await send_to_role(
                    "teleprompter", {"type": "control:scroll", "data": data}
                )

            elif msg_type == "control:mirror":
                await send_to_role(
                    "teleprompter", {"type": "control:mirror", "data": data}
                )

            elif msg_type == "control:speed":
                await send_to_role(
                    "teleprompter", {"type": "control:speed", "data": data}
                )

            elif msg_type == "control:fontsize":
                await send_to_role(
                    "teleprompter", {"type": "control:fontsize", "data": data}
                )

            # ----- Status updates (forwarded to controllers) -------------------
            elif msg_type == "status:viewport_info":
                await send_to_role(
                    "controller", {"type": "status:viewport_info", "data": data}
                )

            elif msg_type == "ping":
                # Application-level heartbeat from client — no response needed
                pass
            else:
                print(f'[WS] Unknown message type: "{msg_type}"')

    except WebSocketDisconnect:
        pass
    except Exception as e:
        print(f"[WS] Error: {e}")
    finally:
        meta = clients.pop(ws, {})
        role = meta.get("role", "unknown")
        print(f'[WS] Client ("{role}") disconnected. Total clients: {len(clients)}')

        # If a teleprompter left, let controllers know
        if role == "teleprompter":
            await send_to_role(
                "controller", {"type": "status:teleprompter_disconnected"}
            )


# ---------------------------------------------------------------------------
# Static files – serve the frontend from ./public
# NOTE: This must be mounted AFTER all API/WebSocket routes
# ---------------------------------------------------------------------------

from fastapi import Request
from starlette.middleware.base import BaseHTTPMiddleware


class NoCacheJSMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.url.path.endswith(".js"):
            response.headers["Cache-Control"] = (
                "no-store, no-cache, must-revalidate, max-age=0"
            )
            response.headers["Pragma"] = "no-cache"
        return response


app.add_middleware(NoCacheJSMiddleware)

app.mount(
    "/", StaticFiles(directory=str(BASE_DIR / "public"), html=True), name="static"
)


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def main():
    """Entry point for the teleprompter server."""
    print("=========================================")
    print(" Teleprompter Server")
    print("=========================================")
    print(f"Local:    http://localhost:{PORT}")

    ips = get_local_ips()
    if ips:
        for ip_info in ips:
            print(f"Network:  http://{ip_info['address']}:{PORT}  ({ip_info['name']})")
    else:
        print("Network:  No external network interfaces detected")

    print("=========================================")
    print("Open the URL above on your iPad or any device on the same network.")

    uvicorn.run(
        app,
        host="0.0.0.0",
        port=PORT,
        log_level="info",
        ws_ping_interval=20,
        ws_ping_timeout=30,
    )


if __name__ == "__main__":
    main()
