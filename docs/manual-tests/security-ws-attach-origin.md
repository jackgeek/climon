# WebSocket attach Origin validation

Manual checks for the dashboard server's WebSocket attach upgrade guard, which
requires same-origin browser requests and an allowed dashboard `Host`.

## WSAO-1 — Cross-site WebSocket attach is rejected

- **ID:** WSAO-1
- **Feature / phase:** Security — WebSocket attach Origin validation
  (`/api/sessions/:id/attach`).
- **Preconditions:** Start a live climon session and the dashboard server. Note
  the dashboard port and the session id from the dashboard URL or session list.
  Have one normal dashboard tab open at `http://127.0.0.1:<port>/`.
- **Config-matrix cell:** Access = loopback dashboard plus hostile different
  origin (`file://` scratch page or `http://localhost:9999`).
- **Platforms:** Desktop Chrome, Firefox, Safari.

**Steps:**
1. From a different origin, open a scratch `file://` HTML page or serve one from
   `http://localhost:9999`.
2. In that page's devtools console, run
   `new WebSocket("ws://127.0.0.1:<port>/api/sessions/<id>/attach")`, replacing
   `<port>` and `<id>` with the live dashboard values.
3. Observe the WebSocket connection state and network entry.
4. In the real dashboard tab at `http://127.0.0.1:<port>/`, open the same
   session terminal.
5. If a Tunnel Link is active, open the `https://<id>-<port>.<region>.devtunnels.ms/`
   dashboard URL and attach to the same session from that tunnel viewer.

**Expected:** The different-origin WebSocket upgrade is rejected with HTTP 403
(or closes without completing the WebSocket handshake), and the hostile page
receives no terminal output frames and cannot send input. The real loopback
dashboard tab still attaches normally. The dev-tunnel dashboard viewer also
attaches normally when opened from the tunnel origin.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
