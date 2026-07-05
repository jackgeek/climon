# iOS PWA dev-tunnel re-authentication (fix the 3.1.0 "Session expired" loop)

**Date:** 2026-07-05
**Branch:** `fix/ios-pwa-tunnel-reauth`
**Status:** Design — pending implementation plan

## Problem

On iOS/iPadOS, opening the dashboard installed as a home-screen PWA over an
authenticated Microsoft dev tunnel ("Tunnel Link") shows a **"Session expired /
Your secure tunnel sign-in has expired…"** overlay that never resolves. The same
tunnel URL works fine in a desktop browser. The user reports this was introduced
in **3.1.0**.

### Root cause

Authenticated dev tunnels gate access on a `*.devtunnels.ms` sign-in **cookie**.
On iOS, a home-screen PWA runs in a **storage sandbox whose cookie jar is
isolated from Safari** (Apple privacy design; confirmed by WebKit's full
third-party cookie blocking). A dev-tunnel cookie can therefore only be used by
the PWA if it was acquired **inside the PWA's own window**.

Two changes combined to strand the PWA:

1. **2.4.1** (`fa81d6b`) changed the "Sign in again" action for a standalone PWA
   to open the tunnel URL in the **system browser (Safari)**
   (`reauthenticateTunnel` in `src/web/pwa/pwaContext.ts`), on the stated premise
   that "the resulting `*.devtunnels.ms` cookie is shared back with the PWA." On
   iOS that premise is **false** — Safari's cookie never reaches the PWA. (The
   change was made because an in-place navigation had produced an "empty file
   download" instead of the sign-in page.)
2. **3.1.0** (`895cf4d`) added a **cache-first service-worker app-shell** plus a
   **cold-start auth probe**. The PWA now boots from the cached shell and the
   probe immediately surfaces the "Session expired" overlay. Before 3.1.0 a cold
   launch performed a real network navigation that could complete the sign-in in
   the PWA's own context; the cache now prevents that, and the Safari button is a
   dead end — producing a permanent loop. Desktop is unaffected because it uses a
   single shared cookie jar.

## Goal

Restore working dev-tunnel (re-)authentication for the iOS home-screen PWA:
tapping "Sign in again" must complete the Microsoft sign-in **inside the PWA's
own window**, land the fresh cookie in the PWA's own jar, and reconnect — without
reintroducing the old "empty file download".

Non-goals: changing the tunnel's authenticated (non-anonymous) security model;
altering desktop-browser behavior beyond what falls out naturally; supporting a
native wrapper app.

## Design

The fix makes re-auth a **native, top-level network navigation inside the PWA
window**, bypassing both Safari and the 3.1.0 cache-first shell.

### 1. `reauthenticateTunnel` — navigate in place to a clean reauth URL

File: `src/web/pwa/pwaContext.ts`

- Remove the standalone `openBrowser(href)` branch and the `openBrowser` field
  from `TunnelReauthEnv`; the Safari path can never refresh the PWA's cookie on
  iOS.
- Both standalone and normal-browser cases perform an **in-place navigation** to
  a clean reauth URL derived from the current origin:

  ```
  reauthUrl = `${origin}/?reauth=1`
  ```

  Deliberately **omit** the `X-Tunnel-Skip-AntiPhishing-Page` query param so the
  relay serves its normal, renderable interactive sign-in / anti-phishing HTML
  page (which displays in the PWA) instead of the blank programmatic response
  that a standalone webview downloaded as an "empty file".
- Update the function/interface doc comment to state the correct iOS behavior
  (re-auth happens inside the PWA's own window; Safari's cookie is not shared).
- Provide the origin/URL to the function (via env or a small pure helper
  `buildTunnelReauthUrl(origin)`) so it remains DOM-free and unit-testable.

### 2. Service worker — pass through the reauth navigation

Files: `src/web/pwa/swCache.ts` (`chooseCacheStrategy`), `src/web/sw.ts`

- Extend the `chooseCacheStrategy` request shape with the request URL's search
  string (or a parsed `reauth` boolean) and return **`passthrough`** for a
  `navigate` request that carries `reauth=1`.
