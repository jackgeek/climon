import { readFileSync } from "node:fs";

interface StaticAsset {
  contentType: string;
  body: Buffer;
}

const assetSpecifiers: Record<string, { specifier: string; contentType: string; embeddedKey?: string }> = {
  "/assets/xterm.js": { specifier: "@xterm/xterm/lib/xterm.js", contentType: "text/javascript; charset=utf-8", embeddedKey: "XTERM_JS" },
  "/assets/xterm.css": { specifier: "@xterm/xterm/css/xterm.css", contentType: "text/css; charset=utf-8", embeddedKey: "XTERM_CSS" },
  "/assets/addon-fit.js": { specifier: "@xterm/addon-fit/lib/addon-fit.js", contentType: "text/javascript; charset=utf-8", embeddedKey: "ADDON_FIT_JS" }
};

// Try to load embedded assets (available in compiled binary).
let embedded: Record<string, Buffer> | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require("./embedded-assets.js");
  embedded = mod as Record<string, Buffer>;
} catch {
  // Not available — running from source; will fall back to node_modules.
}

const assetCache = new Map<string, StaticAsset>();

export function getStaticAsset(pathname: string): StaticAsset | undefined {
  const entry = assetSpecifiers[pathname];
  if (!entry) {
    return undefined;
  }
  const cached = assetCache.get(pathname);
  if (cached) {
    return cached;
  }
  try {
    let body: Buffer;
    if (embedded && entry.embeddedKey && embedded[entry.embeddedKey]) {
      body = embedded[entry.embeddedKey];
    } else {
      const resolved = Bun.resolveSync(entry.specifier, import.meta.dir);
      body = readFileSync(resolved) as Buffer;
    }
    const asset: StaticAsset = { contentType: entry.contentType, body };
    assetCache.set(pathname, asset);
    return asset;
  } catch {
    return undefined;
  }
}

