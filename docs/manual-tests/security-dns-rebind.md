# Security DNS-rebinding guard for dashboard reads and delete

Manual checks for the dashboard allowed-Host guard on session reads, scrollback,
SSE, terminal attach, and destructive session cleanup.

## SDR-01 — Rebinding Host is rejected on read and destructive endpoints

- **ID:** SDR-01
- **Feature / phase:** Security — DNS-rebinding guard for dashboard read/delete
  endpoints.
- **Preconditions:** Start the dashboard locally and note its port (for example,
  `PORT=3131`). Have at least one session id available as `SESSION_ID`; a
  completed session with scrollback is best for the scrollback check; a live
  session is best for the attach compatibility check.
- **Config-matrix cell:** Local dashboard / loopback / hostile Host header.
- **Platforms:** macOS, Linux, Windows/WSL.

**Steps:**
1. Run `curl -i -H "Host: evil.com:$PORT" "http://127.0.0.1:$PORT/api/sessions"`.
2. Run `curl -i -H "Host: evil.com:$PORT" "http://127.0.0.1:$PORT/api/sessions/$SESSION_ID/scrollback"`.
3. Run `curl -i -N -H "Host: evil.com:$PORT" "http://127.0.0.1:$PORT/api/events"`.
4. Run `curl -i -H "Host: evil.com:$PORT" "http://127.0.0.1:$PORT/api/sessions/$SESSION_ID/attach"`.
5. Run `curl -i -X DELETE -H "Host: evil.com:$PORT" "http://127.0.0.1:$PORT/api/sessions/$SESSION_ID?kill=none"`.
6. Confirm the session still exists in the dashboard or with a normal loopback
   `GET /api/sessions` request.

**Expected:** Every hostile-Host request returns HTTP 403 before any session JSON,
scrollback bytes, SSE stream, WebSocket upgrade, or delete side effect is
produced. The session still exists after the DELETE attempt.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## SDR-02 — Legitimate loopback and dev-tunnel Hosts still work

- **ID:** SDR-02
- **Feature / phase:** Security — allowed dashboard Host compatibility.
- **Preconditions:** Local dashboard running on `PORT`; optional active Tunnel
  Link / Microsoft dev tunnel URL.
- **Config-matrix cell:** Local dashboard / loopback and dev-tunnel Host.
- **Platforms:** macOS, Linux, Windows/WSL; mobile/desktop browser over dev tunnel.

**Steps:**
1. Run `curl -i -H "Host: 127.0.0.1:$PORT" "http://127.0.0.1:$PORT/api/sessions"`.
2. If a Tunnel Link is active, open the dashboard through the `*.devtunnels.ms`
   URL and confirm the session list, SSE updates, and terminal attach still load.
3. Optionally, from the local machine, run
   `curl -i -H "Host: x-3131.uks1.devtunnels.ms" "http://127.0.0.1:$PORT/api/sessions"`
   to exercise the same Host suffix without traversing the tunnel.

**Expected:** Loopback Host access succeeds. Dev-tunnel Host access also succeeds
for the session list/SSE/terminal flow; only non-loopback, non-`*.devtunnels.ms`
Hosts are rejected.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