- Rationale: a service worker cannot follow a **cross-origin** auth redirect for
  a navigation it answers via `respondWith`. Passthrough lets the browser perform
  a native top-level navigation that follows the relay → Microsoft → relay
  redirect chain and renders the sign-in page in the PWA's own context. Once
  authenticated, the return navigation to `/?reauth=1` fetches the real shell
  fresh from the network.
- Normal cold launches use `start_url: "/"` (no `reauth` marker) and keep the
  existing cache-first boot behavior unchanged.

### 3. `App.tsx` — wire the new reauth call and clean the URL

File: `src/web/App.tsx`

- Update the `TunnelReauthOverlay` `onReauth` handler to call the simplified
  `reauthenticateTunnel` (no `openBrowser`).
- Keep the cold-start probe and overlay logic as-is (they correctly surface the
  overlay when auth is required and the live connection is not up).
- After a successful server connection, if the URL still carries `?reauth=1`,
  strip it via `history.replaceState` so the marker does not linger.

### 4. Documentation

- `src/web/pwa/pwaContext.ts`: correct the misleading comment.
- `docs/security.md` (~L259): update the PWA re-auth description — the prompt now
  performs an in-place top-level navigation inside the PWA to re-run the
  Microsoft sign-in, rather than opening the system browser.
- `docs/manual-tests/dev-tunnel-reauth.md`: update DTR-01 and DTR-03 expected
  results — "Sign in again" signs in **inside the PWA window** (not the system
  browser); on return the live connection reconnects. Refresh the feature
  description/citations accordingly. Keep DTR-02 (server outage) and DTR-04
  (cache self-heal) as-is.

## Data flow (re-auth, iOS standalone)

1. Cold launch → SW serves cached shell → app boots → cold-start probe hits
   `/health` → classified `auth-required` → "Session expired" overlay.
2. User taps **Sign in again** → `reauthenticateTunnel` navigates the PWA window
   in place to `${origin}/?reauth=1`.
3. SW sees a `navigate` request with `reauth=1` → **passthrough** → browser does a
   native network navigation.
4. Relay (unauthenticated) serves the interactive sign-in/interstitial HTML →
   renders in the PWA → user completes Microsoft sign-in → cookie is stored in the
   **PWA's own jar**.
5. Relay redirects back to `${origin}/?reauth=1` → now authenticated → real HTML
   shell returned (still passthrough) → app boots with a valid cookie → EventSource
   connects → overlay cleared → `?reauth=1` stripped from the URL.

## Testing

- `tests/pwa-context.test.ts`: `reauthenticateTunnel` now performs an in-place
  navigation to the clean `${origin}/?reauth=1` URL for **both** standalone and
  normal-browser cases; assert the `X-Tunnel-Skip-AntiPhishing-Page` param is
  absent. Update the removed-`openBrowser` expectations. Add a
  `buildTunnelReauthUrl` unit test if that helper is introduced.
- `tests/sw-cache.test.ts`: `chooseCacheStrategy` returns `passthrough` for a
  `navigate` request carrying `reauth=1`, and still returns `navigation` for a
  normal navigate and `asset`/`passthrough` for the existing cases.
- Run the focused suites: `bun test tests/pwa-context.test.ts tests/sw-cache.test.ts`.
- Type-check: `bun run typecheck`.

## Manual verification (required — device-dependent)

The iOS standalone interstitial/redirect rendering is the historical unknown, so
this fix is **not complete until verified on an iOS/iPadOS device**:

1. Install the dashboard as a home-screen PWA from an authenticated Tunnel Link
   URL and sign in once (connects normally).
2. Expire the PWA's tunnel sign-in (clear the PWA's `*.devtunnels.ms` cookie or
   wait for natural expiry).
3. Cold-launch the PWA → confirm it boots and shows "Session expired".
4. Tap **Sign in again** → confirm the Microsoft sign-in renders **inside the PWA
   window** (no empty-file download, no jump to Safari), complete it, and confirm
   the PWA reconnects with the overlay gone.

## Risks

- If the relay still returns a non-renderable response for the clean in-PWA
  navigation on iOS, the empty-file symptom could recur. Mitigation is the clean
  (no anti-phishing-skip) URL; fallback would be Approach B (honest guidance
  message) if device testing shows the in-PWA flow cannot render.
