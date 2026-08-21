"""
Relay: the single persistent middleman.

Owns both ports so multiple MCP server instances (Claude Code, Claude Desktop)
can share ONE extension connection.

  Extension      --ws 7865-->  RELAY  <--ws 7866--  MCP server instances
  (one)                                              (many)

Routing is pure plumbing: every message carries an "id" (the UUID-matched
request/response pattern). Command comes in on 7866 -> relay remembers which
client sent that id -> forwards to extension. Response comes back on 7865 with
the same id -> relay looks up the client -> sends it back. The relay never
invents ids, it just reads them.

Run this ONCE, leave it running:
    .venv\\Scripts\\python.exe relay.py
"""
import asyncio
import json
import sys
import time
import websockets

# Default websockets max frame is 1 MB. A base64 screenshot can exceed that and
# the frame gets rejected mid-flight, which looks like a hang. Raise it.
MAX_SIZE = 16 * 1024 * 1024

extension = None      # the ONE extension WebSocket connection (or None)
clients = {}          # request_id -> the MCP client WebSocket that asked


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}][relay] {msg}", file=sys.stderr, flush=True)


async def send_heartbeats(ws):
    """Send a heartbeat every 20s so the extension's MV3 service worker never
    hits its 30s idle timeout. Receiving a message resets the worker's timer.
    The extension ignores these messages."""
    try:
        while True:
            await asyncio.sleep(20)
            await ws.send(json.dumps({"type": "heartbeat"}))
    except (websockets.ConnectionClosed, asyncio.CancelledError):
        pass


# Port 7865: the extension connects here. Messages arriving are RESPONSES.
async def handle_extension(ws):
    global extension
    extension = ws
    log("extension CONNECTED")
    heartbeat = asyncio.create_task(send_heartbeats(ws))
    try:
        async for raw in ws:
            data = json.loads(raw)
            req_id = data.get("id")
            client_ws = clients.pop(req_id, None)
            if client_ws is not None:
                await client_ws.send(raw)          # forward response verbatim
                log(f"routed response id={req_id} -> client")
            else:
                log(f"response id={req_id} had no waiting client (dropped)")
    except websockets.ConnectionClosed:
        pass
    finally:
        heartbeat.cancel()
        extension = None
        log("extension DISCONNECTED")


# Port 7866: MCP server instances connect here. Messages arriving are COMMANDS.
async def handle_client(ws):
    log("mcp client CONNECTED")
    try:
        async for raw in ws:
            data = json.loads(raw)
            req_id = data.get("id")
            if extension is None:
                # No extension to serve this command - reply with an error so the
                # MCP tool fails fast instead of hanging until timeout.
                await ws.send(json.dumps({"id": req_id, "error": "no extension connected"}))
                log(f"command id={req_id} rejected (no extension)")
                continue
            clients[req_id] = ws                   # remember who to reply to
            await extension.send(raw)              # forward command verbatim
            log(f"routed command id={req_id} -> extension")
    except websockets.ConnectionClosed:
        pass
    finally:
        # This client died. Purge any pending ids that pointed at it, or the
        # dict leaks one entry per never-answered request.
        dead = [rid for rid, c in clients.items() if c is ws]
        for rid in dead:
            clients.pop(rid, None)
        log(f"mcp client DISCONNECTED (purged {len(dead)} pending)")


async def main():
    # Single-instance guard: if the ports are already bound, another relay is
    # running. Exit cleanly with a clear message instead of crashing on the
    # swallowed OSError that cost us hours last time.
    try:
        ext_server = await websockets.serve(handle_extension, "localhost", 7865, max_size=MAX_SIZE)
        mcp_server = await websockets.serve(handle_client, "localhost", 7866, max_size=MAX_SIZE)
    except OSError as e:
        log(f"could not bind ports - relay already running? exiting. ({e})")
        return
    log("listening: extension on 7865, mcp clients on 7866")
    # Block forever - keep both servers alive.
    await asyncio.Future()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        log("shutting down")
