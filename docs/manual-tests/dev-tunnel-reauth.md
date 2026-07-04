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
6. Complete the Microsoft sign-in in the system browser tab that opens, then
   foreground the PWA again.

**Expected:** After steps 3-4 the PWA shows the **"Session expired"** overlay
with a **"Sign in again"** button (it appears promptly, without waiting out the
~60s reconnect timer). Tapping the button opens the tunnel URL in the **system
browser** (a real Safari/Chrome tab), not inside the standalone PWA window — so
the Microsoft sign-in loads normally instead of downloading an empty file.
Complete the sign-in there, then return to the PWA: its live connection
reconnects, the overlay is gone, and the sessions list/terminal come back — no
need to manually copy the tunnel URL into a browser.

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

---

## DTR-03 — Cold-launch PWA with an expired tunnel session boots and prompts sign-in

- **ID:** DTR-03
- **Feature / phase:** Dev tunnel initial authentication (PWA cold start) —
  service-worker app-shell cache (`src/web/sw.ts`, `src/web/pwa/swCache.ts`) plus the
  startup `probeTunnelAuth` in `src/web/App.tsx`.
- **Preconditions:** An authenticated (non-anonymous) dashboard dev tunnel is running
  (climon "Tunnel Link" started; tunnel is **not** anonymous). The dashboard is
  installed as a PWA from the dev-tunnel URL, and you have opened it once while signed
  in (so the service worker registered and cached the app shell).
- **Config-matrix cell:** Remote / dev-tunnel, installed PWA standalone
- **Platforms:** iOS/iPadOS PWA; Android installed PWA; desktop installed PWA
  (Chrome/Edge)

**Steps:**
1. Fully close the installed PWA (swipe it away / quit it — not just background it).
2. Expire the tunnel sign-in: in a desktop browser, sign out of the dev tunnel / clear
   `*.devtunnels.ms` cookies for the account, OR leave it until the Microsoft session
   naturally expires.
3. Cold-launch the installed PWA from the home screen / app launcher.

**Expected:** The PWA **boots** (the dashboard shell renders from the service-worker
cache) instead of showing a blank page or downloading an empty file. It then shows the
**"Session expired"** overlay with a **"Sign in again"** button. Tapping the button
opens the tunnel URL in the **system browser** (a real tab), where the Microsoft
sign-in loads normally. Complete the sign-in there, then return to the PWA: its live
connection reconnects, the overlay disappears, and the sessions list/terminal load —
no need to manually copy the tunnel URL into a browser.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
