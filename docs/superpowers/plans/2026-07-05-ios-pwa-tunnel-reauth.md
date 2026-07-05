# iOS PWA dev-tunnel re-authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the iOS home-screen PWA "Session expired" loop by making dev-tunnel re-auth a native top-level navigation inside the PWA window (bypassing Safari and the service-worker cached shell).

**Architecture:** "Sign in again" navigates the PWA in place to a clean `${origin}/?reauth=1` URL (no anti-phishing-skip param). The service worker passes through any `navigate` request carrying `reauth=1` instead of serving the cached shell, so the browser follows the cross-origin Microsoft redirect and the fresh `*.devtunnels.ms` cookie lands in the PWA's own cookie jar.

**Tech Stack:** TypeScript (Bun ESM), React 19, `bun:test`. Web dashboard under `src/web/`.

**Spec:** `docs/superpowers/specs/2026-07-05-ios-pwa-tunnel-reauth-design.md`

---

## File structure

- `src/web/pwa/swCache.ts` — owns the reauth marker (`REAUTH_PARAM`, `isReauthNavigation`) and the `chooseCacheStrategy` passthrough decision.
- `src/web/pwa/pwaContext.ts` — `reauthenticateTunnel` + `buildTunnelReauthUrl`; simplified `TunnelReauthEnv` (no Safari `openBrowser`).
- `src/web/sw.ts` — passes the request search string into `chooseCacheStrategy`.
- `src/web/App.tsx` — updated `onReauth` wiring; strips `?reauth=1` after connect.
- `tests/sw-cache.test.ts`, `tests/pwa-context.test.ts` — unit tests.
- `docs/security.md`, `docs/manual-tests/dev-tunnel-reauth.md` — docs.

---

## Task 1: Service worker passes through the reauth navigation

**Files:**
- Modify: `src/web/pwa/swCache.ts`
- Modify: `src/web/sw.ts`
- Test: `tests/sw-cache.test.ts`

- [ ] **Step 1: Update the existing test setup and add failing tests**

In `tests/sw-cache.test.ts`, update the import block (lines 2-10) to add `REAUTH_PARAM` and `isReauthNavigation`:

```ts
import {
  CACHE_NAME,
  NAVIGATION_SHELL_URL,
  SHELL_ASSETS,
  REAUTH_PARAM,
  chooseCacheStrategy,
  isReauthNavigation,
  isStaleCacheName,
  shouldCacheShellResponse,
  shouldCacheAssetResponse,
} from "../src/web/pwa/swCache.js";
```

Update the shared `base` (line 12) to include a `search` field:

```ts
const base = { method: "GET", mode: "no-cors", sameOrigin: true, path: "/other", search: "" };
```

Add these tests inside the `describe("chooseCacheStrategy", ...)` block:

```ts
  test("a reauth navigation passes through so the browser follows the auth redirect", () => {
    expect(chooseCacheStrategy({ ...base, mode: "navigate", path: "/", search: "?reauth=1" })).toBe(
      "passthrough",
    );
  });

  test("a normal navigation without the reauth marker still uses cache-first", () => {
    expect(chooseCacheStrategy({ ...base, mode: "navigate", path: "/", search: "" })).toBe(
      "navigation",
    );
  });
```

Add a new describe block after the `chooseCacheStrategy` block:

```ts
describe("isReauthNavigation", () => {
  test("detects the reauth marker and ignores everything else", () => {
    expect(isReauthNavigation("?reauth=1")).toBe(true);
    expect(isReauthNavigation("?foo=bar&reauth=1")).toBe(true);
    expect(isReauthNavigation("?reauth=0")).toBe(false);
    expect(isReauthNavigation("")).toBe(false);
    expect(REAUTH_PARAM).toBe("reauth");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth && bun test tests/sw-cache.test.ts`
Expected: FAIL — `isReauthNavigation`/`REAUTH_PARAM` not exported, and `chooseCacheStrategy` returns `"navigation"` for the reauth case.

- [ ] **Step 3: Implement the marker + passthrough in `swCache.ts`**

