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

## DTR-04 — PWA self-heals a stale/broken cached app bundle over the tunnel

- **ID:** DTR-04
- **Feature / phase:** Dev tunnel app-shell cache recovery — mutable code assets
  are served `Cache-Control: no-cache`, the service worker fetches assets with
  `cache: "no-store"` (true network-first), it trusts a redirected-but-valid
  bundle, and a `CACHE_NAME` bump purges a poisoned cache
  (`src/server/assets.ts` cache-control, `src/web/sw.ts` `assetResponse`,
  `src/web/pwa/swCache.ts` `shouldCacheAssetResponse` / `CACHE_NAME` /
  `isStaleCacheName`).
- **Preconditions:** An authenticated (non-anonymous) dashboard dev tunnel is
  running and the dashboard is installed as a PWA from the dev-tunnel URL and has
  been opened once while signed in (so the service worker cached `/assets/app.js`).
- **Config-matrix cell:** Remote / dev-tunnel, installed PWA standalone
- **Platforms:** iOS/iPadOS PWA (primary); Android/desktop installed PWA (secondary)

**Steps:**
1. Confirm the server sends `Cache-Control: no-cache` for `/assets/app.js`,
   `/sw.js`, `/manifest.webmanifest` and `/` (e.g. `curl -sI <url>/assets/app.js`).
2. While the PWA is open and signed in, deploy a new server build whose
   `/assets/app.js` differs from the copy the PWA has cached (any visible change
   is enough — e.g. a new build after a code edit).
3. Reload the PWA (pull-to-refresh) while still signed in to the tunnel —
   **without** clearing any browsing data.

**Expected:** The reloaded PWA runs the **new** bundle, not the previously cached
one, and **without** having to clear the browser's data. Because the assets are
served `no-cache` and the service worker fetches them with `cache: "no-store"`,
the browser's HTTP disk cache can no longer mask a new build; the SW then caches
the redirected-but-valid JS response, and (when `CACHE_NAME` is bumped) its
`activate` step deletes the previous `climon-shell-*` cache so a poisoned/broken
bundle is discarded rather than served forever. The dashboard loads without a
JavaScript console error.

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
