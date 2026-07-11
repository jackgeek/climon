# Security

Security is the top design priority for climon's remote-client feature. This
document describes the threat model and every hardening measure so reviewers can
audit the design.

> **Implementation note (Phase-12 cutover).** The shipped `climon` *client* — and
> therefore all of the untrusted-input handling described here (mux frame caps,
> remote-id validation, metadata namespacing/sanitization, patch allowlists, and
> loopback-only privileged dashboard APIs) — is the native **Rust** binary built
> from the `rust/` workspace (the `climon-remote` crate owns the remote
> ingest/uplink trust boundary). The dashboard **server** (`climon-server`) remains
> the maintained Bun binary. The old Bun client has been removed; the controls
> below apply to the shipped Rust client and the Bun dashboard server over their
> shared wire/metadata/config surfaces. The native Rust self-installer
> (`climon-install`)
> performs the same atomic, non-destructive file placement described under
> *Integrity of managed files* and *Non-destructive update guarantee*.

## Threat model

climon lets a session running on a remote machine (a "devbox") appear on a
central dashboard (the "home" machine). The transport crosses untrusted
networks. We assume:

- The network between devbox and home is hostile (active MITM possible).
- The dashboard HTTP server must never be reachable by anyone but the local user.
- A compromised or malicious devbox must not be able to escalate beyond
  streaming its own session I/O.
- Input arriving over the wire (mux frames, session metadata, labels) is
  untrusted.

## Project-local config trust

Project-local `.climon/config.jsonc` files are treated as untrusted when a user
starts climon inside a cloned repository. They may override only non-security
settings. Execution, network, and update trust-boundary settings are marked
`globalOnly`/`global_only` in the TypeScript and Rust registries and are resolved
solely from the global `$CLIMON_HOME/config.jsonc`: `session.terminalProgram`, all
`remote.*` settings, and all `update.*` settings.
An explicit `climon config --local` write for one of these keys warns that the
local value is not honored and suggests using `--global`.

## Transport: identity-based dev tunnels

Remote traffic rides a Microsoft **dev tunnel** rather than SSH. The home
machine runs a loopback-only ingest listener (`__ingest`); a dev tunnel exposes
that single port to the devbox. The access boundary is the **dev tunnel's
identity-based ACL** — only authenticated users with access to the tunnel can
connect:

- The home `__ingest` daemon binds `127.0.0.1` only. It is never bound to a
  public interface directly — the tunnel host process is the only thing that
  fronts it.
- The connecting devbox must be logged into `devtunnel` with a Microsoft/GitHub
  identity that has access to the tunnel. The uplink stops retrying once the
  host rejects the connection (auth failure is terminal, not retried as a
  transient network error).
- Host-side dev-tunnel management is gated by `feature.remotes`. When enabled,
  climon derives an opaque stable id from the non-secret `install.id`
  (`climon-ingest-<hash>`), so the public tunnel URL never contains the
  hostname. The `climon-ingest` label and description JSON contain only
  display metadata (`app`, `role`, `clientId`, `hostname`, `version`) and never
  include `remote.spawnSecret`, tokens, or credentials.
- When climon auto-creates the tunnel, it also opens a keep-alive TCP port so
  the tunnel stays up and never presents an interactive confirmation page to a
  browser.
- Devbox auto-discovery is scoped to the authenticated dev tunnel identity:
  `devtunnel list --labels climon-ingest --json` returns only that user's own
  tunnels, and climon treats a discovered host as live only when
  `hostConnections >= 1`. Fan-out only opens outbound uplinks to those already
  authorized tunnels plus any explicit target the user configured.
- `remote.discover false` disables devbox discovery while preserving explicit
  `remote.tunnelId` / `remote.host` setups. `CLIMON_DISABLE_DEVTUNNEL=1` (or
  `true`) disables all devtunnel interaction on both host and devbox — probing,
  tunnel creation, and list/connect/show/port calls.

## Direct same-machine bridge

