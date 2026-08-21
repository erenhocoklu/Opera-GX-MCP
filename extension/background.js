const WS_URL = "ws://localhost:7865";
let ws = null;

function connect() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => {
    console.log("[opera-mcp] connected to server");
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "heartbeat") return;   // keepalive from relay, ignore
    console.log("[opera-mcp] received:", msg);
    handleCommand(msg);
  };

  ws.onclose = () => {
    console.log("[opera-mcp] disconnected, reconnecting in 2s...");
    ws = null;
    setTimeout(connect, 2000);
  };

  ws.onerror = (err) => {
    console.error("[opera-mcp] ws error:", err);
    ws.close();
  };
}

function clickByName(target) {
  const wanted = target.trim().toLowerCase();

  // Recursively collect matches across the light DOM AND every OPEN shadow root.
  // Web components hide their real elements inside shadow roots, which a plain
  // document.querySelectorAll never sees. Closed shadow roots (mode: "closed")
  // expose no .shadowRoot and cannot be pierced by anyone, us included.
  function deepQueryAll(selector, root) {
    const out = [];
    const visit = (node) => {
      let matches;
      try { matches = node.querySelectorAll(selector); } catch (e) { matches = []; }
      matches.forEach((el) => out.push(el));
      const all = node.querySelectorAll ? node.querySelectorAll("*") : [];
      all.forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(root || document);
    return out;
  }

  const candidates = deepQueryAll(
    'a, button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"]',
    document
  );

  const accName = (el) =>
    (el.getAttribute("aria-label") ||
      el.getAttribute("title") ||
      el.value ||
      el.innerText ||
      el.textContent ||
      "").trim();

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const els = candidates.filter(visible);

  let match = els.find((el) => accName(el).toLowerCase() === wanted);
  if (!match) match = els.find((el) => accName(el).toLowerCase().includes(wanted));

  if (!match) return { clicked: false, reason: 'no clickable element matching "' + target + '"' };

  // Fire a real pointer + mouse sequence, not just element.click(). Many modern
  // UIs (LinkedIn's composer, custom menus) open on pointerdown/mousedown and
  // ignore a bare scripted click. End with a native click() for default actions.
  match.focus();
  const evOpts = { bubbles: true, cancelable: true, view: window };
  const ptrOpts = { bubbles: true, cancelable: true, view: window, pointerId: 1, isPrimary: true };
  try {
    match.dispatchEvent(new PointerEvent("pointerdown", ptrOpts));
    match.dispatchEvent(new MouseEvent("mousedown", evOpts));
    match.dispatchEvent(new PointerEvent("pointerup", ptrOpts));
    match.dispatchEvent(new MouseEvent("mouseup", evOpts));
  } catch (e) { /* PointerEvent unsupported - the native click below still fires */ }
  match.click();
  return { clicked: true, name: accName(match) };
}

function fillByName(target, value) {
  const wanted = target.trim().toLowerCase();

  // Recursively collect matches across the light DOM AND every OPEN shadow root
  // (web components hide inputs inside shadow roots; document.querySelectorAll
  // misses them). Closed shadow roots expose no .shadowRoot and can't be pierced.
  function deepQueryAll(selector, root) {
    const out = [];
    const visit = (node) => {
      let matches;
      try { matches = node.querySelectorAll(selector); } catch (e) { matches = []; }
      matches.forEach((el) => out.push(el));
      const all = node.querySelectorAll ? node.querySelectorAll("*") : [];
      all.forEach((el) => { if (el.shadowRoot) visit(el.shadowRoot); });
    };
    visit(root || document);
    return out;
  }

  // Text-like inputs, textareas, AND rich-text editors (contenteditable /
  // role=textbox - how LinkedIn and Reddit build their post bodies). A bare
  // <input> with no type attribute defaults to "text", so treat a missing type
  // as fillable.
  const TEXT_TYPES = ["text", "email", "search", "password", "tel", "url", "number"];
  const inputs = deepQueryAll("input, textarea", document).filter((el) => {
    if (el.tagName === "TEXTAREA") return true;
    const t = (el.getAttribute("type") || "text").toLowerCase();
    return TEXT_TYPES.includes(t);
  });
  const editables = deepQueryAll('[contenteditable="true"], [contenteditable=""], [role="textbox"]', document);
  const candidates = inputs.concat(editables);

  // Accessible name for a form field. Inputs have no innerText, so resolve the
  // label through the standard priority chain, first non-empty wins:
  //   1. <label for="id">   2. wrapping <label>   3. aria-label
  //   4. aria-labelledby    5. placeholder        6. name attribute
  const accName = (el) => {
    // Resolve label lookups within the element's OWN tree (document or its
    // shadow root) via getRootNode, so a shadow-DOM input finds its own label
    // and does not collide with a same-id element in the main document.
    const root = el.getRootNode();
    const q = (sel) => (root.querySelector ? root.querySelector(sel) : null);
    if (el.id) {
      const lbl = q('label[for="' + CSS.escape(el.id) + '"]');
      if (lbl && lbl.innerText.trim()) return lbl.innerText.trim();
    }
    const wrap = el.closest("label");
    if (wrap && wrap.innerText.trim()) return wrap.innerText.trim();
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim()) return aria.trim();
    const labelledby = el.getAttribute("aria-labelledby");
    if (labelledby) {
      const text = labelledby.split(/\s+/)
        .map((refId) => { const r = q('#' + CSS.escape(refId)); return r ? r.innerText.trim() : ""; })
        .filter(Boolean).join(" ");
      if (text) return text;
    }
    const ariaPh = el.getAttribute("aria-placeholder");
    if (ariaPh && ariaPh.trim()) return ariaPh.trim();
    const ph = el.getAttribute("placeholder");
    if (ph && ph.trim()) return ph.trim();
    const dph = el.getAttribute("data-placeholder");
    if (dph && dph.trim()) return dph.trim();
    const nm = el.getAttribute("name");
    if (nm && nm.trim()) return nm.trim();
    // Last resort for rich editors (ProseMirror / Lexical, e.g. ChatGPT): the
    // placeholder text often sits on a CHILD node, not the editable element.
    const childPh = el.querySelector && el.querySelector("[data-placeholder], [aria-placeholder]");
    if (childPh) {
      const t = (childPh.getAttribute("data-placeholder") || childPh.getAttribute("aria-placeholder") || "").trim();
      if (t) return t;
    }
    return "";
  };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  const els = candidates.filter(visible);

  // Same match policy as clickByName: exact name first, then substring.
  let match = els.find((el) => accName(el).toLowerCase() === wanted);
  if (!match) match = els.find((el) => accName(el).toLowerCase().includes(wanted));

  if (!match) return { filled: false, reason: 'no fillable field matching "' + target + '"' };

  const isEditable = match.isContentEditable || match.getAttribute("role") === "textbox";

  if (isEditable) {
    // Rich-text editor (Draft.js / Lexical / ProseMirror - LinkedIn, Reddit).
    // Setting textContent alone is ignored by these editors; execCommand
    // "insertText" inserts as if typed and fires the beforeinput/input events
    // they actually listen for. textContent is only a last-resort fallback.
    match.focus();
    let ok = false;
    try { ok = document.execCommand("insertText", false, value); } catch (e) { ok = false; }
    if (!ok) match.textContent = value;
    match.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    return { filled: true, name: accName(match) };
  }

  // React-safe value set for <input>/<textarea>. el.value = x is ignored/wiped
  // by React's controlled inputs. Call the NATIVE prototype setter (bypassing
  // React's per-instance override), then fire bubbling input + change.
  const proto = match.tagName === "TEXTAREA"
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value").set;

  match.focus();
  nativeSetter.call(match, value);
  match.dispatchEvent(new Event("input", { bubbles: true }));
  match.dispatchEvent(new Event("change", { bubbles: true }));

  return { filled: true, name: accName(match) };
}

