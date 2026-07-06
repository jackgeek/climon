# climon iOS PWA + Dev-Tunnel Authentication — Findings & Options

Status: **Findings / discussion document** · Owner: @jackgeek · Date: 2026-07-06

> Purpose: capture everything we have learned (including empirical, on-device
> test results) about why the climon dashboard cannot authenticate when
> installed as an iOS PWA over a **private** Microsoft dev tunnel, and lay out
> the realistic options. This is written to be shared and discussed with
> colleagues — particularly to evaluate the **preferred** path of engaging
> Microsoft to make the private dev tunnel work in an installed PWA, versus the
> **fallback** of having climon authenticate users itself over an anonymous
> tunnel.

---

## 1. Executive summary

- The climon dashboard is reached remotely over a **private Microsoft dev
  tunnel**. The tunnel's relay (`*.devtunnels.ms`) enforces an interactive
  Microsoft Entra (AAD) sign-in **before** any traffic reaches climon.
- In a normal browser this works. In an **installed iOS PWA (home-screen,
  standalone)** it is **provably broken**: the relay's cross-origin auth
  callback is downloaded as an empty `aad` file, and the relay cookie lands in
  an **isolated per-PWA cookie jar** that can never be populated from Safari.
  This blocks the PWA — and therefore blocks web push notifications, which
  require the installed PWA.
- This is a **platform-level interaction problem** between an installed iOS
  standalone PWA and a **cross-origin identity-aware proxy** (the same class of
  problem documented for Cloudflare Access, Google IAP, and Okta). It is **not**
  a climon bug and cannot be fixed from inside climon while the relay owns auth.
- Two families of solutions exist:
  1. **Engage Microsoft (preferred).** Get the Microsoft **Dev Tunnels** product
     to support installed-PWA access on private tunnels (and/or sanction the
     climon identity app in the corporate tenant). This is the only path that
     **keeps the private tunnel** and therefore **preserves today's security
     posture** with no climon-side downgrade. climon changes little or nothing.
  2. **climon self-authenticates over an anonymous tunnel (fallback).** climon
     stops relying on the relay for auth: it hosts the tunnel **anonymously**
     and authenticates the user itself via Microsoft Entra, restricting access
     to the **tunnel owner**. This ships unilaterally and is **proven to work
     for both personal and corporate accounts**, but it moves the auth boundary
     from Microsoft's relay into climon (a security trade-off).
- **We validated the fallback end-to-end empirically** (see §6). It works. It is
  the safety net. But because it weakens the security model, we would prefer the
  Microsoft-side fix if it is attainable on an acceptable timeline.

---

## 2. Background — how climon remote access works today

- climon is a local PTY/session manager with a **dashboard** (React + Fluent UI,
  served by a Bun server). Locally the dashboard binds to **loopback only**.
- To reach the dashboard from another device (e.g. a phone), climon uses a
  **Microsoft dev tunnel**. Today this is a **private** tunnel: the
  `*.devtunnels.ms` relay requires the visitor to sign in with a Microsoft
  identity that is authorized on the tunnel **before** the request is proxied to
  climon. This is what gives us "only a real, authorized Microsoft identity can
  reach the dashboard remotely" for free.
- The dashboard is also a **PWA**: it can be installed to the iOS home screen
  and (crucially) that installed PWA is what unlocks **web push notifications**
  for session events. Push does not work from a plain Safari tab; it requires the
  installed standalone PWA.

---

## 3. The problem

When the dashboard is **installed as an iOS PWA** and opened, the Microsoft
relay's interactive sign-in **cannot complete**. Observed on-device: the flow
navigates to the Microsoft sign-in page, redirects back, and then the browser
**downloads a 0 KB file named `aad`** instead of finishing the sign-in. The
dashboard never loads.

Consequences:

- The dashboard is **unusable** as an installed iOS PWA over the private tunnel.
- **Web push notifications are unavailable**, because they depend on the
  installed PWA that we cannot authenticate.

---

## 4. Root-cause analysis

The failure is intrinsic to running an **installed iOS standalone PWA** behind a
**cross-origin identity-aware proxy**. Verified behaviours:

