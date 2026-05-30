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
- Input arriving over the wire (public keys, mux frames, labels) is untrusted.

## Transport: hardened SSH only

All remote traffic rides a single OpenSSH connection initiated by the devbox.
There are **no tunneled ports** — every session multiplexes over the one SSH
stdio channel, so nothing new is exposed to the network.

The devbox connects with these mandatory flags (see `buildSshArgs`):

- `StrictHostKeyChecking=yes` with a pinned, project-local `UserKnownHostsFile`
  — the home host key is recorded during enrollment, so an active MITM cannot
  substitute its own key. Host verification is **never** disabled or set to
  `accept-new`.
- `IdentitiesOnly=yes` + an explicit `IdentityFile` — only the dedicated
  ed25519 client key is offered, never the user's other agent keys.
- `BatchMode=yes` / `PasswordAuthentication=no` — public-key auth only; no
  interactive or password fallback.
- `ServerAliveInterval`/`ServerAliveCountMax` — dead connections are detected
  and the uplink reconnects with exponential backoff.

Keys are ed25519. The client private key lives in the project `.climon`
directory with `0600` permissions and never leaves the devbox.

## Containment: forced command + restrictions

The home machine authorizes each devbox with an `authorized_keys` entry that
**forces** the accept handler and strips all other capabilities:

```
restrict,command="climon-server --ssh-accept --label devbox-1" ssh-ed25519 AAAA... 
```

- `command="…"` — the key can only ever run the accept handler. The
  client-supplied command is ignored by sshd. The per-client label is carried in
  this forced command (sshd does not expose the key comment to the handler), and
  is strictly validated (`/^[A-Za-z0-9._-]{1,64}$/`) before being written,
  because it is interpolated into the command string.
- `restrict` — disables port forwarding, agent forwarding, X11, PTY allocation,
  and `~/.ssh/rc`. A compromised devbox therefore cannot open tunnels, forward
  ports back, or get a shell. It can only speak the mux protocol to the handler.

## Dashboard server: loopback only

The dashboard HTTP/WebSocket server binds to `127.0.0.1` exclusively. The former
`--lan` mode and shared bearer token were **removed** — there is no network-
exposed listener and no long-lived secret to leak. Remote visibility is achieved
solely by the home user running the dashboard locally; devboxes never connect to
the HTTP server, only to sshd.

Privileged endpoints (session spawn, remote-client management) require, in
addition to a loopback source IP:

- a JSON `content-type` (forcing a CORS preflight that the server never grants),
  and
- a loopback `Origin`/`Host`,

which together defend against browser-mediated CSRF and DNS-rebinding from a page
running on the same machine (`isAllowedSpawnRequest`).

## Untrusted-input handling

- **Public keys** (`parsePublicKey`): type allowlist
  (`ssh-ed25519`, `ssh-rsa`, `ecdsa-sha2-nistp256/384/521`), strict base64
  validation, embedded-newline rejection. The raw key **comment is discarded**
  and the `authorized_keys` line is reconstructed from validated parts, so a
  malicious comment cannot inject options or extra keys.
- **Labels** (`sanitizeLabel`): `/^[A-Za-z0-9._-]{1,64}$/`, rejected otherwise.
- **Mux frames**: every frame is length-prefixed and capped
  (`MAX_MUX_PAYLOAD = 8 MiB`); an oversize or malformed frame tears the
  connection down rather than allocating unbounded memory.

## Integrity of managed files

`authorized_keys` and `known_hosts` are edited only within a delimited
`# climon-managed BEGIN/END` block, leaving hand-maintained entries untouched.
Writes are atomic (temp file + `rename`) with `0700` directories and `0600`
files, so a crash mid-write cannot corrupt or truncate the key file.

## What a compromised devbox can and cannot do

| Capability | Allowed? |
|---|---|
| Stream its own session output to the dashboard | Yes (by design) |
| Receive keystrokes the user types into its sessions | Yes (by design) |
| Open a shell / run arbitrary commands on home | **No** (`command=` + `restrict`) |
| Forward ports or tunnel into the home network | **No** (`restrict`) |
| Reach the dashboard HTTP server | **No** (loopback only) |
| Impersonate the home host to a third devbox | **No** (host-key pinning) |

## Revocation

Revoking a client removes its managed `authorized_keys` entry (atomic rewrite),
immediately ending its ability to connect. Existing connections drop on the next
reconnect attempt.