For Windows/WSL on the same machine, `remote.host` lets an uplink connect
directly to the dashboard side's ingest daemon without `devtunnel`. The dashboard
side can set `remote.ingestHost` to bind that ingest daemon on a host address the
other side can reach.

Direct mode has no dev tunnel in front of the ingest port. Treat
`remote.ingestHost:remote.port` as trusted-local infrastructure: bind to the
specific same-machine adapter where possible, not a broad LAN address, and rely
on the OS firewall to keep that port scoped to the local Windows/WSL boundary.

The WSL bridge is gated by the `feature.wslBridge` flag (and the shared ingest by
`feature.wslBridge || feature.remotes`). The flag flips on **only by explicit user
action** — the interactive `climon link` prompt, `climon link --wsl-bridge`, or
`climon config feature.wslBridge enabled`. Auto-link wires read-only discovery
(`remote.peerHome`) but never enables the bridge, and non-interactive `climon link`
defaults to leaving it off. Flag changes take effect on the next server **restart**,
not immediately. **Interim exposure:** the ingest's same-machine-`peer` transport
guard (gate #3) ships with the Rust ingest cutover; until that lands, enabling
`feature.remotes` alone on a Windows+WSL host starts an ingest bound to the
`vEthernet (WSL)` adapter that a same-machine WSL process can reach even with
`feature.wslBridge` off — so the WSL-bridge feature flag must not be released ahead
of the ingest cutover.

### Beacon-based discovery (`remote.peerHome`)

`climon link` (and the lazy auto-link on the first WSL run) records the peer
OS's `CLIMON_HOME` in `remote.peerHome`, and discovery reads the peer's
`server.json` over the shared mount to find a dashboard on the other OS.
`remote.peerHome` is only ever **read**, and only the small `server.json` beacon
is parsed: pid/port/ingest are strictly validated as positive integers and no
path from the peer is used to load or execute code. Liveness of a peer beacon is
proven by a TCP probe of the peer ingest's published port, never by trusting its
(cross-namespace) PID.
The same loopback/firewall guidance above applies, since the auto-wired uplink
still terminates at the dashboard side's ingest port. Auto-link only acts from
WSL, only when a Windows climon is already present, and can be disabled with
`remote.autoLink false`.

### Same-machine handoff control channel (filesystem)

Switching the dashboard host between WSL and Windows is coordinated entirely over
the shared filesystem — there is **no** network shutdown channel and **no** token.
To displace a peer host, the promoting OS writes a `shutdown-request.json`
(`{requestedBy,ts}`) into the peer's `CLIMON_HOME` over the mount. The peer's
durable ingest watches its own home and demotes on the next well-formed request.

- **Authorized by the filesystem, not a token.** Writing the request already
  requires same-user write access to the peer's home — that IS the authorization. A
  token read from one same-user file (`ingest.json`) and copied into another adds
  nothing the filesystem permissions don't already enforce, so PR #65's CSPRNG
  `shutdownToken` is removed from both beacons.
- **Replay-safe without a token:** the ingest clears any request present at startup
  (it cannot be for this fresh instance) and consumes a request immediately after
  acting, so a stale or leftover request cannot demote a later instance. The request
  is length-bounded and allow-listed (`requestedBy ∈ {WSL, Windows}`, positive `ts`);
  malformed or oversized files are ignored.
- Removing PR #65's network shutdown channels (`DELETE /api/server` and the mux
  `control:{op:"shutdown"}` frame) **shrinks** the surface: nothing privileged
  travels over HTTP or the mux, all privileged dashboard APIs are loopback-gated with
  no exemptions, and the mux accepts only `hello`-gated data frames.
- **Data-plane exposure:** when Windows hosts, the ingest binds the host-only
  `vEthernet (WSL)` adapter — reachable from the WSL VM and the Windows host, not
  the LAN. When WSL hosts, the ingest binds loopback only.

## Remote spawn command channel

The dashboard "+" can create a session on the **machine a remote session lives
on** (a devbox), not just on the server host. This is the one place the server
sends an *imperative command* to a client, so it is gated and authenticated:

- **Opt-in, off by default.** The `feature.remoteSpawn` flag is `disabled`
  unless explicitly enabled on **both** the dashboard host and the devbox. While
  it is off, no spawn command is honored and **no HMAC secret is ever created**.
- **Pre-shared HMAC secret.** When the feature is enabled on the dashboard host,
  a 32-byte CSPRNG `remote.spawnSecret` is generated lazily and persisted
  globally (`0600`). The remotes-screen copy script plants the *same* secret on
  the devbox (`climon config remote.spawnSecret …`) and enables the flag there.
  The secret is the sole app-layer authenticator on the direct-WSL bridge.
- **Signed, replay-protected envelope.** Every server→devbox spawn is wrapped in
  an HMAC-SHA256 `Signed` envelope over `payload\nnonce\nts`. The devbox verifies
  the signature with a constant-time compare, requires `ts` within a ±30 s
  freshness window, and rejects any `nonce` already seen in a bounded recent-set.
- **Enabling the feature hardens the entire inbound channel.** When the devbox
  has a secret set, the uplink requires **every** inbound control frame
  (`attach`/`detach`/`ping`/`spawn`) to be a verified `Signed` envelope; unsigned,
  forged, stale, or replayed frames are dropped. No secret ⇒ `Spawn` is ignored
  entirely (legacy behavior), so the security invariant is **no secret ⇒ no
  remote spawn**.
- **Loopback-only server→ingest hop.** The dashboard server reaches its own
  ingest over a loopback-only control socket (advertised as `controlSocket` in
  `ingest.json`); the ingest signs the `Spawn` and forwards it over the existing
  mux, then relays the devbox's signed `SpawnResult` back. The control socket is TCP
  loopback, so it is reachable by any local process; the ingest therefore generates a
  per-run `controlToken` (published in the `0600` `ingest.json`) and requires it on
  every request via a constant-time compare before dispatch. Its secrecy rests on the
  beacon file permissions — **same-uid only** — the same filesystem-permission basis used
  for the shutdown channel above. The `spawnSecret` signs the outbound devbox frame; the
  `controlToken` authenticates the caller of the loopback socket. Gate #3 (the ingest
  refusing a same-machine `peer` connection when `feature.wslBridge` is off) is a
  **feature/misconfiguration guard, not a security boundary**: `peer` is self-asserted on
  the wire, so a hostile uplink that omits it is not stopped by gate #3 alone.
- **Threat model.** Over dev tunnels the tunnel's identity ACL already restricts
  who can connect; the HMAC adds command authenticity on top. On the direct
  same-machine (WSL↔Windows) bridge there is no tunnel ACL, so the HMAC secret is
  the authenticator that prevents a co-tenant process from injecting spawns.

## Secrets at rest

- `~/.climon/remote-host.json` — the home machine's tunnel-host state. Written
  atomically (temp file + `rename`, so the ingest watcher never observes a torn
  or empty file) with `0600` permissions inside a `0700` directory. For
  auto-managed remotes this records the stable `climon-ingest-…` tunnel id and
  current ingest port; it does not store devtunnel credentials.
- `remote.spawnSecret` (in `config.jsonc`) — the pre-shared HMAC key for the
  remote spawn command channel. Generated only when `feature.remoteSpawn` is
  enabled, stored in the `0700` config directory, and redacted from logs and
  config listings as a sensitive setting.

## Logging

Logs are written locally under `$CLIMON_HOME/logs/` by default and never leave the
machine unless you opt in. Secrets (auth tokens, tunnel credentials, the App
Insights connection string) are redacted to `[REDACTED]` in all log output. The
Application Insights sink is the only network egress path for logs and is disabled
unless you opt in with `telemetry.enabled` **and** a connection string is supplied
via the `APPLICATIONINSIGHTS_CONNECTION_STRING` environment variable or the
build-time embedded constant (injected from a CI secret at release-compile time,
never stored in climon config or committed to source). See
[`logging.md`](logging.md).

## Containment: server-side sanitization

A devbox only streams session I/O and metadata; it can never name another
client's sessions or inject server-controlled fields. The ingest connection
handler enforces this:

A devbox streams session I/O and metadata under a `clientId` namespace; it can
never inject server-controlled fields or escape that namespace into arbitrary
local paths. The ingest connection handler enforces this:

- **`toLocalMeta`** overwrites all server-controlled fields and namespaces every
  session id by the connection's `clientId`, so session ids cannot collide
  across clients and a devbox cannot inject arbitrary local paths.
- **`isValidRemoteId`** rejects ids (and the `clientId`) that are not well-formed
  (`[A-Za-z0-9._-]`, `~` reserved as the namespace separator) before they are
  used to construct any local path, preventing path traversal.
- **`sanitizeRemotePatch`** validates incoming metadata patches against the same
  allowlists used for local sessions (status, priority reason, color), dropping
  anything unrecognized.
- Status, `priorityReason`, and `color` fields are validated against fixed
  allowlists; out-of-range priorities and unknown colors are coerced to safe
  defaults rather than trusted.
- Inbound control frames are processed **strictly in order** (a per-connection
  FIFO chain), so the routine duplicate `session-added` frames the devbox emits
  on every file-watch tick cannot race two concurrent binds onto one socket.

### Remote visibility status files + untrusted hello identity

The remote-visibility feature publishes two local status beacons under
`$CLIMON_HOME` — `ingest-status.json` (written by the ingest) and
`uplink-status.json` (written by a devbox uplink supervisor). They carry only
hostnames, LAN addresses, and connection counts — **no secrets** — and are
never network-exposed: they are plain files written `0600` inside the `0700`
`$CLIMON_HOME`, readable by the owning user only. `GET /api/remotes` (and its
SSE `remotes` event), which surfaces this data to the dashboard, is
**loopback-only** (it returns `403` for non-loopback callers, like the other
privileged dashboard APIs).

`hello.hostname` and `hello.os` are **attacker-controlled** (a devbox is
untrusted input). They are sanitized once at the ingest trust boundary, before
they are stored or rendered anywhere:

- `hostname` is capped to **64 chars** and stripped of C0/C1 control bytes
  (including `ESC`), so a malicious devbox cannot smuggle ANSI escape sequences
  into the `climon remotes` terminal output (clear-screen, color, title) or
  oversize the status file.
- `os` is **allowlisted** to `darwin`/`win32`/`linux`; anything else folds to
  `unknown`.

Because sanitization happens at storage time, every downstream sink (the
`climon remotes` TTY renderer, `--json`, and the dashboard, which additionally
renders via auto-escaping React text nodes) only ever formats already-safe
strings. The server payload for `/api/remotes` is also built field-by-field
(not spread from the file) so an unexpected field in the status file cannot ride
into the API response.

### Limitation: shared-identity namespaces are self-asserted

The tunnel ACL authenticates each connection, but there is **no per-client
authentication** beyond that. The `clientId` that selects a session namespace is
self-asserted in the `hello` frame, so any user with tunnel access can claim
another devbox's `clientId` and overwrite the *dashboard metadata* (status, name,
color, command label) it advertises. It cannot inject into another client's PTY
(per-connection sockets) or read its keystrokes. Revoke access by deleting
the tunnel or removing the user's identity from its ACL.

When the dev-tunnel sign-in expires while the dashboard is open, it detects the
relay's auth redirect (a manual-redirect probe of `/health`) and shows an in-app
"Sign in again" prompt instead of spinning on "Reconnecting". The prompt performs
a user-initiated top-level navigation to the dashboard origin to re-run the
Microsoft sign-in; it never auto-navigates and stores no tunnel credentials
itself.

The dev tunnel's authentication is a **cross-origin** redirect
(`*.devtunnels.ms` → Microsoft), handled by the relay before any traffic reaches
climon. This has two platform consequences on iOS, neither fixable in climon:

- **Installed PWA:** an iOS home-screen PWA runs as a standalone WKWebView that
  blocks *script-initiated* cross-origin navigations, so the in-app prompt cannot
  refresh the cookie there. Instead, the service worker **never intercepts
  top-level navigations** (it only caches JS/CSS assets), so the PWA's own
  *launch* navigation follows the auth redirect — a cold relaunch re-authenticates
  exactly like a fresh install. Use **Chrome** to install the PWA.