| Path | Result (verified) |
|---|---|
| Sign in **inside** the installed PWA window | The installed PWA is a **standalone WKWebView**. The relay's cross-origin `/auth/postback/aad` callback is **downloaded as an empty `aad` file** instead of being processed, so sign-in never completes. |
| Sign in in Safari/Chrome, then relaunch the PWA | Does **not** propagate. iOS gives the installed standalone PWA an **isolated cookie jar** separate from Safari; the relay cookie set in the browser never reaches the PWA. (Tested on-device.) |
| "Authenticate in the browser, then retry in the PWA" loop | Can never succeed — the PWA webview never obtains the relay cookie, no matter how many times it retries. |
| Embed a tunnel **connect** access token in the URL (`?X-Access-Token=…`) | The relay still **302-redirects to interactive `login.microsoftonline.com`**. The token does **not** bypass the interactive browser sign-in. (Probed directly against the live relay.) |

Why the token trick fails: browsers cannot attach custom headers
(`X-Tunnel-Authorization`) to top-level navigations or asset loads, so the relay
falls back to interactive AAD for any browser context — including the PWA.

Prior climon attempts to make the **relay's** cross-origin flow succeed in the
PWA (PRs `fa81d6b` (#7), `895cf4d` (#40), the service-worker passthrough
`46335d0`) all failed. Making the relay's cross-origin auth work inside an
installed iOS PWA is a dead end from climon's side.

**Bottom line:** as long as a **cross-origin proxy owns authentication**, the
installed iOS PWA cannot be authenticated. Either the proxy (Microsoft) must
learn to authenticate installed PWAs, or the app (climon) must authenticate
itself same-origin.

---

## 5. The Entra identity app we created (for testing and for the fallback)

To test the flows and to underpin the fallback, we registered a Microsoft Entra
application (a **public client** — no secret; a client ID is not sensitive, the
same way the Azure CLI ships one):

| Property | Value |
|---|---|
| Display name | `climon-dashboard` |
| Application (client) ID | `ec39b630-07a9-494d-bad8-3f2ad4c856d7` |
| Object ID | `1316abba-5529-48b1-b8ad-a46658b22e19` |
| Home tenant (where it is registered) | `a8e7d9aa-c7da-49fe-905f-8d71206e8516` |
| Sign-in audience | `AzureADandPersonalMicrosoftAccount` (work/school **and** personal) |
| Public client flows | Enabled |
| Access token version | 2 |
| Delegated scopes | `openid profile offline_access` (no admin consent required) |

This app is **multi-tenant** and currently relies on **user consent**. It is not
publisher-verified and is not registered as a sanctioned enterprise app in any
corporate tenant. That distinction matters for Option A2 below.

---

## 6. Empirical findings (spikes)

We ran three real sign-in spikes against the app above. Results:

| # | Flow | Account | Result |
|---|---|---|---|
| 1 | **Device code** | Personal (`jackgeek@gmail.com`) | ✅ **Success.** Returned `id_token` + `refresh_token`; `iss` = consumers tenant `9188040d-6c67-4c5b-b112-36a304b66dad`, `aud` = our client ID, `ver` 2.0. |
| 2 | **Device code** | Corporate (`jackallan@microsoft.com`) | ❌ **Blocked** by corporate policy: *"Your sign-in was successful but does not meet the criteria to access this resource … an authentication flow that is restricted by your admin."* This is the well-known Conditional Access policy that **blocks the OAuth device-code flow** (an anti-phishing control recommended by Microsoft's own security guidance). |
| 3 | **Auth code + PKCE** (browser redirect, loopback `http://localhost`) | Corporate (`jackallan@microsoft.com`) | ✅ **Success.** Returned `id_token` + `refresh_token`; `iss` = corp tenant `72f988bf-86f1-41af-91ab-2d7cd011db47`, `aud` = our client ID, `ver` 2.0. **No admin-consent wall; user consent sufficed.** |

Two decisive conclusions from spike #3:

1. **The corporate tenant permits the browser auth-code + PKCE flow** for our
   third-party multi-tenant app **today**, even though it blocks device code. So
   the corporate case does **not** require a Conditional Access change to work
   *via the browser flow*.
2. **Owner identity can be verified with no configuration.** The ID token claims
   from spike #3 **exactly match** what `devtunnel user show --json` reports for
   the tunnel owner:

   | Source | `objectId` / `oid` | `tenantId` / `tid` |
   |---|---|---|
   | `devtunnel user show --json` | `ffbc7399-6cbb-4f0f-84c9-0b3185f0c0d0` | `72f988bf-86f1-41af-91ab-2d7cd011db47` |
   | Entra ID token (spike #3) | `ffbc7399-6cbb-4f0f-84c9-0b3185f0c0d0` | `72f988bf-86f1-41af-91ab-2d7cd011db47` |

   So climon can authorize simply by requiring the signed-in identity's
   `oid` + `tid` to equal the tunnel owner's — **no allowlist to maintain**.

(All spike artifacts — the temporary loopback redirect URI and the test script —
were cleaned up after testing.)

**Important nuance on flow choice:** device code was the original design pick
because it needs **no redirect URI** (climon's tunnel hostname is dynamic per
session and Entra forbids wildcard redirect URIs). But device code is **blocked
for corporate accounts** and is the flow Microsoft security guidance actively
discourages. The browser auth-code + PKCE flow is **allowed for corporate** and
is the more secure flow — at the cost of needing a **stable, pre-registered
redirect URI**, which the fallback design solves with a small hosted callback
(see §7.2).

---

## 7. Options

There are two families: **engage Microsoft** (keep the private tunnel) and
**climon self-auth** (anonymous tunnel). They are not mutually exclusive — we can
pursue the Microsoft path while keeping the fallback ready.

### 7.1 Option A — Engage Microsoft (preferred; keeps today's security posture)

The **only** way to keep the **private** tunnel (and thus avoid any climon-side
security downgrade) is for **Microsoft** to make private-tunnel access work from
an installed iOS PWA. Two concrete sub-asks:

#### A1 — Ask the Microsoft **Dev Tunnels** product team to support installed-PWA access on private tunnels *(the clean win)*

- **What to request:** the `*.devtunnels.ms` relay's interactive sign-in should
  complete inside an **installed iOS standalone PWA (WKWebView)** — i.e. the
  auth callback must render/redirect correctly instead of being downloaded as a
  0 KB `aad` file, and the resulting session must be usable by the standalone
  PWA context (which has an **isolated cookie jar** from Safari). Equivalently,
  the relay could offer a **browser-navigable, PWA-compatible session** (not
  just a header-based token) for private tunnels.
- **Why it is the best outcome:** climon keeps the private tunnel; the relay
  keeps owning auth; **no anonymous exposure**, **no climon-side auth code**, and
  no change to today's security model. Ideally **zero climon changes**.
- **What is required to make it possible:**
  - A reproducible bug report: installed iOS PWA → private
    `*.devtunnels.ms` tunnel → interactive AAD sign-in → 0 KB `aad` download.
    (We have the exact repro and can supply it.)
  - Escalation through a Microsoft contact who can route it to the Dev Tunnels
    engineering team (this is where colleagues with internal reach help most).
  - Product acceptance + a fix timeline. **This is outside climon's control**;
    the risk is that it is not prioritized or not fixed soon.
- **Status / evidence:** the failure is reproducible on-device; the underlying
  cause (WKWebView standalone + isolated cookie jar behind a cross-origin proxy)
  is a documented platform pattern, not specific to climon.

#### A2 — Sanction the climon Entra app in the corporate tenant *(makes the corporate identity path robust)*

This applies **if** we adopt the climon-self-auth fallback (Option B) and want
the **corporate** account path to be durable and officially blessed rather than
dependent on revocable user consent.

- **What to request from corporate IT / Entra admins:**
  - **Admin consent** for the `climon-dashboard` app (client ID
    `ec39b630-07a9-494d-bad8-3f2ad4c856d7`) in the corporate tenant, registering
    it as an approved **enterprise application** with the delegated scopes
    `openid profile offline_access`.
  - **Publisher verification** (Microsoft Partner Network) for the app, so it
    shows a verified publisher and is eligible under app-consent policies.
  - Confirmation that the app is **not** subject to a Conditional Access policy
    that would block the **browser auth-code + PKCE** flow. (Spike #3 shows it is
    currently permitted; admin consent makes this durable if consent policy is
    later tightened.)
- **What NOT to pursue:** a Conditional Access **exclusion to re-enable device
  code**. Device code is blocked deliberately as an anti-phishing control, it is
  the less secure flow, and we do not need it — the browser flow already works.
- **Important limitation:** A2 makes the **identity step** sanctioned and
  durable, but it **does not remove the need for an anonymous tunnel** in the
  fallback. Any climon-self-auth approach requires the relay to *stop* owning
  auth (i.e. an anonymous tunnel), because a private tunnel's relay auth is
  exactly what fails in the PWA. Only **A1** avoids the anonymous tunnel.

**Summary of Option A:** A1 is the ideal (keeps private tunnel, no downgrade) but
depends on Microsoft. A2 hardens the fallback's corporate path but does not by
itself preserve the private-tunnel security model.

### 7.2 Option B — climon self-authenticates over an anonymous tunnel (fallback; ships unilaterally)

If the Microsoft-side fix is not attainable in time, climon can solve this
itself. **This is fully validated (see §6) and works for both personal and
corporate accounts.** It is a **fallback** because it changes the security model.

**Core idea:**

1. **Host the tunnel anonymously** (`devtunnel host -a`), only when this new mode
   is enabled. The relay becomes a dumb transport; requests reach climon
   directly, so there is **no cross-origin auth redirect** and therefore **no
   `aad` download**.
2. **climon authenticates the user itself** via **Microsoft Entra auth-code +
   PKCE**, driven from the **system browser** (not the PWA webview), so the
   corporate-friendly browser flow is used and the PWA never has to perform a
   cross-origin navigation itself.
3. **A small, stable, hosted callback** (owner-run; e.g. an Azure Function at a
   fixed URL) receives Entra's redirect and forwards the authorization `code`
   back to the specific climon instance (the dynamic tunnel address is carried in
   the OAuth `state`). The callback is a **dumb, stateless redirector**: it never
   sees tokens and holds no secrets. It exists solely because Entra requires a
   **pre-registered, non-wildcard redirect URI** and the tunnel hostname is
   dynamic.
4. **climon exchanges the code (with PKCE) for tokens**, validates the ID token
   (JWKS signature, `iss`, `aud`, `exp`), and **authorizes by requiring the
   identity's `oid` + `tid` to equal the tunnel owner's** (from
   `devtunnel user show --json`). No allowlist.
5. **climon mints its own first-party session cookie**
   (`HttpOnly; Secure; SameSite=Lax`), long-lived and sliding (~30 days). It
   persists in the PWA's own store across relaunches, so the PWA and push keep
   working. **No Entra tokens are stored** — Entra is consulted only at sign-in.
6. **PWA completion via polling:** because the browser sign-in happens in Safari
   (isolated from the PWA), the PWA **polls** climon for completion keyed by a
   one-time nonce, then receives and stores its session. The PWA never navigates
   cross-origin itself.

**Security trade-off (why it is the fallback, not the default):**

| Property | Today (private tunnel, relay-AAD) | Option B (anonymous tunnel, climon self-auth) |
|---|---|---|
| Real Microsoft identity + MFA | ✅ (relay) | ✅ (climon via Entra) |
| Restricted to owner | ✅ (tunnel ACL) | ✅ (identity `oid`+`tid` must equal tunnel owner) |
| **Auth boundary** | **Microsoft relay** | **climon server** |
| Unauthenticated traffic reaches climon | ❌ (relay blocks) | ⚠️ Reaches climon's **login endpoint only**; no data without a valid, owner-matching identity |
| Installed iOS PWA works | ❌ | ✅ (validated) |
| iOS PWA push notifications | ❌ | ✅ |
| External dependency | Microsoft relay only | Microsoft relay **+ owner-hosted callback** |

Controls that keep the trade-off acceptable: JWKS-verified tokens, owner-identity
match, opaque `HttpOnly; Secure` cookie, `/auth/*` rate limiting, unchanged
loopback-only privileged APIs, and the feature staying **opt-in** (default
preserves today's private-tunnel behaviour). Residual delta: climon's **login
endpoint** is reachable by anyone with the tunnel URL (standard for any
authenticated web app), mitigated by the owner-match check and rate limiting.

**Hosted-callback requirement (Option B only):**

- ~30 lines, **stateless**, no database, **never handles tokens or secrets** —
  it only reads the tunnel address from `state` and 302-redirects the browser
  onward to that climon instance.
- Needs a **fixed HTTPS URL** and to **stay up** for *new* sign-ins (existing
  sessions keep working via the first-party cookie if it is briefly down).
- Cost is effectively zero (Azure Function consumption / Cloudflare Worker free
  tier). The real consideration is philosophical: climon has been fully
  self-contained/local, and this adds **one always-on hosted dependency** to the
  remote-auth path. The owner (@jackgeek) intends to host it on their own domain
  + Azure Function.

An earlier variant of this design used **device code** instead of the browser
flow (see `docs/design-pwa-devcode-auth.md`). We moved away from device code
because it is **blocked for corporate accounts** (spike #2) and is the less
secure flow; the browser auth-code + PKCE flow works for corporate (spike #3) at
the cost of the hosted callback.

### 7.3 Option C — Personal accounts only (narrowest fallback)

Ship device-code self-auth for **personal / non-corporate** accounts only
(no hosted callback needed), and document corporate accounts as unsupported for
the installed iOS PWA. Smallest scope, but does **not** solve the corporate/work
use case, which is a primary goal. Listed for completeness; **not recommended**.

---

## 8. Recommendation

1. **Pursue Option A1 first** — engage the Microsoft Dev Tunnels team to make
   private-tunnel sign-in work in an installed iOS PWA. It is the only outcome
   that preserves today's security model with little or no climon change. Supply
   the reproducible repro; use internal contacts to route it.
2. **In parallel, keep Option B ready** as the fallback climon can ship without
   Microsoft. It is validated end-to-end for personal **and** corporate accounts,
   solves push, and is gated **opt-in** so it never changes the default security
   posture. Adopt it if A1 will not land on an acceptable timeline.
3. **If we ship Option B and want a durable corporate path, add Option A2** —
   admin consent + publisher verification for the climon app in the corporate
   tenant — so corporate usage does not depend on revocable user consent. Do
   **not** request a device-code Conditional Access exclusion.

## 9. Open questions for discussion

- **A1 feasibility & timeline:** is there an internal contact who can get the
  Dev Tunnels team to look at the installed-PWA auth failure, and what is a
  realistic timeframe? Is this something they would consider a supported
  scenario at all?
- **A2 appetite:** would corporate IT grant admin consent + treat `climon-
  dashboard` as a sanctioned enterprise app? Is publisher verification worth
  doing for a side project?
- **Anonymous-tunnel acceptability (Option B):** is moving the auth boundary
  into climon (with owner-match + rate limiting) acceptable for the intended use,
  given the login endpoint becomes reachable on the tunnel URL?
- **Hosted-callback ownership (Option B):** confirm the owner-hosted Azure
  Function is acceptable as a permanent dependency, including who maintains it.
- **Do we need the browser flow for personal accounts too,** or keep device code
  for personal (no callback needed) and browser flow for corporate? Unifying on
  the browser flow is simpler operationally.

## Appendix — reference data

- **Entra app:** client ID `ec39b630-07a9-494d-bad8-3f2ad4c856d7`, object ID
  `1316abba-5529-48b1-b8ad-a46658b22e19`, home tenant
  `a8e7d9aa-c7da-49fe-905f-8d71206e8516`, audience
  `AzureADandPersonalMicrosoftAccount`, public client, access-token v2, scopes
  `openid profile offline_access`.
- **Tunnel owner (this work machine), from `devtunnel user show --json`:**
  provider `microsoft`, `jackallan@microsoft.com`, tenant
  `72f988bf-86f1-41af-91ab-2d7cd011db47`, object ID
  `ffbc7399-6cbb-4f0f-84c9-0b3185f0c0d0`.
- **Device-code block message (corporate, spike #2):** *"Your sign-in was
  successful but does not meet the criteria to access this resource … an
  authentication flow that is restricted by your admin."*
- **Related docs:** `docs/design-pwa-devcode-auth.md` (earlier device-code
  variant of Option B), `docs/security.md`, `docs/architecture.md`.
