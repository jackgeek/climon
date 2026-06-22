# Security review handoff — "Open in VS Code" dashboard integration

Date: 2026-06-22
For: a fresh agent implementing the VS Code integration feature
Companion to: `HANDOFF.md` (feature handoff) and
`docs/superpowers/specs/2026-06-22-vscode-integration-design.md` (the spec).

## TL;DR

This feature is the **single largest expansion of climon's attack surface to
date**. Before it, a dashboard viewer (loopback *or* tunnel-authenticated phone)
could stream session I/O, type into existing PTYs, and change cosmetic metadata.
After it, the same viewer can potentially **read arbitrary files** (Simple View)
and reach a **full VS Code workbench with an integrated terminal = arbitrary
code execution on the host** (`code serve-web`), including the *home* host, not
just a devbox.

Treat the `/vscode` proxy and the read-file endpoint as **privileged surfaces**
on par with session spawn, not as cosmetic endpoints. The single most important
design decision the spec leaves open is **who is allowed to reach them**
(loopback-only vs tunnel-permitted). Get that decision explicit and defaulted to
the safe option before writing code.

Nothing below blocks Phase 1 (pure client-side detection/menu). The findings bite
from Phase 2 (read-file endpoint) onward.

## How to read this document

Findings are ordered by severity. Each has: the **vector**, the **impact**, and
**concrete mitigations** to bake into the plan/tests. A consolidated checklist is
at the end — turn each item into a test or a code-review gate. The
`writing-plans` output should reference these by ID (e.g. `SEC-1`).

## Trust-boundary delta (read this first)

The dashboard server binds `127.0.0.1` only, but it is reachable two ways
(`docs/security.md` "Dashboard server: loopback only", "Web Push endpoints"):

1. **Loopback** — the local user's browser.
2. **Dev tunnel** — e.g. the phone PWA, gated only by the tunnel's identity ACL.
   There is **no per-request app auth** beyond that ACL.

Existing endpoint guard tiers already in the code (reuse these, do not invent
new ones):

- `isAllowedSpawnRequest(contentType, origin, host)` — **loopback-only** + JSON
  content-type (forces a CORS preflight the server never grants) + loopback
  `Origin`/`Host`. Defeats browser CSRF and DNS-rebinding. Used for privileged
  spawn/patch/tunnel APIs. `src/server/server.ts:431`.
- `isSameOriginRequest(contentType, origin, host)` — JSON content-type + `Origin`
  host == `Host` header. **Permits the tunnel origin** while blocking
  cross-origin CSRF. Used for push + dashboard preferences.
  `src/server/server.ts:464`.

**Decision required:** which tier guards (a) the Simple View read-file endpoint
and (b) the `/vscode` reverse proxy?

- Read-only Simple View over the tunnel is the *point* of the feature for mobile,
  so it will likely want `isSameOriginRequest`. That is acceptable **only** with
  strict path confinement (SEC-1) and output sanitization (SEC-4).
- The `serve-web` proxy is RCE-equivalent (SEC-2). Recommend **loopback-only
  (`isAllowedSpawnRequest`) by default**, with tunnel exposure behind a separate,
  explicit, off-by-default opt-in. Do **not** silently inherit the same-origin
  tier the preferences endpoint uses.

