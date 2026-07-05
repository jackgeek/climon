# climon feature catalogue

A living record of every feature built into climon — what it does, the value it
gives the user, and where to find it in the code / manual tests.

**Why this exists.** Primarily as a reminder of the work done, and secondarily as
honest, code-grounded material for describing and selling climon to others. The
"Value add" column states the benefit a real user gets, grounded in what the code
actually does — no aspirational claims.

## How to read this

- **Production** = merged to `main` **and** not behind a feature flag (i.e. what a
  user gets out of the box from the latest release, currently **v3.1.2**).
- **In development** = not yet in production. That means unreleased work on `dev`
  or a feature branch, **or** a capability that only runs when an experimental
  `feature.*` flag is enabled (all four flags — `sessionSpawning`, `remoteSpawn`,
  `wslBridge`, `remotes` — default to *disabled* / *experimental*, see
  [`src/features.ts`](../src/features.ts)).
- **Identified by** links the manual-test doc (under `manual-tests/`) and/or the
  source path/crate that implements the feature.
- Rows tagged **⚠️ needs discussion** have a vague name or unclear scope — see
  [Open questions](#open-questions) and let's firm them up.

> Client = the Rust `climon` binary (`rust/` workspace). Server = the Bun
> `climon-server` binary (`src/server/`). Dashboard = the React/Fluent web UI
> (`src/web/`). PWA = installable-app behaviours layered on the dashboard.

---

## Client — in production

The Rust `climon` binary: launcher, attach client, per-session daemon, PTY, config,
onboarding, and self-update.

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| Run any command in a managed session | `climon <cmd>` / `climon run -- <cmd>` runs your command inside a managed pseudo-terminal and registers it as a session. | Turn any long-running or interactive command into a session you can watch, drive, and get notified about — no wrapper scripts, just prefix it with `climon`. | [manual-tests/phase08-cli.md](manual-tests/phase08-cli.md); `rust/climon-cli` |
| Managed interactive shell | `climon shell` launches your default shell as a managed session. | Bring an ordinary interactive shell under climon so everything you do in it is visible on the dashboard and reachable from your phone. | [manual-tests/phase08-cli.md](manual-tests/phase08-cli.md); `rust/climon-cli`, [specs/2026-07-03-climon-shell-command-design.md](superpowers/specs/2026-07-03-climon-shell-command-design.md) |
| List sessions | `climon ls` prints current sessions, priority-sorted. | See every managed session and which one needs you first, straight from the terminal — same ordering as the dashboard. | [manual-tests/phase08-cli.md](manual-tests/phase08-cli.md); `rust/climon-cli`, `src/priority.ts` |
| Kill a session | `climon kill <id>` terminates a session's process. | Stop a runaway or finished session cleanly without hunting for the original terminal tab. | [manual-tests/phase08-cli.md](manual-tests/phase08-cli.md); `rust/climon-cli` |
| Attach / detach without stopping | Re-attach a local terminal to a running session; detach with **Ctrl-\ then d** and the command keeps running. | Step away and come back to any session at will — detaching never kills your build, REPL, or agent. | [manual-tests/phase08-cli.md](manual-tests/phase08-cli.md); `rust/climon-cli/src/client.rs` |
| Cross-platform PTY | Native pseudo-terminal (openpty on Linux/macOS, ConPTY on Windows) with buffered early output and fast-exit capture. | Full interactive terminal fidelity on every OS, and a listener that attaches a moment late never misses the first bytes. | [manual-tests/phase06-pty.md](manual-tests/phase06-pty.md); `rust/climon-pty` |
| Detached per-session daemon | Each session runs in its own daemon that owns the PTY, independent of the dashboard server. | Your sessions survive dashboard restarts and crashes — the work keeps running no matter what happens to the UI. | [manual-tests/phase07-session.md](manual-tests/phase07-session.md); `rust/climon-session` |
| Scrollback capture & persistence | The daemon keeps a scrollback ring buffer and persists final output when a command exits. | Scroll back through what happened and review the full output of a finished command long after it ended. | [manual-tests/phase07-session.md](manual-tests/phase07-session.md); `rust/climon-session` |
| Attention detection | Client-side static-screen detection: when the visible screen stops changing for `attention.idleSeconds`, the session flips to `needs-attention`. | Automatically surfaces the session that's blocking on *you* — no manual tagging, no fragile text-pattern matching. | [manual-tests/phase07-session.md](manual-tests/phase07-session.md); `rust/climon-session` |
| Terminal title as session subtitle | Captures the PTY's OSC 0/2 title and shows it as a per-session subtitle. | Sessions self-label with what they're actually doing (e.g. the current command or dir), so you can tell them apart at a glance. | [manual-tests/terminal-title-subtitle.md](manual-tests/terminal-title-subtitle.md); `rust/climon-session` |
| Priority ordering | `needs-attention` → `running` → completed/failed → disconnected, with user priority as an extra input; drives `climon ls` and the dashboard. | Rank and prioritise your sessions so your time and attention always go to the highest-value task first, instead of whatever tab you happened to click. | `src/priority.ts`; `session.priority` config |
| Hierarchical config | `climon config get/set` over cascading JSONC (local `.climon/config.jsonc` upward, then global), with legacy `config.json` migration. | Configure climon per-project or globally with one command, and existing config files keep working across upgrades. | [manual-tests/phase03-config.md](manual-tests/phase03-config.md); `rust/climon-config`, `src/config-settings.ts` |
| Per-session theme | `--theme` flag plus `session.color`/default theme, with live inheritance from the default. | Give each session its own look so you can visually distinguish, say, prod from dev at a glance. | [manual-tests/per-session-theme.md](manual-tests/per-session-theme.md); `rust/climon-cli`, `session.color` |
| First-run setup / onboarding | `climon setup` walks through PATH, telemetry, and auto-update choices; opt-in prompts default to Yes. | Get a working, up-to-date install in one guided step, with sensible defaults and no surprise data collection. | [manual-tests/phase11-install.md](manual-tests/phase11-install.md), [manual-tests/optin-default-yes.md](manual-tests/optin-default-yes.md); `rust/climon-install` |
| Secure self-update | `climon update` fetches a release manifest, verifies an Ed25519 detached signature + AES-256-GCM envelope, then does an atomic non-destructive binary swap; background check + launch banner. | Stay current safely — updates are cryptographically verified and never kill running sessions, so upgrading is risk-free. | [manual-tests/phase10-update.md](manual-tests/phase10-update.md), [manual-tests/release-signing-key-preflight.md](manual-tests/release-signing-key-preflight.md); `rust/climon-update` |
| Native self-install | The release archive's `install`/`install.exe` is the Rust client itself; sets up PATH and on-disk layout across macOS/Linux/Windows. | One self-contained command installs climon — no runtime, package manager, or `node_modules` to manage. | [manual-tests/phase11-install.md](manual-tests/phase11-install.md), [manual-tests/phase12-cutover.md](manual-tests/phase12-cutover.md); `rust/climon-install` |
| Structured logging | Per-role NDJSON logs with redaction and level semantics; `silent` creates no files; terminal output suspended while attached. | Diagnosable behaviour when something goes wrong, without leaking secrets or corrupting your shell. | [manual-tests/phase04-logging.md](manual-tests/phase04-logging.md); `rust/climon-logging` |
| Privacy-preserving telemetry (opt-in) | Optional App Insights telemetry with a field allowlist + sanitizer; no PII, user commands, or rendered text ever egress; connection string never stored in config. | Helps improve climon if you opt in, with a hard guarantee that your commands and terminal contents never leave your machine. | [manual-tests/telemetry-privacy.md](manual-tests/telemetry-privacy.md), [manual-tests/appinsights-connection-source.md](manual-tests/appinsights-connection-source.md); `src/logging/` |
| MIT license notice | `climon license`; one-time upgrade notice, no notice on fresh installs. | Clear, unobtrusive licensing so you always know your rights to the software. | [manual-tests/mit-license-transition.md](manual-tests/mit-license-transition.md); `rust/climon-cli` |
| Windows: no console-window popups | Suppresses console windows from child processes (`devtunnel`/`tasklist`/`taskkill`/peer discovery). | On Windows, climon runs quietly in the background instead of flashing console windows in your face. | [manual-tests/windows-no-console-popups.md](manual-tests/windows-no-console-popups.md); `rust/climon-cli`, `rust/climon-remote` |
| Server delegation | `climon server` resolves and spawns the compiled `climon-server` binary. | One `climon` command is the single entry point — start the dashboard without knowing about a separate binary. | [manual-tests/phase01-client-server-split.md](manual-tests/phase01-client-server-split.md); `rust/climon-cli/src/server_exec.rs` |

## Client — in development

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| Remote sessions over a dev tunnel | A devbox `climon __uplink` connects to a home `climon __ingest` over a Microsoft dev tunnel; remote sessions appear on the home dashboard as first-class sessions. | Watch and drive sessions running on another machine from one dashboard — your laptop, your devbox, and your phone all see the same list. | `feature.remotes`; [manual-tests/phase09-remote.md](manual-tests/phase09-remote.md), [manual-tests/phase15-ingest-rust-cutover.md](manual-tests/phase15-ingest-rust-cutover.md), [manual-tests/ingest-tunnel-host.md](manual-tests/ingest-tunnel-host.md); `rust/climon-remote` |
| WSL ⇄ Windows bridge (same machine) | `climon link` records each side's `CLIMON_HOME`; when `feature.wslBridge` is on, sessions stream between a WSL distro and Windows onto one shared dashboard. | See your Windows and WSL sessions together in a single dashboard instead of juggling two separate worlds on the same box. | `feature.wslBridge`; [manual-tests/phase14-wsl-bridge-feature-flag.md](manual-tests/phase14-wsl-bridge-feature-flag.md); `rust/climon-remote`, `src/remote/peer.ts` |
| Remotes visibility | `climon remotes` (`--watch`/`--json`) plus `ingest-status.json`/`uplink-status.json` beacons show the live remote topology. | Know at a glance which remote hosts are connected and healthy, from the terminal or a script. | (with `feature.remotes`); [manual-tests/phase16-remotes-visibility.md](manual-tests/phase16-remotes-visibility.md); `rust/climon-remote` |

## Server — in production

The Bun `climon-server` binary: stateless dashboard host that scans session
metadata and bridges browsers to daemons.

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| Dashboard HTTP server | `Bun.serve` server that discovers sessions by scanning `~/.climon/sessions/*.json` and serves the dashboard. | One always-available dashboard for every session on the machine, decoupled from the sessions themselves. | [manual-tests/phase01-client-server-split.md](manual-tests/phase01-client-server-split.md); `src/server/server.ts` |
| Live session updates (SSE) | A debounced `fs.watch` on the sessions dir pushes updated session lists over `GET /api/events`. | The dashboard updates the instant a session changes state — no refresh, no polling. | `src/server/server.ts` (`/api/events`) |
| WebSocket attach bridge | `WS /api/sessions/:id/attach` translates between the browser JSON protocol and the binary daemon frame protocol. | Fully interactive terminals in the browser, wired straight to the live session. | `src/server/server.ts`; `rust/climon-proto` |
| Session REST APIs | `GET /api/sessions`, `GET /api/sessions/:id/scrollback`, `DELETE /api/sessions/:id` (clean up without stopping an attached client). | Programmatic access to the session list and final output, and one-click cleanup that never kills a running command. | `src/server/server.ts` |
| Health / version endpoint | Unauthenticated `GET /health` reports `{ ok, version, remotesEnabled, ports }`. | A simple liveness/version probe for scripts, monitoring, and cross-OS discovery. | [manual-tests/phase01-client-server-split.md](manual-tests/phase01-client-server-split.md); `src/server/server.ts` |
| Web Push pipeline | VAPID keypair + subscription store + attention tracker fan notifications out via `web-push`, pruning dead subscriptions. | Get alerted on your phone the moment a session needs you — even with the app closed. | `src/server/push/` (`vapid.ts`, `subscriptions.ts`, `attention.ts`, `send.ts`, `service.ts`) |
| Per-device foreground suppression | A presence registry (`POST /api/push/presence`, ~30s TTL) skips push to devices currently viewing the dashboard. | You don't get buzzed on the phone you're already looking at, but every other device still gets the alert. | `src/server/push/presence.ts`; `src/web/pwa/presence.ts` |
| Embedded web bundle | The compiled server binary embeds the React/Fluent/xterm bundle; the lean Rust client never carries UI code. | A single self-contained server binary, and a client that stays small no matter how the UI grows. | `src/server/embedded-assets.ts`, `src/server/assets.ts` |
| Tunnel Link (dashboard from your phone) | Hosts the dashboard behind an authenticated Microsoft dev tunnel private to your account; expiry is tracked. | Securely reach your dashboard from anywhere — the tunnel is private to your account and can't be shared. | [docs/troubleshooting.md](troubleshooting.md); `remote.dashboardTunnelEnabled` config; `src/server/` |
| Security: loopback-only privileged APIs | Session creation and other privileged routes only accept loopback connections. | Remote viewers can watch, but only the local machine can create or mutate sessions — the dashboard stays safe to expose over a private tunnel. | [docs/security.md](security.md); `src/server/server.ts` |
| Security: WebSocket attach Origin validation | Validates the `Origin` of attach WebSocket upgrades. | Blocks other web pages from hijacking your terminal WebSocket. | [manual-tests/security-ws-attach-origin.md](manual-tests/security-ws-attach-origin.md); `src/server/server.ts` |
| Security: DNS-rebinding guard | Guards dashboard reads/deletes against DNS-rebinding attacks. | A malicious site can't trick your browser into driving your local dashboard. | [manual-tests/security-dns-rebind.md](manual-tests/security-dns-rebind.md); `src/server/server.ts` |
| Security: Web Push endpoint SSRF guard | Validates push subscription endpoints before the server calls them. | Prevents the push sender from being abused to probe internal network addresses. | [manual-tests/security-push-ssrf.md](manual-tests/security-push-ssrf.md); `src/server/push/` |
| Security: project-local config global-only settings | Sensitive settings can only be set globally, never from a project-local config file. | A checked-out repo can't silently change security-relevant settings on your machine. | [manual-tests/security-config-global-only.md](manual-tests/security-config-global-only.md); `src/config-settings.ts` |

## Server — in development

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| Smart notification snippets | Extracts a clean ≤160-char snippet of the last relevant terminal paragraph (skipping UI chrome, hint bars, spinners) and uses it as the notification/toast body. | Notifications tell you *what* the session is asking — the agent's actual question — instead of a generic "needs attention", so you can triage without opening it. | `notifications.smartSnippet`; [manual-tests/smart-notifications.md](manual-tests/smart-notifications.md); capture in `rust/climon-session`, delivery in `src/server/push/`; **dev branch** |
| Remote spawn (dashboard → devbox) | With `feature.remoteSpawn`, the dashboard spawns sessions on a remote devbox over a signed (HMAC-SHA256), replay-protected mux command channel. | Start work on a remote machine from the dashboard without SSHing in first. | `feature.remoteSpawn`; [docs/security.md](security.md); `src/server/server.ts`, `rust/climon-remote` |

## Dashboard — in production

The React 19 + Fluent UI v9 single-page app (`src/web/`).

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| Prioritised session list | Renders every session with status badges, sorted by the shared priority model. | See all your sessions in one place and instantly which one is waiting on you. | `src/web`; `src/priority.ts` |
| Interactive terminal view | Live `running`/`needs-attention` sessions attach over WebSocket into an `xterm.js` terminal. | Type into and drive any session from the browser — answer a prompt without switching back to the original window. | `src/web/components/TerminalView` |
| Read-only scrollback replay | Finished sessions fetch and display their saved output read-only. | Review exactly what a completed command did, any time after it finished. | `src/web`; `GET /api/sessions/:id/scrollback` |
| Session cleanup from the UI | A per-row close box calls `DELETE /api/sessions/:id` without ending an attached client. | Tidy up your list with one click, without accidentally killing a running command. | `src/web/components/SessionItem.tsx` |
| Shared dashboard preferences | Theme + key-bar pin are stored as shared preferences that follow you across browsers and devices. | Set your preferences once and they follow you everywhere — home, work, phone. | [manual-tests/dashboard-preferences.md](manual-tests/dashboard-preferences.md); `dashboard.theme`, `dashboard.keyBarPinned` |
| Terminal theme picker | Pick a terminal colour theme from the dashboard. | Make the dashboard yours with a theme you like to look at all day. | [manual-tests/dashboard-preferences.md](manual-tests/dashboard-preferences.md); `dashboard.theme` |
| Pinnable, touch-responsive key bar | A mobile hamburger-toggled key bar of common keys, with width-responsive labels and inline docking on wide touch screens. | Send keys like Ctrl-C, arrows, and Enter on a touch device that has no physical keyboard for them. | [manual-tests/pin-key-bar.md](manual-tests/pin-key-bar.md), [manual-tests/keybar-touch-responsive.md](manual-tests/keybar-touch-responsive.md); `src/web` |
| Text staging area | Icon-only keybar chooser opens a full-viewport compose overlay with Insert / Cancel. | Compose or paste a longer input comfortably on mobile, then send it in one go. | [manual-tests/text-staging-area.md](manual-tests/text-staging-area.md); `src/web` |
| Terminal selection / copy (touch) | A Select button captures full scrollback into a monospaced textarea for native copy, with a strip-decorations toggle. | Copy terminal output on touch devices where normal terminal selection doesn't work. | [manual-tests/terminal-select-mode.md](manual-tests/terminal-select-mode.md); `src/web` |
| Terminal font-size repaint | The viewport repaints cleanly on font-size change without waiting for focus. | Resize text and see it apply immediately — no stale or half-rendered terminal. | [manual-tests/terminal-font-size-repaint.md](manual-tests/terminal-font-size-repaint.md); `src/web` |
| Foreground attention toast | While the dashboard is in the foreground, a subtle Fluent toast (with sound + vibration) announces a session needing attention; suppressed for the session you're viewing. | Get a gentle in-app nudge about another session without a jarring system notification while you're already working in the dashboard. | [manual-tests/foreground-attention-toast.md](manual-tests/foreground-attention-toast.md); `src/web/attentionAlerts.ts`, `src/web/attentionToast.ts` |
| Mobile active-session layout order | On mobile, the "Open terminal" button sits between the title and status/client meta. | A thumb-friendly layout that puts the primary action where you expect it on a phone. | [manual-tests/mobile-open-terminal-order.md](manual-tests/mobile-open-terminal-order.md); `src/web` |
| Tunnel-link expiry countdown banner | Shows a countdown banner as the dashboard's dev tunnel nears expiry. | Warns you before your phone loses access, so a session alert never silently stops reaching you. | [manual-tests/phase13-tunnel-expiry-banner.md](manual-tests/phase13-tunnel-expiry-banner.md); `src/web` |
| Focus-top-session hotkey | `hotKeys.focusTopSession` jumps focus to the highest-priority session. | One keystroke takes you straight to whatever needs you most. | `hotKeys.focusTopSession` config; `src/web` |

## Dashboard — in development

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| Spawn sessions from the dashboard | With `feature.sessionSpawning`, a per-session **[+]** (and a header **[+]** when empty) spawns a new session server-side, inheriting the parent's working directory — arbitrarily nestable. | Launch new sessions straight from the dashboard, in the right directory, without touching a terminal — including from your phone. | `feature.sessionSpawning`; `src/web/components/Sidebar.tsx`, `SessionItem.tsx`, `src/server/server.ts` (`POST /api/sessions`) |
| Remote hosts panel | A "Remote hosts" menu/panel lists connected remote devboxes from the loopback `GET /api/remotes` + SSE feed. | See and manage which remote machines are feeding sessions into your dashboard. | (with `feature.remotes`); [manual-tests/phase16-remotes-visibility.md](manual-tests/phase16-remotes-visibility.md); `src/web/components/RemoteHostsPanel.tsx` |
| OSC 9;4 terminal progress indicator | Captures the `OSC 9;4` taskbar-progress escape a program emits and renders it per-session: determinate bar, error/warning icons, or spinner; `dashboard.stateIconNoMotion` freezes the spinner. | See how far along a build or task is *from the session list itself*, without opening the terminal. | `dashboard.stateIconNoMotion`; [manual-tests/terminal-progress-indicator.md](manual-tests/terminal-progress-indicator.md); `rust/climon-session` (capture) + `src/web` (render); **dev branch** |
| Mobile session-list attention toast | Shows the attention toast on the mobile session-list view (previously suppressed there). | On a phone, you're alerted about a session needing attention even while looking at the list. | [manual-tests/foreground-attention-toast.md](manual-tests/foreground-attention-toast.md); `src/web`; **dev branch** |
| Searchable, light/dark-grouped theme picker | Expands the theme picker into a searchable list grouped by light/dark across the full theme set. | Find and preview the exact theme you want quickly, instead of scrolling a flat list. | `src/web`; **in-flight branch `all-dashboard-themes`** |
| Terminal scroll-wheel + icon-only chooser bar | An edge-on scroll-wheel component (shown when maximized) with momentum, plus an icon-only chooser bar. | Scroll long terminal output smoothly on touch devices that have no physical wheel. | [manual-tests/](manual-tests/); `src/web`; **in-flight branch `terminal-scroll-wheel`** |

## PWA — in production

Installable-app behaviours layered on the dashboard (`src/web/sw.ts`,
`src/web/pwa/`).

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| Installable app + offline cold boot | Service worker precaches the app shell (`/`, `/assets/app.js`, `/assets/xterm.css`) and serves it cache-first, rejecting dev-tunnel login responses so the cache can't be poisoned. | Install climon on your home screen and have it boot instantly, even when the tunnel would otherwise return an auth redirect. | `src/web/sw.ts`, `src/web/pwa/swCache.ts` |
| Background push notifications | Subscribes via `PushManager` using the server VAPID key and always shows a notification for every push received (non-silent, with vibration). | Your phone alerts you — sound and haptics — when a session needs you, even with the app fully closed. | `src/web/pwa/swPush.ts` |
| Notification tap opens the session | Tapping a notification focuses/opens the dashboard deep-linked to the exact session (`/?session=<id>` + `open-session` postMessage). | One tap on the alert takes you straight to the session that needs you — no hunting through the list. | [manual-tests/pwa-notification-click.md](manual-tests/pwa-notification-click.md); `src/web/pwa/swPush.ts`, `src/web/App.tsx` |
| In-PWA dev-tunnel re-auth | When the dev tunnel session expires, re-auth happens inside the PWA's own window (the service worker passes top-level navigations through); a "Sign in again" overlay drives it. | The installed app recovers from an expired tunnel by itself instead of getting stuck on a blank or auth screen — critical on iOS where the PWA has its own isolated cookie jar. | [manual-tests/dev-tunnel-reauth.md](manual-tests/dev-tunnel-reauth.md); `src/web/sw.ts`, `src/web/pwa/pwaContext.ts` |
| Presence reporting | Each open page reports foreground state to the server (`POST /api/push/presence`) on start, heartbeat, and `visibilitychange`. | Underpins per-device suppression so you're not double-alerted on the device you're actively using. | `src/web/pwa/presence.ts` |
| Zoom lock & no overscroll | Disables pinch-zoom and pins the page 1:1 on swipe. | A stable, app-like feel on mobile — the terminal doesn't accidentally zoom or bounce while you interact. | [manual-tests/pwa-zoom-lock.md](manual-tests/pwa-zoom-lock.md); `src/web` |

## PWA — in development

| Feature | What it does | Value add | Identified by |
|---|---|---|---|
| ⚠️ **needs discussion** — Custom push notification message | A branch `feat/push-notification-message` exists but currently has no commits ahead of `main`, so its intended scope is unclear. | _TBD once scope is defined._ | **in-flight branch `feat/push-notification-message` (empty)** — see [Open questions](#open-questions) |

---

## Open questions

Rows above tagged **⚠️ needs discussion**, plus judgement calls I made that you may
want to change:

1. **`feat/push-notification-message` branch is empty.** No commits ahead of `main`.
   Is this a planned feature (e.g. user-authored push message / reply from the
   notification) that hasn't been started, or a stale branch to drop from this list?
2. **Smart notification snippets placement.** I filed it under *Server — in
   development* because the deliverable is the notification/toast body, but the
   novel logic (the fuzzy snippet extractor) lives client-side in
   `rust/climon-session`. Happy to move it to *Client* if you'd rather group by
   where the code lives.
3. **Cross-cutting remotes.** The remote uplink/ingest bridge spans client, server,
   and dashboard. I listed the core capability once under *Client — in development*
   and its dashboard surface (Remote hosts panel) and remote-spawn separately, to
   avoid duplicating one big feature across four sections. Tell me if you'd prefer
   it consolidated or split differently.
4. **In-flight branch scope.** `all-dashboard-themes` and `terminal-scroll-wheel`
   have real commits but aren't merged. I included them as *in development*; the
   scroll-wheel manual-test file path isn't pinned yet (link points at the dir).

## Maintaining this document

Keep this catalogue in lockstep with the code, the same way `docs/manual-tests/`
is a definition-of-done artifact:

- When a feature **ships** (merges to `main` and isn't feature-flagged), move its
  row from an *in development* section to the matching *in production* section.
- When a new feature lands **on `dev` / a branch** or behind a `feature.*` flag,
  add a row to the matching *in development* section with its manual-test link and
  source path.
- When a `feature.*` flag flips to enabled-by-default and merges to `main`, promote
  the gated rows to production.
- Keep the "Value add" honest and grounded in what the code does — no aspirational
  claims.