// M9 pinned target. When set, tools act on THIS tab instead of the focused one,
// so Claude can drive a background tab / separate window while you keep working.
let pinnedTabId = null;
let pinnedWindowId = null;

// Resolves the tab tools should act on: the pinned tab if set and still alive,
// otherwise the focused window's active tab. If the pinned tab was closed, it
// silently forgets the pin and falls back to the active tab.

function withTargetTab(cb) {
  if (pinnedTabId !== null) {
    chrome.tabs.get(pinnedTabId, (tab) => {
      if (chrome.runtime.lastError || !tab) {
        pinnedTabId = null;
        pinnedWindowId = null;
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => cb(tabs[0] || null));
      } else {
        cb(tab);
      }
    });
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => cb(tabs[0] || null));
  }
}

function handleCommand(msg) {
  const { id, action, params } = msg;

  if (action === "ping") {
    sendResponse(id, "pong from Opera GX");

  } else if (action === "pin_new_tab") {
    chrome.tabs.create({ url: (params && params.url) || "about:blank", active: false }, (tab) => {
      pinnedTabId = tab.id;
      pinnedWindowId = tab.windowId;
      sendResponse(id, "pinned new background tab " + tab.id + " in current window");
    });

  } else if (action === "pin_new_window") {
    chrome.windows.create({ url: (params && params.url) || "about:blank", focused: false }, (win) => {
      const tab = win.tabs[0];
      pinnedTabId = tab.id;
      pinnedWindowId = win.id;
      sendResponse(id, "pinned tab " + tab.id + " in new window " + win.id);
    });

  } else if (action === "unpin") {
    pinnedTabId = null;
    pinnedWindowId = null;
    sendResponse(id, "unpinned - tools now act on the focused tab");

  } else if (action === "close_tab") {
    if (pinnedTabId === null) {
      sendResponse(id, null, "no pinned tab to close");
    } else {
      const tabToClose = pinnedTabId;
      chrome.tabs.remove(tabToClose, () => {
        pinnedTabId = null;
        pinnedWindowId = null;
        if (chrome.runtime.lastError) {
          sendResponse(id, null, chrome.runtime.lastError.message);
        } else {
          sendResponse(id, "closed tab " + tabToClose + " and cleared pin");
        }
      });
    }

  } else if (action === "navigate") {
    withTargetTab((tab) => {
      if (tab) {
        chrome.tabs.update(tab.id, { url: params.url }, () => {
          sendResponse(id, "navigated to " + params.url);
        });
      } else {
        sendResponse(id, null, "no target tab found");
      }
    });

  } else if (action === "get_page_text") {
    withTargetTab((tab) => {
      if (tab) {
        chrome.scripting.executeScript(
          {
            target: { tabId: tab.id },
            func: () => document.body.innerText
          },
          (results) => {
            if (results && results[0]) {
              sendResponse(id, results[0].result);
            } else {
              sendResponse(id, null, "could not read page text");
            }
          }
        );
      } else {
        sendResponse(id, null, "no target tab found");
      }
    });

  } else if (action === "screenshot") {
    withTargetTab((tab) => {
      if (!tab) { sendResponse(id, null, "no target tab found"); return; }
      const dbg = { tabId: tab.id };
      // Attach the DevTools debugger to THIS tab, ask its renderer to draw a
      // frame directly (works even when the tab is hidden/background), then
      // detach. Fall back to captureVisibleTab if the debugger can't attach.
      chrome.debugger.attach(dbg, "1.3", () => {
        if (chrome.runtime.lastError) {
          const winId = pinnedWindowId !== null ? pinnedWindowId : null;
          chrome.tabs.captureVisibleTab(winId, { format: "jpeg", quality: 80 }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
              sendResponse(id, null, (chrome.runtime.lastError && chrome.runtime.lastError.message) || "capture failed");
            } else {
              sendResponse(id, dataUrl);
            }
          });
          return;
        }
        // Tell the page it is focused + active so visibility-gated apps render
        // their content even though the tab is in the background, then give the
        // app a moment to redraw before we capture.
        chrome.debugger.sendCommand(dbg, "Emulation.setFocusEmulationEnabled", { enabled: true }, () => {
          setTimeout(() => {
            chrome.debugger.sendCommand(dbg, "Page.captureScreenshot", { format: "jpeg", quality: 80 }, (result) => {
              const err = chrome.runtime.lastError ? chrome.runtime.lastError.message : null;
              chrome.debugger.detach(dbg, () => {
                if (err || !result || !result.data) {
                  sendResponse(id, null, err || "capture failed");
                } else {
                  sendResponse(id, "data:image/jpeg;base64," + result.data);
                }
              });
            });
          }, 500);
        });
      });
    });
	
  } else if (action === "click") {
    withTargetTab((tab) => {
      if (!tab) { sendResponse(id, null, "no target tab found"); return; }
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: clickByName,
          args: [params.target]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse(id, null, chrome.runtime.lastError.message);
          } else if (results && results[0] && results[0].result) {
            const r = results[0].result;
            if (r.clicked) sendResponse(id, r.name);
            else sendResponse(id, null, r.reason);
          } else {
            sendResponse(id, null, "click failed");
          }
        }
      );
    });

  } else if (action === "fill") {
    withTargetTab((tab) => {
      if (!tab) { sendResponse(id, null, "no target tab found"); return; }
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: fillByName,
          args: [params.target, params.value]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse(id, null, chrome.runtime.lastError.message);
          } else if (results && results[0] && results[0].result) {
            const r = results[0].result;
            if (r.filled) sendResponse(id, r.name);
            else sendResponse(id, null, r.reason);
          } else {
            sendResponse(id, null, "fill failed");
          }
        }
      );
    });

  } else if (action === "scroll") {
    withTargetTab((tab) => {
      if (!tab) { sendResponse(id, null, "no target tab found"); return; }
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: (direction, amount) => {
            const step = amount && amount > 0 ? amount : Math.round(window.innerHeight * 0.9);
            if (direction === "top") window.scrollTo(0, 0);
            else if (direction === "bottom") window.scrollTo(0, document.body.scrollHeight);
            else if (direction === "up") window.scrollBy(0, -step);
            else window.scrollBy(0, step);
            return {
              y: Math.round(window.scrollY),
              height: Math.round(document.body.scrollHeight),
              viewport: Math.round(window.innerHeight)
            };
          },
          args: [params.direction || "down", params.amount || 0]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse(id, null, chrome.runtime.lastError.message);
          } else if (results && results[0] && results[0].result) {
            const r = results[0].result;
            const atBottom = r.y + r.viewport >= r.height - 2;
            sendResponse(id, "scrolled " + (params.direction || "down") + " - y=" + r.y + "/" + r.height + (atBottom ? " (bottom)" : ""));
          } else {
            sendResponse(id, null, "scroll failed");
          }
        }
      );
    });

  } else if (action === "press_key") {
    withTargetTab((tab) => {
      if (!tab) { sendResponse(id, null, "no target tab found"); return; }
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: (key) => {
            const el = document.activeElement || document.body;
            const legacy = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, " ": 32 };
            const kc = legacy[key] || (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
            const opts = { key: key, code: key === " " ? "Space" : key, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true };
            el.dispatchEvent(new KeyboardEvent("keydown", opts));
            el.dispatchEvent(new KeyboardEvent("keypress", opts));
            el.dispatchEvent(new KeyboardEvent("keyup", opts));
            return { key: key, on: el.tagName + (el.id ? "#" + el.id : "") };
          },
          args: [params.key || "Enter"]
        },
        (results) => {
          if (chrome.runtime.lastError) {
            sendResponse(id, null, chrome.runtime.lastError.message);
          } else if (results && results[0] && results[0].result) {
            const r = results[0].result;
            sendResponse(id, "pressed " + r.key + " on " + r.on);
          } else {
            sendResponse(id, null, "press_key failed");
          }
        }
      );
    });

  } else {
    sendResponse(id, null, "unknown action: " + action);
  }
}

function sendResponse(id, data, error) {
  if (!ws) return;
  const response = { id };
  if (error) {
    response.error = error;
  } else {
    response.data = data;
  }
  ws.send(JSON.stringify(response));
}

connect();