export function renderDashboard(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>climon</title>
<link rel="stylesheet" href="/assets/xterm.css" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e6edf3; display: flex; height: 100vh; }
  #sidebar { width: 320px; min-width: 320px; border-right: 1px solid #30363d; overflow-y: auto; display: flex; flex-direction: column; }
  #sidebar-header { display: flex; align-items: center; justify-content: space-between; padding: 16px; border-bottom: 1px solid #30363d; }
  #sidebar-header h1 { font-size: 16px; margin: 0; }
  #new-session { background: transparent; border: 1px solid #30363d; color: #8b949e; border-radius: 4px; width: 26px; height: 26px; font-size: 18px; line-height: 1; cursor: pointer; display: flex; align-items: center; justify-content: center; padding: 0; }
  #new-session:hover { background: #21262d; color: #e6edf3; }
  .session { padding: 12px 16px; border-bottom: 1px solid #21262d; cursor: pointer; position: relative; }
  .session:hover { background: #161b22; }
  .session.active { background: #1f6feb33; }
  .session .cmd { font-family: ui-monospace, monospace; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-right: 20px; }
  .session .meta { font-size: 11px; color: #8b949e; margin-top: 4px; }
  .session .close { position: absolute; top: 8px; right: 8px; width: 18px; height: 18px; line-height: 16px; text-align: center; border-radius: 4px; color: #8b949e; font-size: 14px; display: none; border: none; background: transparent; cursor: pointer; padding: 0; }
  .session:hover .close { display: block; }
  .session .close:hover { background: #da363355; color: #ff7b72; }
  .badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px; text-transform: uppercase; letter-spacing: .5px; }
  .badge.running { background: #1f6feb33; color: #79c0ff; }
  .badge.needs-attention { background: #bb800933; color: #f2cc60; }
  .badge.completed { background: #23863633; color: #56d364; }
  .badge.failed { background: #da363333; color: #ff7b72; }
  .badge.disconnected { background: #6e768133; color: #8b949e; }
  #main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
  #header { padding: 12px 16px; border-bottom: 1px solid #30363d; font-family: ui-monospace, monospace; font-size: 13px; display: flex; align-items: center; gap: 12px; }
  #header-text { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #maximize { flex: none; border: 1px solid #30363d; background: #161b22; color: #e6edf3; border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; display: none; }
  #maximize:hover { background: #21262d; }
  #terminal { flex: 1; padding: 8px; min-height: 0; }
  #empty { color: #8b949e; }

  /* On narrow/mobile viewports the sidebar stacks above the terminal and the
     maximize button becomes available to give the terminal the full screen. */
  @media (max-width: 768px) {
    body { flex-direction: column; height: 100dvh; }
    #sidebar { width: 100%; min-width: 0; max-height: 40vh; border-right: none; border-bottom: 1px solid #30363d; }
    #maximize { display: block; }
  }

  /* Fullscreen terminal: hide all chrome and let the terminal fill the viewport. */
  body.maximized #sidebar { display: none; }
  body.maximized #header { display: none; }
  body.maximized #main { position: fixed; inset: 0; z-index: 10; background: #0d1117; }
  body.maximized #exit-maximize { display: block; }
  #exit-maximize { display: none; position: fixed; top: 8px; right: 8px; z-index: 20; border: 1px solid #30363d; background: #161b22cc; color: #e6edf3; border-radius: 6px; padding: 6px 10px; font-size: 13px; cursor: pointer; }
  #exit-maximize:hover { background: #21262d; }
  #modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.55); z-index: 30; align-items: center; justify-content: center; }
  #modal-backdrop.open { display: flex; }
  #modal { background: #161b22; border: 1px solid #30363d; border-radius: 8px; padding: 20px; width: 440px; max-width: 90vw; }
  #modal h2 { margin: 0 0 4px; font-size: 16px; }
  #modal label { display: block; font-size: 12px; color: #8b949e; margin: 14px 0 4px; }
  #modal input { width: 100%; padding: 8px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #e6edf3; font-family: ui-monospace, monospace; font-size: 13px; }
  #modal input:focus { outline: none; border-color: #1f6feb; }
  #modal-error { color: #ff7b72; font-size: 12px; margin-top: 12px; min-height: 16px; }
  #modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; }
  #modal-actions button { padding: 8px 14px; border-radius: 6px; font-size: 13px; cursor: pointer; border: 1px solid #30363d; }
  #modal-cancel { background: #21262d; color: #e6edf3; }
  #modal-create { background: #238636; color: #fff; border-color: #238636; }
  #modal-create:disabled { opacity: 0.6; cursor: default; }
</style>
</head>
<body>
  <div id="sidebar">
    <div id="sidebar-header"><h1>climon</h1><button id="new-session" title="New session">+</button></div>
    <div id="sessions"></div>
  </div>
  <div id="main">
    <div id="header"><span id="header-text"><span id="empty">Select a session</span></span><button id="maximize" title="Maximize terminal">&#9974; Maximize</button></div>
    <div id="terminal"></div>
  </div>
  <button id="exit-maximize" title="Exit fullscreen">&#10005; Exit</button>
  <div id="modal-backdrop">
    <div id="modal">
      <h2>New Session</h2>
      <label for="cmd-input">Command</label>
      <input id="cmd-input" type="text" placeholder="e.g. npm run dev" autocomplete="off" spellcheck="false" />
      <label for="cwd-input">Working directory (optional)</label>
      <input id="cwd-input" type="text" placeholder="Leave blank for server's working directory" autocomplete="off" spellcheck="false" />
      <div id="modal-error"></div>
      <div id="modal-actions">
        <button id="modal-cancel">Cancel</button>
        <button id="modal-create">Create</button>
      </div>
    </div>
  </div>
  <script src="/assets/xterm.js"></script>
  <script src="/assets/addon-fit.js"></script>
  <script>
  (function () {
    const Terminal = window.Terminal;
    const FitAddon = window.FitAddon.FitAddon;
    const sessionsEl = document.getElementById("sessions");
    const headerEl = document.getElementById("header-text");
    let term = null;
    let fit = null;
    let ws = null;
    let activeId = null;
    let sessions = [];
    let pendingSelectId = null;

    function ensureTerm() {
      if (term) return;
      term = new Terminal({ cursorBlink: true, fontFamily: "ui-monospace, monospace", fontSize: 13, theme: { background: "#0d1117" } });
      fit = new FitAddon();
      term.loadAddon(fit);
      term.open(document.getElementById("terminal"));
      fit.fit();
      window.addEventListener("resize", () => { try { fit.fit(); sendResize(); } catch (e) {} });
      // Register input handling exactly once; route to the current WebSocket.
      // (Registering this per-connection would duplicate every keystroke.)
      term.onData((data) => {
        if (ws && ws.readyState === 1) {
          ws.send(JSON.stringify({ type: "input", data: data }));
        }
      });
    }

    function sendResize() {
      if (ws && ws.readyState === 1 && term) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    }

    function refit() {
      if (!term || !fit) return;
      // Refit on the next frame so layout changes (e.g. toggling fullscreen)
      // are applied before xterm measures the available space.
      requestAnimationFrame(() => { try { fit.fit(); sendResize(); } catch (e) {} });
    }

    const maximizeBtn = document.getElementById("maximize");
    const exitMaximizeBtn = document.getElementById("exit-maximize");
    function setMaximized(on) {
      document.body.classList.toggle("maximized", on);
      refit();
    }
    maximizeBtn.addEventListener("click", () => setMaximized(true));
    exitMaximizeBtn.addEventListener("click", () => setMaximized(false));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && document.body.classList.contains("maximized")) setMaximized(false);
    });

    function closeWs() {
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    }

    async function selectSession(id) {
      activeId = id;
      renderSessions();
      ensureTerm();
      term.reset();
      closeWs();
      const session = sessions.find((s) => s.id === id);
      headerEl.textContent = session ? session.displayCommand : id;
      const live = session && (session.status === "running" || session.status === "needs-attention");
      if (live) {
        connectLive(id);
      } else {
        await loadScrollback(id);
      }
    }

    function connectLive(id) {
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const params = location.search || "";
      ws = new WebSocket(proto + "://" + location.host + "/api/sessions/" + id + "/attach" + params);
      ws.binaryType = "arraybuffer";
      ws.onopen = () => { fit.fit(); sendResize(); };
      ws.onmessage = (ev) => {
        if (typeof ev.data === "string") {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.type === "exit") {
              term.write("\\r\\n\\x1b[90m[session exited with code " + msg.exitCode + "]\\x1b[0m\\r\\n");
            } else if (msg.type === "size" && msg.cols && msg.rows) {
              // Authoritative PTY size from the daemon. When the host terminal
              // is smaller than this browser viewport, clamping caps the PTY to
              // the host size; match it here so both views show the same grid.
              if (term.cols !== msg.cols || term.rows !== msg.rows) {
                try { term.resize(msg.cols, msg.rows); } catch (e) {}
              }
            }
          } catch (e) {}
        } else {
          term.write(new Uint8Array(ev.data));
        }
      };
    }

    async function loadScrollback(id) {
      try {
        const res = await fetch("/api/sessions/" + id + "/scrollback" + (location.search || ""));
        if (res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          term.write(buf);
        } else {
          term.write("\\x1b[90m[no output captured]\\x1b[0m\\r\\n");
        }
      } catch (e) {
        term.write("\\x1b[90m[failed to load scrollback]\\x1b[0m\\r\\n");
      }
    }

    async function cleanupSession(id) {
      try {
        await fetch("/api/sessions/" + id + (location.search || ""), { method: "DELETE" });
      } catch (e) {}
      sessions = sessions.filter((s) => s.id !== id);
      if (activeId === id) {
        activeId = null;
        closeWs();
        if (term) { term.reset(); }
        headerEl.innerHTML = '<span id="empty">Select a session</span>';
      }
      renderSessions();
    }

    function renderSessions() {
      sessionsEl.innerHTML = "";
      for (const s of sessions) {
        const div = document.createElement("div");
        div.className = "session" + (s.id === activeId ? " active" : "");
        div.onclick = () => selectSession(s.id);
        const cmd = document.createElement("div");
        cmd.className = "cmd";
        cmd.textContent = s.displayCommand;
        const meta = document.createElement("div");
        meta.className = "meta";
        const badge = '<span class="badge ' + s.status + '">' + s.status + "</span>";
        meta.innerHTML = badge + " " + s.id;
        const close = document.createElement("button");
        close.className = "close";
        close.textContent = "\u00d7";
        close.title = "Clean up session";
        close.onclick = (ev) => { ev.stopPropagation(); cleanupSession(s.id); };
        div.appendChild(close);
        div.appendChild(cmd);
        div.appendChild(meta);
        sessionsEl.appendChild(div);
      }
    }

    function applySessions(list) {
      sessions = list;
      renderSessions();
      if (pendingSelectId && sessions.find((s) => s.id === pendingSelectId)) {
        const id = pendingSelectId;
        pendingSelectId = null;
        selectSession(id);
      } else if (!activeId && sessions.length > 0) {
        selectSession(sessions[0].id);
      }
    }

    const newSessionBtn = document.getElementById("new-session");
    const backdrop = document.getElementById("modal-backdrop");
    const cmdInput = document.getElementById("cmd-input");
    const cwdInput = document.getElementById("cwd-input");
    const modalError = document.getElementById("modal-error");
    const createBtn = document.getElementById("modal-create");
    const cancelBtn = document.getElementById("modal-cancel");

    function openModal() {
      modalError.textContent = "";
      cmdInput.value = "";
      cwdInput.value = "";
      createBtn.disabled = false;
      backdrop.classList.add("open");
      cmdInput.focus();
    }

    function closeModal() {
      backdrop.classList.remove("open");
    }

    async function createSession() {
      if (createBtn.disabled) return;
      const command = cmdInput.value.trim();
      if (!command) {
        modalError.textContent = "Command is required.";
        return;
      }
      createBtn.disabled = true;
      modalError.textContent = "";
      const body = { command: command };
      const cwd = cwdInput.value.trim();
      if (cwd) {
        body.cwd = cwd;
      }
      if (term) {
        body.cols = term.cols;
        body.rows = term.rows;
      }
      try {
        const res = await fetch("/api/sessions" + (location.search || ""), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) {
          const text = await res.text();
          modalError.textContent = text || ("Failed (" + res.status + ")");
          createBtn.disabled = false;
          return;
        }
        const data = await res.json();
        closeModal();
        const existing = sessions.find((s) => s.id === data.id);
        if (existing) {
          selectSession(data.id);
        } else {
          pendingSelectId = data.id;
        }
      } catch (e) {
        modalError.textContent = "Network error.";
        createBtn.disabled = false;
      }
    }

    newSessionBtn.addEventListener("click", openModal);
    cancelBtn.addEventListener("click", closeModal);
    createBtn.addEventListener("click", createSession);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) closeModal(); });
    cmdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") createSession(); });
    cwdInput.addEventListener("keydown", (e) => { if (e.key === "Enter") createSession(); });
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && backdrop.classList.contains("open")) closeModal();
    });

    const es = new EventSource("/api/events" + (location.search || ""));
    es.addEventListener("sessions", (ev) => {
      try { applySessions(JSON.parse(ev.data).sessions || []); } catch (e) {}
    });

    fetch("/api/sessions" + (location.search || ""))
      .then((r) => r.json())
      .then((d) => applySessions(d.sessions || []))
      .catch(() => {});
  })();
  </script>
</body>
</html>`;
}