- **Safari:** iOS Safari mishandles the relay's auth redirect and downloads an
  empty file instead of showing the sign-in page. This is a Safari + dev-tunnel
  limitation; use Chrome (or Edge) to sign in.

## Dashboard server: loopback only

The dashboard HTTP/WebSocket server binds to `127.0.0.1` exclusively. There is
no network-exposed listener and no long-lived shared secret. Remote visibility
is achieved solely by the home user running the dashboard locally; devboxes
connect to the tunnelled ingest port, never to the HTTP server.

Privileged endpoints (session spawn, the Remotes management API) require, in
addition to a loopback source IP:

- a JSON `content-type` (forcing a CORS preflight that the server never grants),
  and
- a loopback `Origin`/`Host`,

which together defend against browser-mediated CSRF and DNS-rebinding from a page
running on the same machine (`isAllowedSpawnRequest`).

The WebSocket attach upgrade performs an equivalent `Origin` check: browser
requests must be same-origin with `Host`, and `Host` must be loopback or the
dashboard dev-tunnel domain, defending against Cross-Site WebSocket Hijacking and
DNS-rebinding for terminal attach traffic.

Session read, SSE, and cleanup endpoints (`GET /api/sessions`,
`GET /api/sessions/:id/scrollback`, `GET /api/events`, and
`DELETE /api/sessions/:id`) also require an allowed dashboard `Host`: loopback
for direct local access or `*.devtunnels.ms` for the tunnel relay. These routes
do not require an `Origin` header, but the Host allowlist blocks DNS-rebinding
requests such as `Host: evil.com` before session metadata, scrollback, SSE
payloads, or delete side effects are produced.

## Web Push endpoints and subscription storage

The push endpoints are reachable over the dev tunnel (the phone is not loopback),
so they inherit the tunnel's identity ACL as their access boundary:

- `GET /api/push/vapid-public-key` — returns the server's public VAPID key.
- `POST /api/push/subscribe` / `POST /api/push/unsubscribe` — guarded by
  `isSameOriginRequest`: a JSON content-type plus an `Origin` whose host equals the
  `Host` header. This blocks cross-origin/CSRF while still permitting the tunnel
  origin (unlike `isAllowedSpawnRequest`, which is loopback-only and stays in force
  for privileged spawn/patch/tunnel endpoints).

Subscribed Web Push endpoints are additionally validated as `https:` URLs whose
host is not a loopback, private, or link-local IP literal and is not a known
internal hostname such as `localhost`, `*.localhost`, `*.local`,
`local`, `metadata.google.internal`, `*.internal`, `ip6-localhost`, or
`ip6-loopback`. DNS hostnames are not resolved at subscribe time, so normal
public browser push service hosts such as FCM, Mozilla Push Service, or Apple
Push remain accepted while direct internal-host SSRF targets are rejected before
they can be stored.

The VAPID private key (`$CLIMON_HOME/push/vapid.json`) and subscriptions
(`$CLIMON_HOME/push/subscriptions.json`) are stored under `$CLIMON_HOME` and are not
part of user config. Subscriptions are pruned automatically when a push send returns
HTTP 404/410. Push payloads contain only the session label and attention reason
already visible in the dashboard — no scrollback or command output.

## Dashboard preferences endpoint

The dashboard persists a small set of cosmetic preferences (currently the
terminal theme and the mobile key-bar pin) in `config.jsonc` so they are shared
across browsers and devices. Remote Tunnel Link viewers are intentionally allowed
to change these, so the write path is same-origin guarded rather than
loopback-only:

- `POST /api/dashboard/preferences` — guarded by `isSameOriginRequest` (JSON
  content-type plus an `Origin` whose host equals the `Host` header), exactly like
  the push endpoints. This permits the tunnel origin while blocking
  cross-origin/CSRF and DNS-rebinding.