Mirror the established invariant from `feature.remoteSpawn`: **disabled ⇒ no
process spawned and no token generated** (`docs/security.md` "Remote spawn
command channel").

---

## SEC-1 (Critical) — Arbitrary file read / path traversal via Simple View

**Vector.** The read-file endpoint takes a `FileReference.path` that originates
from untrusted terminal output (for a *remote* session, produced by an untrusted
devbox) or from the header/session icons. Naive handling allows escaping the
intended scope:

- `../../../../etc/passwd`, absolute paths, and (for `host-vscode`) the scope is
  "the whole host" by design — so confinement is the *only* thing limiting reads.
- **Symlink traversal**: a file inside `cwd` that symlinks to `/etc/shadow`.
  Text-normalizing the path does not catch this.
- **TOCTOU**: path validated, then swapped before open.
- Encoding tricks: URL/double-encoding, NUL bytes, Unicode normalization,
  Windows UNC (`\\host\share`), device names (`CON`, `NUL`), ADS (`file:stream`),
  `\\?\` prefixes, drive-relative (`C:foo`).
- **Never trust a client-supplied `cwd`.** Resolve the session's `cwd` server-side
  from `SessionMeta`, keyed by a validated `sessionId`.

**Impact.** Full read of any file the dashboard user can read, reachable over the
tunnel if same-origin-guarded.

**Mitigations.**
- Resolve `realpath`/canonicalize, then verify the *resolved* path is contained
  within the allowed scope (session `cwd`, or the host scope for host providers).
- Defeat TOCTOU: open first, `fstat` the fd, verify it is a **regular file** and
  re-verify containment on the resolved path; read from that same fd.
- Reject non-regular files (FIFO, device, socket) — see SEC-5.
- Reuse `isValidRemoteId`-style strict validation for `sessionId` before building
  any path (`docs/security.md` "Containment: server-side sanitization").
- Define the host-provider scope explicitly. If "whole host" is intended, say so
  in `docs/security.md` and gate it (SEC-2 / tunnel-exposure opt-in).
- Cross-platform: implement and test confinement on Windows separately (UNC,
  drive-relative, case-insensitivity, 8.3 names).

---

## SEC-2 (Critical) — `serve-web` is remote code execution, exposed via the proxy

**Vector.** `code serve-web` is the full VS Code web workbench: **integrated
terminal, tasks, and (unless disabled) extensions**. Whoever can reach
`/vscode/<target>/…` through the dashboard proxy gets read/write to files **and a
shell** as the user on that host. The `host-vscode` provider opens this broadly
over the whole host; this is a *new* RCE primitive independent of any existing
PTY session, and (for local) it runs on the **home** machine.

**Impact.** Arbitrary command execution as the user, on the host. If the proxy is
tunnel-reachable, every tunnel-ACL identity (and any dashboard XSS — see SEC-4)
inherits this.

**Mitigations.**
- Default the `/vscode` proxy to **loopback-only** (`isAllowedSpawnRequest`).
  Tunnel exposure must be a separate, explicit, off-by-default config opt-in,
  documented as "grants host RCE to anyone with tunnel access."
- Gate the RCE providers (`host-vscode`, `session-vscode`) **separately** from
  read-only Simple View, so enabling file viewing never implies enabling RCE.
- Consider hardening flags on spawn (`--without-extensions` / disable workspace
  trust as appropriate) and document the residual terminal/RCE exposure that
  remains regardless.
- `vscode.enabled = false` ⇒ no `serve-web` ever spawned, no token generated.
- Update `docs/security.md` "What a compromised devbox can and cannot do" and add
  an equivalent table row for "what a tunnel viewer can do when vscode is
  enabled."

---

## SEC-3 (High) — connection-token leakage and proxy/SSRF integrity

**Vector.**
- `serve-web` authenticates with a bearer **connection token**. Passing it as
  `--connection-token <tok>` puts the secret in `argv`, which is **world-readable**
  via `ps` / `/proc/<pid>/cmdline` to other local users on a shared host. Verified:
  `serve-web` supports **`--connection-token-file <path>`** specifically to avoid
  this — use it.
- The proxy selects a backend by `<target>`. If `<target>` (or any client input)
  can influence the destination host:port, that is **SSRF** (proxy to arbitrary
  endpoints).
- Path/`..` escapes: `/vscode/<target>/../../api/...` could reach other dashboard
  endpoints or other instances.
- WebSocket upgrade proxying can bypass Origin checks (DNS-rebinding via WS).
- The proxy must inject the bearer token and must never echo it back to the
  browser (e.g. in a `Location`/redirect or error body).

**Mitigations.**
- Generate a high-entropy CSPRNG token **per instance**; write it to a `0600`
  file in a `0700` dir and pass `--connection-token-file`. Never log it; add it to
  the log redaction set alongside existing secrets (`docs/security.md` "Logging").
- `<target>` must be an **opaque server-issued id** mapped server-side to a known
  live loopback port from the instance registry. Never let the client specify
  host/port. Reject unknown targets.
- Normalize and confine the proxied path to the `<target>` prefix; strip `..`.
- Enforce the same Origin/Host check on the **WS upgrade** handshake as on HTTP.
- Strip the injected `Authorization` from any response/redirect surface.
- `serve-web` binds `127.0.0.1` only; on multi-user hosts the token-file perms +
  token secrecy are what stop a co-tenant who finds the loopback port.

---

## SEC-4 (Critical) — XSS in Simple View → chains into SEC-1/SEC-2

**Vector.** Simple View renders **markdown to HTML** and does syntax
highlighting over **attacker-controlled file content** (any file the user opens,
including a malicious devbox's file fetched over the mux). Markdown can carry
`<script>`, `<img onerror=…>`, `javascript:` URLs, and raw HTML. An XSS in the
dashboard origin is **game over**: that origin can call the read-file endpoint
(SEC-1) and the `/vscode` RCE proxy (SEC-2). So "open this README" can become host
RCE.

**Impact.** Dashboard-origin script execution → file read + host RCE chain.

**Mitigations.**
- Render markdown with **raw HTML disabled** and sanitize output (e.g. a renderer
  with `html:false` plus DOMPurify, or an inherently-safe renderer). Strip
  `javascript:`/`data:` URLs and event-handler attributes.
- Syntax highlighter must HTML-escape all tokens; never `innerHTML` raw bytes.
- Render Simple View content inside a **sandboxed iframe** with a strict CSP
  (`default-src 'none'`, no script, restricted img/connect) so even a bypass can't
  reach the dashboard origin or beacon out.
- Add/extend a dashboard **Content-Security-Policy**; pick markdown/highlight libs
  that are safe-by-default *and* small (the web bundle is embedded in the
  `climon-server` binary — see `HANDOFF.md` "Open items").
- Escape/strip terminal control chars from any path shown in the menu/header.

---

## SEC-5 (High) — Resource exhaustion / special files (DoS)

**Vector.** Reading `/dev/zero`, `/dev/random`, FIFOs, or huge files can hang or
exhaust memory. Spawning unbounded `serve-web` session instances exhausts the
`vscode.portRange` and host resources. Oversized mux frames (remote read / bridge)
can OOM.

**Mitigations.**
- `stat`/`fstat` and require a **regular file**; reject special files. Enforce the
  **max-size cap before reading** (stream, don't slurp); add a read timeout.
- Cap concurrent `serve-web` instances; keep the idle-timeout shutdown from the
  spec; reuse the host instance; bound `portRange`.
- All new mux frames respect `MAX_MUX_PAYLOAD = 8 MiB` (`src/remote/mux.ts:10`)
  and tear down on oversize/malformed, matching the existing decoder contract.
  Chunk large file reads.

---

## SEC-6 (High) — Spawn argument injection via untrusted `cwd`/path

**Vector.** `serve-web` is spawned with a folder (session `cwd`) and the file
path. For a **remote** session the `cwd` came from an untrusted devbox
(`toLocalMeta` overwrites server-controlled fields but the `cwd` *string* is
devbox-supplied). A `cwd` like `--install-extension=…` or any leading-`-` value
can be parsed by `serve-web` as a flag (argument injection), and shell
interpolation would be command injection.

**Mitigations.**
- Spawn with an **argv array, never a shell**. No string concatenation into a
  command line.
- Validate/normalize `cwd` to an existing directory; reject values beginning with
  `-` or use a `--` end-of-options separator before positional/path args.
- Apply the same path confinement (SEC-1) to any path handed to `serve-web`.

---

## SEC-7 (Critical) — `vscode.*` config must NOT be dashboard-writable

**Vector.** `vscode.binaryPath` controls **which executable is spawned**. If it
(or `portRange`) were ever added to the `dashboardWritable` allowlist
(`src/config-settings.ts:25`, applied by `applyDashboardPreference`,
`src/server/dashboard-preferences.ts:62`), a same-origin/tunnel attacker could
point it at an arbitrary binary and then trigger a spawn → **direct RCE**.

**Mitigations.**
- Declare all `vscode.*` settings **without** `dashboardWritable` (client/server
  config only). Add a test asserting `dashboardWritableSettings()` contains **no**
  `vscode.*` key, so a future edit can't silently widen it.
- `vscode.binaryPath` resolution should prefer an absolute path / PATH lookup the
  operator set in config, not anything browser-supplied.

---

## SEC-8 (Medium) — Remote mux channels (new attack surface, gated)

**Vector.** Two new mux channels: the `serve-web` HTTP/WS bridge and the
read-file request/response. The devbox end is untrusted; returned file **bytes**
are untrusted content rendered in the trusted dashboard (→ SEC-4). A malicious
devbox could also try to make the uplink bridge to a third-party endpoint instead
of its own loopback `serve-web`.

**Mitigations.**
- New `MuxType`/`ControlMessage` variants are **additive**, centrally numbered,
  `hello`-gated, and `MAX_MUX_PAYLOAD`-capped (matches `docs/security.md`
  "Untrusted-input handling"). Keep `src/remote/mux.ts` (legacy/tests) and the
  Rust `climon-remote` mux byte-compatible.
- The uplink binds `serve-web` to loopback on the devbox and only ever bridges
  *that* port — never a destination named by the request.
- Treat all returned bytes as untrusted (SEC-1 confinement + SEC-4 rendering).
- **This is the BLOCKER phase.** Reconcile enum numbering/framing with the
  concurrent ingest/uplink session before implementing (see `HANDOFF.md`
  "BLOCKER" and the spec's "Coordination / potential conflicts").

---

## SEC-9 (Low) — `localStorage` skip preference & link spoofing

**Vector.** The per-session skip preference makes a normal click **auto-dispatch**
to a stored provider with no menu. If a user stored `host-vscode` skip, a single
tap on a malicious terminal link silently opens the broad editor. The xterm link
provider also parses attacker-printed paths that can be visually deceptive
(homoglyphs, control chars).

**Mitigations.**
- The skip preference is a **client convenience only** — it must never bypass any
  server-side auth/confinement (SEC-1/2/3). Server re-validates every request.
- Long-press always re-opens the menu (already in the spec) — keep it.
- Show the **fully resolved absolute path** in the menu/Simple View header so the
  user can verify before opening; strip control chars from displayed text.

---

## Consolidated checklist (turn each into a test or review gate)

- [ ] **Endpoint guard tiers chosen and documented**: read-file vs `/vscode`
      proxy; proxy defaults to loopback-only; tunnel exposure is a separate
      off-by-default opt-in. (SEC trust-boundary, SEC-2)
- [ ] Path confinement: realpath + containment + fstat-regular-file + TOCTOU-safe;
      Windows cases covered; `sessionId` validated; `cwd` taken server-side. (SEC-1)
- [ ] `serve-web` RCE exposure documented; RCE providers gated separately from
      Simple View; `disabled ⇒ no spawn, no token`. (SEC-2)
- [ ] Connection token: CSPRNG per-instance, `--connection-token-file` (not argv),
      `0600`/`0700`, redacted in logs, never echoed to browser. (SEC-3)
- [ ] Proxy: opaque server-mapped `<target>`, no client host/port, path/`..`
      confinement, WS-upgrade Origin check. (SEC-3)
- [ ] Simple View rendering: markdown HTML disabled + sanitized, highlighter
      escapes, sandboxed iframe + CSP, small safe libs. (SEC-4)
- [ ] DoS: regular-file-only, size cap before read, read timeout, instance cap,
      idle shutdown, `MAX_MUX_PAYLOAD` on all new frames. (SEC-5, SEC-8)
- [ ] Spawn: argv array (no shell), validate `cwd`, guard leading `-` / `--`. (SEC-6)
- [ ] `vscode.*` settings are NOT `dashboardWritable`; test asserts it. (SEC-7)
- [ ] New mux frames additive/`hello`-gated/capped; uplink bridges only its own
      loopback `serve-web`; reconcile with concurrent ingest/uplink work. (SEC-8)
- [ ] Skip preference never bypasses server auth; resolved path shown; control
      chars stripped. (SEC-9)
- [ ] `docs/security.md` updated: new privileged surfaces, proxy + mux, the
      "tunnel viewer can do" table, single-user/licensing note already in spec.

## Suggested next steps

1. Resolve the **guard-tier decision** (trust boundary section) with the user —
   it shapes the whole backend. Default to the safe option (proxy loopback-only).
2. Feed SEC-1..SEC-9 into the `writing-plans` output as explicit per-phase
   security tasks + tests (Phase 2: SEC-1/4/5/6/7; Phase 3: SEC-2/3; Phase 5:
   SEC-8). Phase 1 has no server surface.
3. Land the `docs/security.md` updates in the same phases as the code they
   describe (repo convention: docs in sync with behavior).
4. Add a `security-review` pass before the PR to `dev`.

## Sources / citations

- Spec: `docs/superpowers/specs/2026-06-22-vscode-integration-design.md`.
- Existing guards: `src/server/server.ts:431` (`isAllowedSpawnRequest`), `:464`
  (`isSameOriginRequest`); allowlist `src/config-settings.ts:25` +
  `src/server/dashboard-preferences.ts:62`; mux cap `src/remote/mux.ts:10`.
- Threat model & precedents: `docs/security.md` (loopback-only dashboard, tunnel
  ACL, `toLocalMeta`/`isValidRemoteId` sanitization, `feature.remoteSpawn`
  no-secret-no-spawn invariant, atomic `0600`/`0700` secret storage, log
  redaction).
- `code serve-web` flags (`--connection-token`, `--connection-token-file`,
  `--server-base-path`; bearer-token auth; integrated terminal): VS Code CLI docs
  (verify exact flags against the installed VS Code version during implementation,
  per the spec's "URL/Open semantics to verify").
