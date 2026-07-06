# Dashboard self-auth via Microsoft Entra Device Code — Design

Status: **Proposal** · Owner: @jackgeek · Target: unblock iOS PWA remote access

## Goal

Make the climon dashboard usable as an **installed iOS PWA** (home-screen,
standalone) over a remote dev tunnel — including **web push notifications** —
**without weakening the "authenticated by a real Microsoft identity" security
posture** we get today from the private dev tunnel.

## Background — why today's setup can't work on iOS

Today the dashboard tunnel is a **private dev tunnel**: Microsoft's relay gates
every request with an interactive Entra (AAD) sign-in *before traffic reaches
climon*. In a normal browser tab this works. In an **installed iOS PWA it is
provably impossible**:

| Path | Result (verified) |
|---|---|
| Sign in inside the PWA window | WKWebView downloads the relay's cross-origin `/auth/postback/aad` callback as an empty `aad` file instead of completing it |
| Sign in in Safari/Chrome, relaunch PWA | Does **not** propagate — iOS gives the standalone PWA an **isolated cookie jar**; the relay cookie never reaches it (tested on-device) |
| Retry loop after browser auth | Can never succeed — the PWA's webview never obtains the relay cookie |
| Embed a `connect` token in the URL (`?X-Access-Token=`) | Relay still 302s to interactive `login.microsoftonline.com` — no bypass (probed against the live relay) |

This is **not** a climon bug. It is the well-documented failure of running an
installed iOS PWA behind a **cross-origin identity-aware proxy** (the same class
of problem reported for Cloudflare Access, Google IAP, and Okta). The universal
fix is the same everywhere:

> **Don't let a cross-origin proxy authenticate the PWA. Have the app
> authenticate itself, same-origin, and set a first-party cookie.**