- Writes are restricted to an **allowlist**: only config settings flagged
  `dashboardWritable` in `src/config-settings.ts` are accepted. Each write must
  also pass the setting's declared type and its per-setting `validate` check
  (e.g. the theme must be one of the known `THEME_IDS`). A forged or malicious
  same-origin request can therefore at most change a validated cosmetic
  preference — it can never reach non-allowlisted keys such as `server.port` or
  any client/daemon setting.
- Effective values are exposed read-only via `/health` (`preferences`), which the
  server treats as the source of truth and the browser reconciles on load.

## Untrusted-input handling

- **Session metadata** (`toLocalMeta` / `sanitizeRemotePatch`): server-controlled
  fields overwritten, ids namespaced and validated, enum fields allowlisted.
  Free-text fields (such as `attentionSnippet` and `terminalTitle`) are
  allowlisted and bounded to 4096 chars to prevent oversize payloads; the
  snippet is untrusted terminal output content from a remote devbox.
- **Mux frames**: every frame is length-prefixed and capped
  (`MAX_MUX_PAYLOAD = 8 MiB`); an oversize or malformed frame tears the
  connection down rather than allocating unbounded memory.
- **Hello identity** (`hello.hostname` / `hello.os`): attacker-controlled
  fields surfaced by `climon remotes` and the dashboard. The ingest sanitizes
  them at the boundary — `hostname` capped to 64 chars with C0/C1 control bytes
  and ESC stripped, `os` allowlisted to `darwin`/`win32`/`linux` (else
  `unknown`) — so a malicious devbox cannot inject terminal escape sequences
  into a TTY or oversize the `ingest-status.json` beacon. The
  `ingest-status.json` / `uplink-status.json` beacons are local files under
  `$CLIMON_HOME` (mode `0600`) carrying hostnames/addresses only — no secrets,
  not network-exposed; `GET /api/remotes` is loopback-only (403 otherwise).
- **Dashboard HTTP Hosts** (`isAllowedDashboardHost`): session list,
  scrollback, SSE, and DELETE handlers accept only loopback or
  `*.devtunnels.ms` Host headers, preventing DNS-rebinding pages from using a
  local source IP to read or remove sessions.

## Integrity of managed files

The tunnel-host state file (`remote-host.json`) and the devbox config are written
atomically (temp file + `rename`) with `0700` directories and `0600` files, so a
crash mid-write cannot corrupt or truncate them, and the ingest daemon's watcher
never reads a partially-written file.

## Telemetry

Telemetry is **opt-in and off by default** (`telemetry.enabled`). When enabled,
the only identifier attached is a random, anonymous `install.id` generated
locally. climon does **not** collect:

- session output or terminal scrollback,
- command lines, arguments, or their contents,
- file paths, working directories, or file contents,
- hostnames, usernames, IP addresses, or other PII.

Disable it at any time with `climon config telemetry.enabled false` or by
re-running `climon setup`.

For the full data-handling details, legal basis, and your rights, see the
[Privacy Policy](privacy.md).

## Update trust model

Releases are signed with an **Ed25519** private key held only in CI (the
`CLIMON_UPDATE_PRIVATE_KEY` secret, scoped to a single signing step). Each
release artifact (`climon-<platform>.zip`) is published alongside a detached
`.zip.sig` signature and a `manifest.json` listing the artifacts.

When applying an update (`climon update`, or the background path when
`update.auto` is enabled), the client:

1. fetches the manifest and downloads the artifact and its detached signature
   (downloads are size-capped to bound resource use),
2. verifies the Ed25519 signature over the **complete** release ZIP — which
   includes the installer `install[.exe]` — against the **embedded public key**
   before touching any file,
3. rejects tampered or unverifiable downloads, making **no changes**, and
4. only then safely extracts the verified archive to a staging directory and
   invokes the new release's installer, which owns all binary placement and
   layout migration. No extracted file is executed before verification, and safe
   extraction rejects absolute paths, parent-traversal, and symlink entries.

