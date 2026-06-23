# Handoff — "Open in VS Code" dashboard integration

Date: 2026-06-22
Author: previous agent session
For: a fresh agent picking up this feature

## TL;DR

We are adding an **"Open in VS Code" / file-viewer** capability to the climon
dashboard so a user can open and read the files an agent prints in the terminal.
The **brainstorming/design phase is complete and the spec is committed.** No
implementation has started. The **next step is `writing-plans`** to turn the spec
into an implementation plan — but see the **BLOCKER** below before touching any
remote (ingest/uplink/mux) code.

## Where everything is

- **Worktree:** `.worktrees/vscode-integration` (off `dev`)
- **Branch:** `vscode-integration`
- **Spec (committed):**
  `docs/superpowers/specs/2026-06-22-vscode-integration-design.md`
  (commit `7df9239`)
- **This handoff:** `HANDOFF.md` at the worktree root (uncommitted, not part of
  the branch history).

**Read the spec first.** This handoff summarizes it but the spec is the source of
truth.

## Current status

- [x] Brainstormed with the user; all major decisions made (see below).
- [x] Spec written, self-reviewed, committed.
- [ ] User review of the spec (requested; may still come back with edits).
- [ ] **Cross-session conflict review** for remote phases (BLOCKER — see below).
- [ ] Implementation plan (`writing-plans`).
- [ ] Implementation.

## BLOCKER — concurrent ingest/uplink work

The user is **simultaneously changing the ingest and uplink in another session.**
The remote part of this feature touches the same surfaces, so the remote phase
must be reconciled before implementing. The user will provide a **list of other
in-flight specs**; cross-check them against the surfaces below and fill in the
"Coordination / potential conflicts" section of the spec with concrete conflicts.

High-collision-risk surfaces (additive changes only):

- **Mux protocol** — new frame/channel types for (a) the `serve-web` HTTP/WS
  bridge and (b) Simple View read-file request/response.
  - Canonical (client): `climon-remote` crate mux in `rust/`.
  - Legacy/tests: `src/remote/mux.ts` (`MuxType` enum, `ControlMessage` union,
    `encodeControl`/`encodeData`/`MuxDecoder`).
- **Ingest:** `src/remote/ingest.ts` (Bun, server side).
- **Uplink:** Rust `climon-remote`.
- **Invocation/spawn wiring:** `resolveIngestInvocation` /
  `resolveServerInvocation` (`src/server/server.ts`), `src/remote/uplink-spawn.ts`,
  `rust/climon-cli` entrypoints.

**Phases 1–4 (local-only) do NOT touch ingest/uplink and can proceed now.**
Phase 5 (remote) is gated on the conflict review.

## The design in brief

Three entry points to open a file/folder:

1. **Header code icon** → host-level VS Code (broad host access).
2. **Session code icon** → session-level VS Code scoped to the session `cwd`.
3. **xterm file links** → absolute + cwd-relative paths, with `:line:col` jump.

Two decoupled layers on the web side:

- **Detection layer** — a custom xterm link provider emits a consumer-agnostic
  `FileReference { sessionId, path, line?, col? }`. Knows nothing about VS Code.
- **Open-provider registry** — providers `{ id, label, isAvailable, open }`:
  - `host-vscode` (only if VS Code installed on that host),
  - `session-vscode` (spawns/reuses a session instance),
  - `simple-view` (climon-native, **always available**).

Click behavior:

- Click → Fluent UI **provider menu** + checkbox **"Skip this next time and reuse
  my choice"** (default off).
- Skip preference is **browser-local per session** in `localStorage`
  (`climon.pref.vscode.openProvider.<sessionId>`), via existing
  `readCachedPreference`/`writeCachedPreference` (NOT the server-synced
  preference API).
- With skip active: normal click dispatches to the stored provider; **long-press
  always re-opens the menu.**

Transport (reverse proxy, single origin):

- `serve-web` binds **loopback only**, with a per-instance `--connection-token`
  and `--server-base-path /vscode/<target>`.
- **Local:** Bun dashboard server spawns `serve-web` and reverse-proxies
  `/vscode/<target>/…` (HTTP + WS).
- **Remote:** Rust uplink spawns `serve-web` on the remote host; traffic bridged
  over the **existing ingest↔uplink mux** (new channel). No new external tunnel.

Instance model:

- **Host instance** — one shared `serve-web` per host, lazy-start, kept warm,
  idle-timeout shutdown.
- **Session instance** — spawned on demand (session icon / `session-vscode`),
  scoped to `cwd`; reused if already open.

Simple View:

- Read-only, **in-dashboard modal/panel overlay** (mobile-friendly).
- Markdown rendered to HTML for `.md`/`.markdown`; otherwise monospaced text with
  line numbers + syntax highlighting; scroll to `line` when present.
- File bytes via a dashboard endpoint: local read directly; **remote via a small
  mux read-file request/response** (lighter than the serve-web bridge).