In `src/web/pwa/swCache.ts`, add after the `SHELL_ASSETS` declaration (after line 13):

```ts
/**
 * Query-param marker set on the top-level re-auth navigation. It signals the
 * service worker to pass the navigation through (rather than serve the cached
 * shell) so the browser can follow the cross-origin dev-tunnel → Microsoft
 * sign-in redirect natively, landing the fresh cookie in the PWA's own jar.
 */
export const REAUTH_PARAM = "reauth";

/** True when a navigation's query string carries the reauth marker (`reauth=1`). */
export function isReauthNavigation(search: string): boolean {
  return new URLSearchParams(search).get(REAUTH_PARAM) === "1";
}
```

Update the `chooseCacheStrategy` signature and navigate branch (lines 24-40) to:

```ts
export function chooseCacheStrategy(req: {
  method: string;
  mode: string;
  sameOrigin: boolean;
  path: string;
  search: string;
}): CacheStrategy {
  if (req.method !== "GET" || !req.sameOrigin) {
    return "passthrough";
  }
  if (req.mode === "navigate") {
    return isReauthNavigation(req.search) ? "passthrough" : "navigation";
  }
  if (req.path !== NAVIGATION_SHELL_URL && SHELL_ASSETS.includes(req.path)) {
    return "asset";
  }
  return "passthrough";
}
```

- [ ] **Step 4: Pass the search string from the fetch handler in `sw.ts`**

In `src/web/sw.ts`, update the `chooseCacheStrategy` call inside the `fetch` listener (lines 54-59) to include `search`:

```ts
  const strategy = chooseCacheStrategy({
    method: request.method,
    mode: request.mode,
    sameOrigin: url.origin === self.location.origin,
    path: url.pathname,
    search: url.search,
  });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth && bun test tests/sw-cache.test.ts`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth
git add src/web/pwa/swCache.ts src/web/sw.ts tests/sw-cache.test.ts
git commit -m "fix(pwa): pass through the dev-tunnel reauth navigation in the service worker

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: In-PWA re-auth navigation in `pwaContext.ts`

**Files:**
- Modify: `src/web/pwa/pwaContext.ts`
- Test: `tests/pwa-context.test.ts`

- [ ] **Step 1: Replace the reauth tests with the new behavior (failing)**

In `tests/pwa-context.test.ts`, update the import block (lines 2-7) to:

```ts
import {
  buildTunnelReauthUrl,
  canInstallPwa,
  computeIsStandalone,
  computeIsTunnelOrigin,
  reauthenticateTunnel,
} from "../src/web/pwa/pwaContext.js";
```

Replace both existing `reauthenticateTunnel` tests (lines 30-50) with:

```ts
  test("buildTunnelReauthUrl builds a clean reauth url without the anti-phishing skip param", () => {
    const url = buildTunnelReauthUrl("https://abc-3131.usw2.devtunnels.ms");
    expect(url).toBe("https://abc-3131.usw2.devtunnels.ms/?reauth=1");
    expect(url).not.toContain("X-Tunnel-Skip-AntiPhishing-Page");
  });

  test("reauthenticateTunnel navigates the current window in place to the reauth url", () => {
    const calls: string[] = [];
    reauthenticateTunnel({
      origin: "https://abc-3131.usw2.devtunnels.ms",
      navigate: (url) => calls.push(url),
    });
    expect(calls).toEqual(["https://abc-3131.usw2.devtunnels.ms/?reauth=1"]);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth && bun test tests/pwa-context.test.ts`
Expected: FAIL — `buildTunnelReauthUrl` not exported; `reauthenticateTunnel` still expects `isStandalone`/`href`/`openBrowser`.

- [ ] **Step 3: Rewrite `reauthenticateTunnel` in `pwaContext.ts`**

In `src/web/pwa/pwaContext.ts`, add an import of the reauth marker at the top (below the existing `import { isDevTunnelHost } from "../api.js";` on line 1):

```ts
import { REAUTH_PARAM } from "./swCache.js";
```

Replace the entire `TunnelReauthEnv` interface and `reauthenticateTunnel` function (lines 42-68) with:

```ts
export interface TunnelReauthEnv {
  /** The dashboard origin (e.g. `https://abc-8080.usw2.devtunnels.ms`). */
  origin: string;
  /** Navigates the current window to `url` in place. */
  navigate: (url: string) => void;
}

/**
 * Builds the URL used to re-run the dev-tunnel sign-in. It targets the origin
 * root with the `reauth` marker and deliberately omits the
 * `X-Tunnel-Skip-AntiPhishing-Page` param, so the relay serves its renderable
 * interactive sign-in / anti-phishing page (not the blank programmatic response
 * that a standalone iOS PWA downloaded as an "empty file").
 */
export function buildTunnelReauthUrl(origin: string): string {
  return `${origin}/?${REAUTH_PARAM}=1`;
}

/**
 * Recovers an expired dev-tunnel sign-in with a top-level navigation inside the
 * current window. On iOS a home-screen PWA has a cookie jar isolated from
 * Safari, so the sign-in must complete inside the PWA's own window for the
 * resulting `*.devtunnels.ms` cookie to be usable; opening Safari can never
 * refresh it. The service worker passes the `reauth`-marked navigation through
 * so the browser follows the cross-origin Microsoft redirect natively.
 */
export function reauthenticateTunnel(env: TunnelReauthEnv): void {
  env.navigate(buildTunnelReauthUrl(env.origin));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth && bun test tests/pwa-context.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth
git add src/web/pwa/pwaContext.ts tests/pwa-context.test.ts
git commit -m "fix(pwa): re-auth the dev tunnel inside the PWA window instead of Safari

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Wire the new reauth call and strip the marker in `App.tsx`

**Files:**
- Modify: `src/web/App.tsx`

No unit test: this is React wiring verified by `bun run typecheck` and the manual test. (There is no existing App.tsx unit test harness for the overlay wiring.)

- [ ] **Step 1: Update the `onReauth` handler**

In `src/web/App.tsx`, replace the `TunnelReauthOverlay` block (lines 1663-1674) with:

```tsx
      {connectionOverlay === "auth" && (
        <TunnelReauthOverlay
          onReauth={() =>
            reauthenticateTunnel({
              origin: window.location.origin,
              navigate: (url) => window.location.assign(url),
            })
          }
        />
      )}
```

- [ ] **Step 2: Add a helper to strip the reauth marker**

In `src/web/App.tsx`, add this module-level function immediately above `export function App() {` (before line 532):

```tsx
/**
 * Removes the `reauth=1` marker from the address bar once the dashboard has
 * reconnected, so the one-shot re-auth navigation param does not linger (a
 * bookmarked/relaunched `?reauth=1` would otherwise keep bypassing the SW cache).
 */
function stripReauthParam(): void {
  if (typeof window === "undefined") {
    return;
  }
  const url = new URL(window.location.href);
  if (url.searchParams.has("reauth")) {
    url.searchParams.delete("reauth");
    window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
  }
}
```

- [ ] **Step 3: Call the helper when the server connection is marked connected**

In `src/web/App.tsx`, in the `markServerConnected` function, immediately after the `setTunnelAuthRequired(false);` line (line 867), add:

```tsx
      stripReauthParam();
```

- [ ] **Step 4: Type-check**

Run: `cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth && bun run typecheck`
Expected: PASS — no type errors. (In particular, the `reauthenticateTunnel` call no longer passes `isStandalone`/`href`/`openBrowser`.)

- [ ] **Step 5: Commit**

```bash
cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth
git add src/web/App.tsx
git commit -m "fix(pwa): navigate in-window for reauth and clear the marker on reconnect

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Documentation

**Files:**
- Modify: `docs/security.md`
- Modify: `docs/manual-tests/dev-tunnel-reauth.md`

- [ ] **Step 1: Update the PWA re-auth description in `docs/security.md`**

In `docs/security.md`, replace the paragraph at lines 259-263 (starting "When the browser's dev-tunnel sign-in expires…") with:

```markdown
When the dev-tunnel sign-in expires, the dashboard PWA detects the relay's auth
redirect (a manual-redirect probe of `/health`) and shows an in-app "Sign in
again" prompt instead of spinning on "Reconnecting". The prompt performs a
user-initiated top-level navigation **inside the PWA window** to re-run the
Microsoft sign-in (an installed iOS PWA has a cookie jar isolated from Safari, so
the sign-in must complete in-context for the resulting cookie to be usable). It
never auto-navigates and stores no tunnel credentials itself.
```

- [ ] **Step 2: Update DTR-01 expected result in `docs/manual-tests/dev-tunnel-reauth.md`**

In `docs/manual-tests/dev-tunnel-reauth.md`, replace the DTR-01 **Expected** paragraph (lines 31-38) with:

```markdown
**Expected:** After steps 3-4 the PWA shows the **"Session expired"** overlay
with a **"Sign in again"** button (it appears promptly, without waiting out the
~60s reconnect timer). Tapping the button navigates **inside the PWA window** to
the tunnel sign-in (it does **not** jump out to Safari and does **not** download
an empty file); the Microsoft sign-in page renders in the PWA. Complete the
sign-in there and the PWA's live connection reconnects, the overlay is gone, and
the sessions list/terminal come back — no need to manually copy the tunnel URL
into a browser.
```

- [ ] **Step 3: Update DTR-03 expected result in `docs/manual-tests/dev-tunnel-reauth.md`**

In the same file, replace the DTR-03 **Expected** paragraph (lines 138-144) with:

```markdown
**Expected:** The PWA **boots** (the dashboard shell renders from the service-worker
cache) instead of showing a blank page or downloading an empty file. It then shows the
**"Session expired"** overlay with a **"Sign in again"** button. Tapping the button
navigates **inside the PWA window** to the tunnel sign-in (not out to Safari), where
the Microsoft sign-in renders and the fresh cookie is stored in the PWA's own jar.
Complete the sign-in and the PWA's live connection reconnects, the overlay disappears,
and the sessions list/terminal load — no need to manually copy the tunnel URL into a
browser.
```

- [ ] **Step 4: Commit**

```bash
cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth
git add docs/security.md docs/manual-tests/dev-tunnel-reauth.md
git commit -m "docs: describe in-PWA dev-tunnel re-auth (iOS cookie isolation)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Final verification

- [ ] **Step 1: Run the focused test suites**

Run: `cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth && bun test tests/sw-cache.test.ts tests/pwa-context.test.ts`
Expected: PASS (all tests in both files).

- [ ] **Step 2: Type-check the project**

Run: `cd /Users/jackallan/dev/climon/.worktrees/fix-ios-pwa-tunnel-reauth && bun run typecheck`
Expected: PASS — no type errors.

- [ ] **Step 3: Manual device verification (required before merge)**

Follow DTR-03 in `docs/manual-tests/dev-tunnel-reauth.md` on an iOS/iPadOS home-screen PWA:
1. Install the PWA from an authenticated Tunnel Link URL and sign in once (connects normally).
2. Expire the PWA's tunnel sign-in (clear the PWA's `*.devtunnels.ms` cookie or wait for expiry).
3. Cold-launch the PWA → it boots and shows "Session expired".
4. Tap **Sign in again** → the Microsoft sign-in renders **inside the PWA window** (no empty-file download, no jump to Safari); complete it and confirm the PWA reconnects and the overlay clears.

If step 4 still downloads an empty file or fails to render on device, stop and reassess (fall back to Approach B from the spec — an honest guidance message).

---

## Self-review notes

- **Spec coverage:** §1 → Task 2; §2 → Task 1; §3 → Task 3; §4 (docs) → Task 4; Testing → Tasks 1-2 + Task 5; Manual verification → Task 5 Step 3.
- **Type consistency:** `REAUTH_PARAM` (swCache) reused by `buildTunnelReauthUrl` (pwaContext); `chooseCacheStrategy` request shape gains `search` and every call site (`sw.ts`, tests) is updated; `TunnelReauthEnv` reduced to `{ origin, navigate }` and the App.tsx call site matches.
- **No placeholders:** every code step shows complete code and exact commands.
