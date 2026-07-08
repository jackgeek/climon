# Resume here — iOS PWA + dev-tunnel auth work

Status: **Paused pending discussion** · Owner: @jackgeek · Last updated: 2026-07-08

> This is the pick-up-cold handoff note for the iOS-PWA / dev-tunnel auth
> investigation. Read this first, then the two companion docs:
> - `docs/pwa-tunnel-auth-findings.md` — the full findings & options writeup (share with colleagues).
> - `docs/design-pwa-devcode-auth.md` — the earlier device-code variant of the fallback (superseded on flow choice; kept for history).

---

## Where we are

We investigated why the climon dashboard cannot authenticate when installed as an
**iOS PWA** over a **private** Microsoft dev tunnel (it downloads a 0 KB `aad`
file). We proved the root cause, registered a test Entra app, ran three on-device
sign-in spikes, and wrote up the options. **No client/server code has been
changed** — this branch contains **docs only**. We are **paused** to discuss the
preferred path (engage Microsoft) before building anything.

## The decision that's pending

- **Preferred:** get **Microsoft** to fix it — either the Dev Tunnels product
  supports installed-PWA sign-in on private tunnels (Option A1, keeps today's
  security), and/or corporate IT sanctions the climon app (Option A2).
- **Fallback (validated, ships without Microsoft):** climon self-authenticates
  over an **anonymous** tunnel via browser auth-code + PKCE, authorizes by
  matching the signed-in identity to the tunnel owner, and mints its own
  first-party session cookie (Option B). Needs a small owner-hosted callback.
- See `docs/pwa-tunnel-auth-findings.md` §7–§9 for the full option analysis,
  recommendation, and open questions.

## What exists in Azure (the ONLY thing we created)

One **Microsoft Entra ID (Azure AD) app registration** — a tenant-level directory
object. **No subscription, no resource group, no billable resource, $0.**

| Field | Value |
|---|---|
| Display name | `climon-dashboard` |
| Application (client) ID | `ec39b630-07a9-494d-bad8-3f2ad4c856d7` |
| Object ID | `1316abba-5529-48b1-b8ad-a46658b22e19` |
| Home tenant | `a8e7d9aa-c7da-49fe-905f-8d71206e8516` (personal `jackgeek@gmail.com` directory) |
| Sign-in audience | `AzureADandPersonalMicrosoftAccount` (work/school **and** personal) |
| Public client flows | Enabled (no secret; client_id is not sensitive) |
| Access token version | 2 |
| Delegated scopes | `openid profile offline_access` (no admin consent required) |
| Redirect URIs | **None** — the loopback URI used for the corp spike was removed; app is clean |

- **Portal:** <https://entra.microsoft.com> → Applications → App registrations →
  All applications → `climon-dashboard`.
- **CLI (must be logged into tenant `a8e7d9aa-…`):**
  `az login --tenant a8e7d9aa-c7da-49fe-905f-8d71206e8516 --use-device-code --allow-no-subscriptions`
  then `az ad app show --id ec39b630-07a9-494d-bad8-3f2ad4c856d7`.
- **To delete entirely:** `az ad app delete --id ec39b630-07a9-494d-bad8-3f2ad4c856d7`.
- **NOT created:** the Option B hosted callback (Azure Function) is only a
  proposal; nothing was deployed.

## Verified spike results (do not re-run unless something changed)

Against the app above:

| # | Flow | Account | Result |
|---|---|---|---|
| 1 | Device code | Personal `jackgeek@gmail.com` | ✅ id_token + refresh_token |
| 2 | Device code | Corp `jackallan@microsoft.com` | ❌ **Blocked** by corp Conditional Access ("authentication flow … restricted by your admin") |
| 3 | Auth-code + PKCE (browser, loopback) | Corp `jackallan@microsoft.com` | ✅ id_token + refresh_token; **user consent sufficed, no admin-consent wall** |