Prior climon attempts (#7 `fa81d6b`, #40, the SW passthrough `46335d0`) all tried
to make the *relay's* cross-origin flow succeed in the PWA. That approach is a
dead end.

## The core idea

1. **Drop the relay's identity gate.** Host the dashboard tunnel
   **anonymous** (`devtunnel host -a`). The relay becomes a dumb transport;
   requests now reach climon directly. No cross-origin auth redirect ⇒ no `aad`
   download.
2. **climon authenticates the user itself, using Microsoft Entra Device Code
   Flow.** No redirect URI, no cross-origin callback — the exact things that
   break in the PWA.
3. **climon issues its own first-party session cookie.** Same-origin,
   `HttpOnly; Secure; SameSite=Lax`. It persists in the PWA's own store across
   relaunches, so the PWA (and push notifications) keep working.
4. **climon restricts sign-in to the tunnel owner** (identity allowlist), so
   "anonymous relay" does **not** mean "anyone can get in."

Net effect: **real Entra identity + MFA is preserved**, but the auth boundary
moves from Microsoft's relay to climon — where climon controls the callback and
the cookie, which is what makes the PWA work.

## Why Device Code Flow (not Auth Code + PKCE)

Auth Code + PKCE gives nicer UX but needs a **pre-registered redirect URI**.
climon's tunnel hostname is **dynamic per session**
(`<name>-<port>.<cluster>.devtunnels.ms`), and Entra does not allow wildcard
hosts in redirect URIs. Device Code Flow needs **no redirect URI at all**, so it
fits the constraint cleanly and is the industry-recommended flow for iOS PWA
standalone auth.

Optional future enhancement: use Auth Code + PKCE when running in a normal
browser tab (feature-detected) for smoother UX, falling back to device code in
standalone PWAs. Out of scope for v1.

## User experience

Cold launch of the PWA with no valid session:

1. PWA loads climon's own **login screen** (served same-origin — renders fine).
2. User taps **"Sign in with Microsoft."**
3. climon shows a short code and a **"Continue"** button to
   `https://microsoft.com/devicelogin` (deep-linked with the code prefilled
   where supported). For a corporate SSO device this is typically a one-tap
   confirmation.
4. climon backend polls Entra; on success it validates the token, checks the
   **owner allowlist**, and sets the session cookie.
5. PWA reloads into the dashboard. The cookie persists, so subsequent launches
   skip sign-in until it expires.

## Architecture / component changes

> Client role = Rust (`rust/`); dashboard server + web = Bun (`src/server/`,
> `src/web/`). This feature is almost entirely **server + web**, because auth is
> enforced by the dashboard server the browser/PWA talks to.

### Server (Bun) — `src/server/`

- **`dashboard-tunnel.ts`** — add `-a/--allow-anonymous` to the `devtunnel host`
  invocation (and set anonymous access on create) **only when the new auth mode
  is enabled**. Keep the default (relay-AAD) path unchanged.
- **New `src/server/auth/` module:**
  - `devicecode.ts` — Entra device-code client: `POST /devicecode`, poll
    `/token`, using a shipped **public** `client_id` (no secret; multi-tenant
    `/organizations` authority, `openid profile offline_access` scopes).
  - `verify.ts` — validate the ID token (signature via Entra JWKS, `iss`, `aud`,
    `exp`, `nonce`); extract `oid`/`tid`/`preferred_username`.
  - `allowlist.ts` — compare the signed-in identity against the **owner**
    (captured from `devtunnel user show --json` at startup) plus any configured
    additional principals.
  - `session.ts` — mint an opaque random session id, store server-side
    (in-memory + optional on-disk under `$CLIMON_HOME`), set/verify the
    `climon_session` cookie.
- **`server.ts`** — an **auth gate** in the request pipeline:
  - When auth mode = `climon-devicecode`: every non-allowlisted route requires a
    valid session cookie. Unauthenticated requests get the login screen (HTML) /
    `401` (API/WS). Add routes: `POST /auth/devicecode/start`,
    `POST /auth/devicecode/poll`, `POST /auth/logout`, `GET /auth/status`.
  - Keep **loopback-only privileged APIs** exactly as they are today.
  - Rate-limit `/auth/*` to blunt code-guessing / abuse of the now-anonymous
    endpoint.

### Web (React) — `src/web/`

- **New `LoginScreen` component** + `src/web/auth.ts` (device-code start/poll
  glue, testable pure logic split like `api.ts` / `pwaContext.ts`).
- **`api.ts`** — treat `401` from same-origin API as "needs climon sign-in"
  (distinct from today's `classifyTunnelAuthResponse` relay path, which the
  legacy mode still uses).
- **`App.tsx`** — when auth mode is `climon-devicecode` and unauthenticated,
  render `LoginScreen` instead of the relay reauth overlay.

### Config & features

- **`src/config-settings.ts`** — new setting, e.g.
  `dashboard.remoteAuth: "relay-aad" | "climon-devicecode"` (**default
  `relay-aad`** — opt-in, backward compatible). Regenerate docs with
  `bun run docs:config`.
- **Feature flag in BOTH `src/features.ts` and
  `rust/climon-config/src/features.rs`**, then
  `bun scripts/gen-config-fixtures.ts` (Rust+Bun parity tests enforce it).
- Optional `dashboard.remoteAuthAllow: string[]` for extra allowed principals.

### Rust client (`rust/`)

Minimal: the Rust client only needs to know the auth mode so `climon server`
launch and any tunnel-link surfacing stay consistent. It does **not** implement
OAuth. Confirm no client change is needed beyond passing the config through.

### Entra app registration

- One **public client** app registration (multi-tenant, "Allow public client
  flows" = yes, device-code grant, delegated `openid profile offline_access`).
- Ship the `client_id` in climon (public clients have no secret; a client_id is
  not sensitive — Azure CLI ships one the same way).

## Security review — vs. today

| Property | Today (relay-AAD) | Proposed (climon-devicecode) |
|---|---|---|
| Real Microsoft identity + MFA | ✅ (relay) | ✅ (climon via Entra) |
| Restricted to owner | ✅ (tunnel ACL) | ✅ (climon allowlist bound to devtunnel owner) |
| Auth boundary | Microsoft relay | climon server |
| Unauth reaches climon | ❌ (relay blocks) | ⚠️ Yes — reaches climon's **login page only**; no data without a valid+allowed identity |
| iOS installed PWA works | ❌ | ✅ |
| Push notifications on iOS PWA | ❌ (PWA unusable) | ✅ |

Key controls that keep parity: JWKS-verified tokens, owner allowlist, opaque
`HttpOnly; Secure` session cookie, `/auth/*` rate limiting, unchanged
loopback-only privileged APIs, and the feature staying **opt-in** (default keeps
today's model). Residual delta: climon's login endpoint is exposed to anyone
with the tunnel URL — standard for authenticated web apps, and mitigated by the
allowlist + rate limiting.

## Risks & open questions

1. **Device-code UX friction** — needs an on-device spike to confirm how
   seamless the `microsoft.com/devicelogin` step is with corporate SSO. (Likely
   near one-tap; measure it.)
2. **Session lifetime** — pick cookie TTL + refresh-token handling
   (`offline_access`) so relaunches rarely re-prompt without over-extending a
   session.
3. **Anonymous-tunnel exposure** — confirm rate limiting + login-only surface is
   acceptable; document in `docs/security.md`.
4. **Owner identity capture** — confirm `devtunnel user show --json` reliably
   yields a stable principal (`oid`) to bind the allowlist to.
5. **client_id provisioning** — who owns the Entra app registration; tenant
   settings for multi-tenant consent.

## Rollout plan

1. **Spike** (recommended first): a throwaway device-code sign-in against Entra
   from a Bun script to confirm token acquisition, validation, and the on-device
   UX. Gate the whole design on this.
2. Implement server auth module + gate behind the opt-in config/feature flag.
3. Implement web `LoginScreen` + wiring.
4. Switch tunnel to anonymous only in the new mode.
5. Docs: `README.md`, `docs/architecture.md`, `docs/security.md`,
   `docs/setup.md`/`docs/usage.md`, and a manual-test file under
   `docs/manual-tests/` (per the manual-checks convention).

## Docs to update on delivery

- `docs/architecture.md` — new auth boundary and data flow.
- `docs/security.md` — anonymous relay + climon-enforced Entra auth; threat model.
- `docs/manual-tests/` — iOS PWA sign-in + push end-to-end checks.
- Config docs via `bun run docs:config`.
