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
> the Bun binary. The two implementations enforce the same boundaries over the same
> wire/metadata formats; the controls below apply to the shipped Rust client and
> the legacy Bun client alike. The native Rust self-installer (`climon-install`)
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
- When climon auto-creates the tunnel, it also opens a keep-alive TCP port so
  the tunnel stays up and never presents an interactive confirmation page to a
  browser.

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
  or empty file) with `0600` permissions inside a `0700` directory.
- `remote.spawnSecret` (in `config.jsonc`) — the pre-shared HMAC key for the
  remote spawn command channel. Generated only when `feature.remoteSpawn` is
  enabled, stored in the `0700` config directory, and redacted from logs and
  config listings as a sensitive setting.

## Logging

Logs are written locally under `$CLIMON_HOME/logs/` by default and never leave the
machine unless you opt in. Secrets (auth tokens, tunnel credentials, the App
Insights connection string) are redacted to `[REDACTED]` in all log output. The
Application Insights sink is the only network egress path for logs and is disabled
unless a connection string is configured (`logging.appInsights.connectionString`
or `APPLICATIONINSIGHTS_CONNECTION_STRING`). See [`logging.md`](logging.md).

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

When the browser's dev-tunnel sign-in expires, the dashboard PWA detects the
relay's auth redirect (a manual-redirect probe of `/health`) and shows an
in-app "Sign in again" prompt instead of spinning on "Reconnecting". The prompt
performs a user-initiated top-level navigation to re-run the Microsoft sign-in;
it never auto-navigates and stores no tunnel credentials in the browser.

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

## Web Push endpoints and subscription storage

The push endpoints are reachable over the dev tunnel (the phone is not loopback),
so they inherit the tunnel's identity ACL as their access boundary:

- `GET /api/push/vapid-public-key` — returns the server's public VAPID key.
- `POST /api/push/subscribe` / `POST /api/push/unsubscribe` — guarded by
  `isSameOriginRequest`: a JSON content-type plus an `Origin` whose host equals the
  `Host` header. This blocks cross-origin/CSRF while still permitting the tunnel
  origin (unlike `isAllowedSpawnRequest`, which is loopback-only and stays in force
  for privileged spawn/patch/tunnel endpoints).

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

## Update trust model

Releases are signed with an **Ed25519** private key held only in CI (the
`CLIMON_UPDATE_PRIVATE_KEY` secret, scoped to a single signing step). Each
release artifact (`climon-<platform>.zip`) is published alongside a detached
`.zip.sig` signature and a `manifest.json` listing the artifacts.

When applying an update (`climon update`, or the background path when
`update.auto` is enabled), the client:

1. fetches the manifest and downloads the artifact and its detached signature
   (downloads are size-capped to bound resource use),
2. verifies the signature against the **embedded public key** before touching
   any file, and
3. rejects tampered or unverifiable downloads, making **no changes**.

The private signing key is never logged or written to disk in CI, and is kept
out of the environment of `curl | bash` and `bun install` steps so a compromised
dependency cannot exfiltrate it.

### Encrypted gated distribution

On top of the Ed25519 signing layer, climon adds a **casual gating** mechanism
to restrict update downloads to authorized users. This uses a single shared
password to encrypt release artifacts; the password is:

- stored in client config (`update.password`, marked `sensitive: true` and
  redacted to `[REDACTED]` in `climon config list` output and logs),
- (in a future out-of-band installer, not yet implemented) embedded in installers,
  so an authorized holder *can* extract it.

**This is NOT cryptographic per-user access control.** The shared password is
extractable by any authorized user, and there is no per-user revocation —
rotating the password (`CLIMON_DISTRIBUTION_PASSWORD` in CI) revokes everyone
at once. Clients with the old password freeze at their current version until
they receive and configure the new password.

**Encryption is a convenience layer on top of Ed25519 integrity**, not a
replacement. The client flow is:

1. fetch the manifest from the public releases repository
   (`jackgeek/climon-releases`),
2. download the encrypted `.enc` artifact,
3. **decrypt** using the password from `update.password`,
4. **verify the Ed25519 signature** over the decrypted plaintext zip (the
   signature is still computed over plaintext, not ciphertext),
5. unzip and atomically swap the binary.

If decryption or signature verification fails, the client rejects the download
and makes no changes. The encryption scheme is `aes-256-gcm-scrypt-v1`
(AES-256-GCM with an scrypt-derived key); see
[deployment.md](./deployment.md#encrypted-gated-distribution) for the full
operator runbook and rotation procedure.

## Non-destructive update guarantee

The updater **never kills running climon processes** — not sessions, daemons, or
the dashboard server. It replaces binaries using:

- **Unix:** atomic rename-over. Running processes keep the old inode/code; new
  invocations use the new binary.
- **Windows:** displace the target to a `.old` sibling, then rename the verified
  temp file into place; on EBUSY/EPERM/EACCES it **defers** rather than killing
  the holder, and restores the displaced binary if the final rename fails.

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
