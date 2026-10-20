# Opera GX MCP

An MCP server plus a browser extension that lets Claude drive your real Opera GX browser: your tabs, your logged-in sessions, your cookies.

Built for Claude Code on Windows. Claude can open a background tab, read a page, click, fill forms, scroll, press keys and take screenshots without taking over the tab you are using.

## How it works

```
Claude Code --stdio--> server.py --ws:7866--> relay.py <--ws:7865-- Opera extension --> your tabs
```

- **server.py** is the MCP server Claude talks to (Python, MCP SDK). It owns no port; it dials out to the relay and reconnects on its own if the relay restarts.
- **relay.py** is one long-running middleman that owns both ports, so several MCP clients (Claude Code, Claude Desktop) can share a single extension connection. Every message carries a request id, and the relay routes each response back to the client that asked. It sends a heartbeat every 20 s so the extension's Manifest V3 service worker never hits its 30 s idle timeout, and raises the WebSocket frame limit to 16 MB so screenshots fit.
- **extension/** is a Manifest V3 extension that runs the commands in the browser through the `tabs`, `scripting` and `debugger` APIs.

## Tools

| Tool | What it does |
|---|---|
| `ping` | Checks the whole chain is alive |
| `navigate` | Opens a URL in the working tab |
| `get_page_text` | Returns the page's text |
| `screenshot` | Captures the visible tab as a JPEG |
| `click` | Clicks a link or button by its accessible name |
| `fill` | Types into an input, textarea or rich-text editor by its accessible name |
| `scroll` | Scrolls to load lazy content: feeds, comments, "load more" |
| `press_key` | Presses a key, for example Enter to submit a search box after `fill` |
| `pin_new_tab` | Opens a background tab and points every tool at it, so your own tab is never touched |
| `pin_new_window` | Same, in a separate window; needed for screenshots |
| `unpin` | Goes back to acting on the focused tab |
| `close_tab` | Closes the pinned tab when the task is done |

`click` and `fill` find elements by accessible name (label, aria-label, placeholder, name) and look inside open shadow DOM.

## Setup (Windows)

You need Python 3.10+, Opera GX and Claude Code.

1. Install the server:
   ```
   cd server
   python -m venv .venv
   .venv\Scripts\pip install -r requirements.txt
   ```
2. Start the relay and leave it running:
   ```
   .venv\Scripts\python.exe relay.py
   ```
3. Load the extension: open `opera://extensions`, turn on Developer mode, click "Load unpacked" and choose the `extension` folder.
4. Register the server with Claude Code, using full paths:
   ```
   claude mcp add opera -- C:\path\to\server\.venv\Scripts\python.exe C:\path\to\server\server.py
   ```
5. Start a new Claude Code session and ask Claude to ping Opera. It should answer "pong from Opera GX".

If ping reports no extension after a reboot or a long idle, the extension's service worker went to sleep. Reload the extension at `opera://extensions`.

## Limits

Works well on normal, labelled inputs and buttons. It struggles with icon-only buttons that have no accessible name, editors that draw their placeholder with CSS, and sites that reject script-generated clicks (LinkedIn). It cannot reach closed shadow DOM or cross-origin iframes.

## Security

This drives your real browser as you: anything Claude does, it does with your logged-in accounts. The relay listens on localhost without authentication, so any program on your machine can send it commands while it runs. Use it only on a machine you trust, and stop the relay when you are not using it.
