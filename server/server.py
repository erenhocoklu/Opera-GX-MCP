import asyncio
import base64
import json
import sys
import threading
import time
import uuid
import websockets
from mcp.server.fastmcp import FastMCP, Image

RELAY_URL = "ws://localhost:7866"
# Must match the relay's max frame size so screenshots are not rejected mid-flight.
MAX_SIZE = 16 * 1024 * 1024

# This process is ephemeral - Claude Code / Claude Desktop each launch their own.
# It no longer owns a port. It dials OUT to the relay, which owns the extension.
state = {
    "relay": None,      # our WebSocket connection to the relay
    "relay_loop": None, # the event loop running in the relay-client thread
    "pending": {},      # request_id -> (future, caller_loop)
}


def log(msg):
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", file=sys.stderr, flush=True)


def start_relay_thread():
    """Background thread: holds a persistent client connection to the relay.
    Reconnects forever, because the relay may start after us (or restart)."""
    def run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        state["relay_loop"] = loop

        async def connect_forever():
            while True:
                try:
                    async with websockets.connect(RELAY_URL, max_size=MAX_SIZE) as ws:
                        state["relay"] = ws
                        log("connected to relay")
                        async for raw in ws:
                            data = json.loads(raw)
                            req_id = data.get("id")
                            entry = state["pending"].get(req_id)
                            if entry:
                                future, caller_loop = entry
                                caller_loop.call_soon_threadsafe(future.set_result, data)
                except Exception as e:
                    log(f"relay connection lost ({e}), retrying in 2s")
                finally:
                    state["relay"] = None
                await asyncio.sleep(2)

        loop.run_until_complete(connect_forever())

    threading.Thread(target=run, daemon=True).start()


async def send_command(action, params=None, timeout=10):
    relay = state["relay"]
    relay_loop = state["relay_loop"]
    if not relay:
        raise ConnectionError("not connected to relay (is relay.py running?)")
    if not relay_loop:
        raise ConnectionError("relay thread not started")

    req_id = str(uuid.uuid4())
    msg = {"id": req_id, "action": action, "params": params or {}}

    caller_loop = asyncio.get_running_loop()
    future = caller_loop.create_future()
    state["pending"][req_id] = (future, caller_loop)

    send_future = asyncio.run_coroutine_threadsafe(
        relay.send(json.dumps(msg)), relay_loop
    )
    send_future.result(timeout=5)

    try:
        result = await asyncio.wait_for(future, timeout=timeout)
    finally:
        state["pending"].pop(req_id, None)

    if result.get("error"):
        raise ConnectionError(result["error"])
    return result


mcp = FastMCP("opera-mcp")


@mcp.tool()
async def ping() -> str:
    """Pings the Opera GX extension and returns its response."""
    try:
        result = await send_command("ping")
        return result.get("data", "no response")
    except ConnectionError as e:
        return f"error: {e}"


@mcp.tool()
async def navigate(url: str) -> str:
    """Navigates the active Opera GX tab to the given URL."""
    result = await send_command("navigate", {"url": url})
    return result.get("data", "no response")


@mcp.tool()
async def get_page_text() -> str:
    """Returns the text content of the active Opera GX tab."""
    result = await send_command("get_page_text")
    return result.get("data", "no response")


@mcp.tool()
async def screenshot() -> Image:
    """Captures the visible area of the active Opera GX tab as a JPEG image."""
    result = await send_command("screenshot")
    data_url = result.get("data", "")
    b64 = data_url.split(",", 1)[1]   # strip the "data:image/jpeg;base64," prefix
    return Image(data=base64.b64decode(b64), format="jpeg")

@mcp.tool()
async def click(target: str) -> str:
    """Clicks the first visible clickable element (link, button, or role=button)
    whose accessible name matches `target` - exact match first, then substring,
    case-insensitive."""
    try:
        result = await send_command("click", {"target": target})
        return f"clicked: {result.get('data')}"
    except ConnectionError as e:
        return f"could not click: {e}"

@mcp.tool()
async def fill(target: str, value: str) -> str:
    """Fills the first visible text input or textarea whose accessible name
    matches `target` - exact match first, then substring, case-insensitive -
    with `value`. Uses a React/Vue-safe native setter plus input/change events.
    Scope: text-type <input> and <textarea> only."""
    try:
        result = await send_command("fill", {"target": target, "value": value})
        return f"filled: {result.get('data')}"
    except ConnectionError as e:
        return f"could not fill: {e}"

@mcp.tool()
async def pin_new_tab(url: str = "about:blank") -> str:
    """PREFERRED way to open a working tab. Opens a NEW background tab in Eren's
    CURRENT Opera window and pins it as the target for navigate/get_page_text/
    click/fill. It never switches his active tab, so he keeps working undisturbed
    in his own browser. Use this BY DEFAULT for hands-off tasks. Downside:
    screenshot does NOT work on a background tab - if you must screenshot the page,
    use pin_new_window instead. Call close_tab when the task is done to clean up."""
    result = await send_command("pin_new_tab", {"url": url})
    return result.get("data", "no response")

@mcp.tool()
async def pin_new_window(url: str = "about:blank") -> str:
    """Opens a NEW separate Opera window and pins its tab. Use this ONLY when you
    need to screenshot the pinned page (a background tab cannot be screenshotted),
    or when Eren explicitly asks for a separate window. Eren PREFERS pin_new_tab
    (his own window, no visible extra tab) - do NOT use pin_new_window by default.
    Keep the window non-minimized for screenshots. Call close_tab when done."""
    result = await send_command("pin_new_window", {"url": url})
    return result.get("data", "no response")

@mcp.tool()
async def close_tab() -> str:
    """Closes the currently pinned tab (the one you opened via pin_new_tab or
    pin_new_window) and clears the pin. Call this when you have FINISHED the task
    in that tab, to clean up after yourself instead of leaving tabs open."""
    result = await send_command("close_tab", {})
    return result.get("data", "no response")
    
@mcp.tool()
async def unpin() -> str:
    """Clears the pinned target. All tools go back to acting on the focused
    window's active tab (the original follow-me behavior)."""
    result = await send_command("unpin", {})
    return result.get("data", "no response")

@mcp.tool()
async def scroll(direction: str = "down", amount: int = 0) -> str:
    """Scrolls the active/pinned Opera tab. direction: "down" (default), "up",
    "top", or "bottom". `amount` is optional pixels for up/down (defaults to about
    one viewport). Use to load lazy content - comment sections, infinite feeds,
    "load more" buttons - that only appears as you scroll toward it."""
    result = await send_command("scroll", {"direction": direction, "amount": amount})
    return result.get("data", "no response")


@mcp.tool()
async def press_key(key: str = "Enter") -> str:
    """Dispatches a keyboard key to the focused element in the active/pinned tab.
    Common keys: "Enter" (submit a chat/search box), "Tab", "Escape", "Backspace",
    "ArrowUp"/"ArrowDown"/"ArrowLeft"/"ArrowRight". Use after `fill` to submit an
    input that sends on Enter (the field stays focused after fill)."""
    result = await send_command("press_key", {"key": key})
    return result.get("data", "no response")


if __name__ == "__main__":
    start_relay_thread()
    mcp.run()