The private signing key is never logged or written to disk in CI, and is kept
out of the environment of `curl | bash` and `bun install` steps so a compromised
dependency cannot exfiltrate it.

### Signed plaintext distribution

Release artifacts are distributed as plaintext `.zip` files plus detached
Ed25519 `.sig` files from the `jackgeek/climon` GitHub release. The security
boundary is integrity, not confidentiality:

1. fetch the manifest from
   `https://github.com/jackgeek/climon/releases/latest/download/manifest.json`,
2. download the `.zip` artifact and its detached `.zip.sig`,
3. **verify the Ed25519 signature** over the downloaded zip,
4. unzip and atomically swap the binary.

If signature verification fails, the client rejects the download and makes no
changes. Legacy manifests that still contain an `encryption` field are parsed
tolerantly, but current clients do not decrypt artifacts and current releases do
not publish encrypted update assets.

### Signed universal bootstrap for legacy installs

Already-installed legacy clients still copy the new `install[.exe]` over their own
`climon[.exe]`. That migration to the installer-owned layout is authenticated by
**two independent signed hops over two separate downloads**:

1. the already-released client verifies the Ed25519 signature over the complete
   release ZIP (including `install[.exe]`) before it replaces `climon[.exe]`;
2. the renamed binary, dispatched into recovery-bootstrap mode by its executable
   basename, **independently re-downloads** the canonical release and re-verifies
   its Ed25519 signature with the embedded public key before extracting or
   executing anything.

There is no unsigned installer execution path in either hop, and safe extraction
rejects traversal and symlink entries in both. On Windows the offline fallback
target is the locally derived `<install-dir>\climon.exe.old`; it is resolved from
the install directory and is **never** manifest-controlled. Arguments are passed
directly to the installer process, never through a shell.

Production binaries lack the test-endpoint override entirely: the dev-only
`test-update-endpoint` cargo feature (and its `CLIMON_UPDATE_PUBKEY_B64` build
override) is compiled out of shipped builds, so a production client ignores
`CLIMON_TEST_MANIFEST_URL`, only ever contacts the canonical release endpoint,
and always embeds the real update public key.

## Non-destructive update guarantee

climon self-update **never kills running climon processes** — not sessions,
daemons, or the dashboard server. The client updater only stages and verifies the
archive; the new release's installer then places binaries so that running
processes are never disturbed:

- **Unix:** atomic rename-over. Running processes keep the old inode/code; new
  invocations use the new binary.
- **Windows:** the installer writes fresh versioned payloads, displaces the locked
  `climon.exe` / `climon-server.exe` stubs to their `.old` siblings and rewrites
  them, then atomically flips the `climon.version` / `climon-server.version`
  pointers. Renaming a running executable is allowed on Windows and the
  version-specific code lives in the DLL, so it never has to kill or wait on a
  process holding the running binary; superseded versioned files are reaped later
  once Windows releases their locks.

Already-running sessions continue on the old code; newly started sessions and a
restarted server pick up the new version.

## What a compromised devbox can and cannot do

| Capability | Allowed? |
|---|---|
| Stream its own session output to the dashboard | Yes (by design) |
| Receive keystrokes the user types into its sessions | Yes (by design) |
| Inject arbitrary local paths or server-controlled fields | **No** (`isValidRemoteId` + `toLocalMeta` sanitization) |
| Read another client's keystrokes or inject into its PTY | **No** (per-connection sockets) |
| Spoof another client's *dashboard metadata* | Yes, if it has tunnel access (see limitation above) |
| Delete another client's materialized sessions by spoofing its `clientId` + an empty `session-list` | Only when the ingest has no `remote.spawnSecret`; with a secret set, `session-list` must be a verified `Signed` envelope (deletion stays scoped to the spoofed namespace, never local sessions) |
| Reach the dashboard HTTP server | **No** (loopback only) |
| Keep connecting after access is revoked | **No** (auth rejection is terminal) |

## Revocation

Revoking a client is done by deleting the dev tunnel or removing the user's
identity from its access list. Once the host rejects the connection, the
uplink stops retrying, immediately ending its ability to connect.
