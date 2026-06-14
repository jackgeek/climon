# Security

Security is the top design priority for climon's remote-client feature. This
document describes the threat model and every hardening measure so reviewers can
audit the design.

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

## Secrets at rest

- `~/.climon/remote-host.json` — the home machine's tunnel-host state. Written
  atomically (temp file + `rename`, so the ingest watcher never observes a torn
  or empty file) with `0600` permissions inside a `0700` directory.

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

### Limitation: shared-identity namespaces are self-asserted

The tunnel ACL authenticates each connection, but there is **no per-client
authentication** beyond that. The `clientId` that selects a session namespace is
self-asserted in the `hello` frame, so any user with tunnel access can claim
another devbox's `clientId` and overwrite the *dashboard metadata* (status, name,
color, command label) it advertises. It cannot inject into another client's PTY
(per-connection sockets) or read its keystrokes. Revoke access by deleting
the tunnel or removing the user's identity from its ACL.

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

## Untrusted-input handling

- **Session metadata** (`toLocalMeta` / `sanitizeRemotePatch`): server-controlled
  fields overwritten, ids namespaced and validated, enum fields allowlisted.
- **Mux frames**: every frame is length-prefixed and capped
  (`MAX_MUX_PAYLOAD = 8 MiB`); an oversize or malformed frame tears the
  connection down rather than allocating unbounded memory.

## Integrity of managed files

The tunnel-host state file (`remote-host.json`) and the devbox config are written
atomically (temp file + `rename`) with `0700` directories and `0600` files, so a
crash mid-write cannot corrupt or truncate them, and the ingest daemon's watcher
never reads a partially-written file.

## What a compromised devbox can and cannot do

| Capability | Allowed? |
|---|---|
| Stream its own session output to the dashboard | Yes (by design) |
| Receive keystrokes the user types into its sessions | Yes (by design) |
| Inject arbitrary local paths or server-controlled fields | **No** (`isValidRemoteId` + `toLocalMeta` sanitization) |
| Read another client's keystrokes or inject into its PTY | **No** (per-connection sockets) |
| Spoof another client's *dashboard metadata* | Yes, if it has tunnel access (see limitation above) |
| Reach the dashboard HTTP server | **No** (loopback only) |
| Keep connecting after access is revoked | **No** (auth rejection is terminal) |

## Revocation

Revoking a client is done by deleting the dev tunnel or removing the user's
identity from its access list. Once the host rejects the connection, the
uplink stops retrying, immediately ending its ability to connect.