- Untrusted paths: normalize, resolve vs `cwd`, confine to scope, **max size**,
  **binary screen**.

## Key decisions already made (do NOT relitigate)

- Backend is **`code serve-web`** (self-hosted). `code tunnel` / vscode.dev is a
  **deferred future** enhancement.
- Scope is **local AND remote** from the start (remote = phase 5, gated).
- Reachability = **reverse-proxy through the dashboard** (chosen over direct
  connection and per-server tunnels).
- Remote transport = **bridge over the existing ingest↔uplink mux** (chosen over
  a dedicated dev tunnel per server).
- Lifecycle = **both** host-shared and per-session instances coexist; the UI
  affordance picks which (header icon = host, session icon = session).
- **Simple View** is in scope as a first-class, always-available provider.
- Skip preference is **localStorage, per session** (not server-synced).
- Long-press re-opens the menu.

## Open items to resolve during planning

- **Conflict review** with the other ingest/uplink session (BLOCKER for phase 5).
- **`serve-web` URL params** (`?folder=`, `?openFile=`, `#Lline,col`) and
  `--server-base-path` behavior must be **verified against the installed VS Code
  version** — the design's URL notes came from a non-authoritative web search.
- **Library choices** for Simple View syntax highlighting + markdown rendering,
  picked **with dashboard bundle size in mind** (the web bundle is embedded in
  the `climon-server` binary).
- New config settings: `vscode.enabled`, `vscode.binaryPath`,
  `vscode.idleTimeoutSeconds`, `vscode.portRange`.
- **VS Code CLI is user-provided** (bring-your-own; never bundled). Surface the
  official install links in `usage.md`/`README.md` and respect the VS Code Server
  license (single-user, no hosted service) — see the spec's "VS Code CLI: install
  & licensing" section.

## Conventions this repo enforces (important)

- **Worktrees:** all work happens in a worktree under `.worktrees/` (already done
  here). Never work directly on the main checkout.
- **PRs target `dev`, never `main`.** Pushing `main` triggers a release.
- **Client = Rust (`rust/`), server = Bun.** The dashboard server (`src/server/`,
  `src/web/`) is **maintained Bun, not legacy** — do web/server work there. The
  TS *client* under `src/` (index/launcher/daemon/pty/remote uplink) is **legacy
  & frozen**; port client behavior to the Rust crates. Touch legacy TS only to
  keep the Bun test suite green.
- **Config:** new settings go in `src/config-settings.ts`; then regenerate docs
  with `bun run docs:config` (golden-fixture tests fail on drift).
- **Manual tests are mandatory for new features:** add
  `docs/manual-tests/phaseNN-vscode-integration.md` (shape per
  `docs/manual-tests/README.md`) and link it from the index. Feature is not
  complete without it.
- **TS imports** use explicit `.js` extensions (ESM/Bun).
- **Tests** use `bun:test`, added under `tests/*.test.ts`. Isolate climon state
  with `CLIMON_HOME` → temp dir.
- Keep docs in sync: `docs/architecture.md` (components/data flow),
  `docs/security.md` (proxy + mux), `docs/usage.md`, `README.md`.

## Build / test / lint commands

Bun (server + web + legacy TS tests), from repo root:

- Install: `bun install`
- Build all: `bun run build:all`
- Type-check/lint: `bun run typecheck` / `bun run lint`
- Full test suite: `bun test tests`
- Single file: `bun test tests/config.test.ts`
- Single test: `bun test tests/config.test.ts -t "name"`
- Regenerate config docs: `bun run docs:config`
- Run server locally: `bun src/server.ts server`

Rust (client), from `rust/`:

- Build: `cargo build`
- Test: `cargo test`
- Lint: `cargo clippy --all-targets`
- Format: `cargo fmt`

## Suggested next steps for the fresh agent

1. Confirm the user has reviewed the spec; apply any requested edits.
2. **Get the list of other in-flight specs** and complete the conflict review;
   update the spec's "Coordination / potential conflicts" section.
3. Invoke the **`writing-plans`** skill to produce the implementation plan from
   the spec. Sequence it so **phases 1–4 (local, conflict-free)** land first and
   **phase 5 (remote, ingest/uplink)** is scheduled only after the conflict
   review.
4. Implement with TDD (`test-driven-development` skill), per-phase, verifying with
   the commands above. Add manual tests. Open the PR against **`dev`**.

## Recommended phasing (from the spec)

1. Detection + provider registry + menu (long-press, localStorage skip pref) —
   no backend.
2. Simple View (local) — read-file endpoint + modal viewer. No ingest/uplink.
3. Local VS Code — `serve-web` manager + `/vscode` reverse proxy + providers +
   icons. No ingest/uplink.
4. Config + docs + manual tests (local feature).
5. **Remote (gated)** — mux read-file channel + serve-web bridge; Rust uplink
   spawns `serve-web`; ingest-side proxy. Touches ingest/uplink — coordinate.
