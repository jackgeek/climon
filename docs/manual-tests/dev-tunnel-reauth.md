# Dev tunnel re-authentication (PWA)

Manual checks for the in-app dev-tunnel sign-in recovery flow.

## DTR-01 — Expired tunnel session shows an in-app sign-in prompt

- **ID:** DTR-01
- **Feature / phase:** Dev tunnel re-authentication (PWA) — in-app dev tunnel
  re-authentication (`src/web/api.ts` probe, `TunnelReauthOverlay`).
- **Preconditions:** An authenticated (non-anonymous) dashboard dev tunnel is
  running (climon "Tunnel Link" started; tunnel is **not** anonymous). The
  dashboard is installed as a PWA on iOS/iPadOS (Safari → Share → Add to Home
  Screen) from the dev-tunnel URL, and you have signed in once so the dashboard
  loads normally.
- **Config-matrix cell:** Remote / dev-tunnel, iOS PWA standalone
- **Platforms:** iOS/iPadOS PWA (primary); Android/desktop installed PWA
  (secondary)

**Steps:**
1. Open the installed PWA and confirm the dashboard is connected (sessions list
   loads, no spinner).
2. Force the tunnel sign-in to expire: in desktop Safari, sign out of the dev
   tunnel / clear `*.devtunnels.ms` cookies for the account, OR leave the PWA
   until the Microsoft session naturally expires.
3. Return to the PWA (foreground it) and wait for the live connection to drop.
4. Observe the overlay that appears.
5. Tap **Sign in again**.
6. Complete the Microsoft sign-in in the sheet that appears.

**Expected:** After steps 3-4 the PWA shows the **"Session expired"** overlay
with a **"Sign in again"** button (it appears promptly, without waiting out the
~60s reconnect timer). Tapping the button performs a top-level navigation; iOS
presents the Microsoft sign-in. After signing in, the PWA returns to a freshly
loaded dashboard, the overlay is gone, and the sessions list/terminal reconnect
— without ever leaving the PWA to open the tunnel URL manually.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTR-02 — Server outage still shows the generic reconnect overlay (no false sign-in prompt)

- **ID:** DTR-02
- **Feature / phase:** Dev tunnel re-authentication (PWA) — probe
  classification (`classifyTunnelAuthResponse` → `unreachable`).
- **Preconditions:** Same authenticated dev tunnel + iOS PWA as DTR-01,
  currently connected.
- **Config-matrix cell:** Remote / dev-tunnel, iOS PWA standalone
- **Platforms:** iOS/iPadOS PWA

**Steps:**
1. With the PWA connected, stop the local climon dashboard server (leave the
   tunnel relay up).
2. Return to the PWA and wait for the connection to drop.

**Expected:** The PWA shows the normal **"Reconnecting"** overlay, **not** the
"Session expired" prompt; when the server comes back it reconnects
automatically.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