Decisive takeaways:
- **Corp blocks device-code but ALLOWS browser auth-code + PKCE today.** So the
  fallback must use the **browser flow**, not device code.
- **Owner authorization needs no allowlist:** the ID token `oid`+`tid` from spike
  #3 exactly equal `devtunnel user show --json` for the tunnel owner
  (`oid ffbc7399-6cbb-4f0f-84c9-0b3185f0c0d0`,
  `tid 72f988bf-86f1-41af-91ab-2d7cd011db47`).

## Design decisions captured so far (for Option B, if we build it)

- **Flow:** unified **browser auth-code + PKCE** for both personal and corp
  (drop device code — it's blocked for corp and is the less secure flow).
- **Authorization:** signed-in `oid`+`tid` must equal the tunnel owner's from
  `devtunnel user show --json`. No config allowlist.
- **Session:** long-lived **sliding ~30-day** first-party cookie
  (`HttpOnly; Secure; SameSite=Lax`); **no Entra tokens stored** (Entra consulted
  only at sign-in).
- **Default:** **opt-in** — default keeps today's private-tunnel (relay-AAD)
  behavior; new mode enabled via config. (Recommended, not yet ratified by user.)
- **Hosted callback:** owner will host on their own domain + Azure Function;
  stateless ~30-line redirector, never sees tokens/secrets, exists only because
  Entra needs a fixed non-wildcard redirect URI and the tunnel host is dynamic.
- **PWA completion:** browser (Safari) does the sign-in; the PWA **polls** climon
  for completion (keyed by a one-time nonce) and then stores its session — the
  PWA never navigates cross-origin itself.

## If/when we resume — next steps

**If pursuing Option A (Microsoft):**
1. Package the reproducible repro (installed iOS PWA → private `*.devtunnels.ms`
   tunnel → interactive AAD → 0 KB `aad` download) for the Dev Tunnels team.
2. Find an internal contact to route A1 (product fix) and/or A2 (admin consent +
   publisher verification for client_id `ec39b630-…`).

**If pursuing Option B (build the fallback):**
1. Resume the superpowers **brainstorming** flow (we paused mid-design-approval)
   → finalize the design → write the spec to
   `docs/superpowers/specs/YYYY-MM-DD-pwa-tunnel-auth-design.md` → **writing-plans**.
   (User preference: use **superpowers**, NOT the prd plugin, for climon.)
2. Register the **production** redirect URI (the hosted callback URL) on the
   Entra app once the callback host exists.
3. Implementation touches (server + web, all Bun — no Rust client change beyond
   passing the mode through):
   - `src/server/dashboard-tunnel.ts` — add `-a` (anonymous) only in the new mode.
   - new `src/server/auth/` — PKCE start, code exchange, JWKS ID-token verify,
     owner-match, session cookie, `/auth/*` routes + rate limiting.
   - `src/web/` — `LoginScreen` + `auth.ts`; treat same-origin 401 as "sign in".
   - `src/config-settings.ts` + feature flag in BOTH `src/features.ts` and
     `rust/climon-config/src/features.rs`, then `bun scripts/gen-config-fixtures.ts`
     and `bun run docs:config`.
   - Docs: `README.md`, `docs/architecture.md`, `docs/security.md`, and a
     `docs/manual-tests/` file (manual-checks convention).

## Repo/workflow notes

- Work lives in worktree `.worktrees/pwa-devcode-auth-design` on branch
  `design/pwa-devcode-auth` (off `dev`). PRs target **`dev`**, never `main`.
- Client work is Rust (`rust/`); dashboard server/web is Bun (`src/server/`,
  `src/web/`). This feature is almost entirely server + web.

## Companion docs on this branch

- `docs/pwa-tunnel-auth-findings.md` — full findings & options (the shareable one).
- `docs/design-pwa-devcode-auth.md` — earlier device-code design (superseded on
  flow choice; browser auth-code + PKCE is now the chosen flow — see findings §6).
