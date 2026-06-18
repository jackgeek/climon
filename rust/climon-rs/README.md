# climon-rs — terminal shadowing PoC

A Rust proof-of-concept for rewriting the **climon client** (the server is out
of scope). It implements the core capability of the client: **terminal
shadowing** — wrapping an interactive command in a PTY so the local user
interacts with it transparently, while a copy of all output is captured and
streamed, live, to any viewer that attaches over an IPC socket.

See the design doc: `docs/superpowers/specs/2026-06-17-rust-client-poc-design.md`.

## What it does

- `climon-rs run -- <cmd> [args...]` — hosts `<cmd>` in a PTY, relays the local
  terminal transparently (raw stdin → PTY, PTY output → stdout), captures a
  scrollback "shadow", and serves a Unix-domain socket.
- `climon-rs view` — attaches to a hosted session: receives a **replay** of the
  current scrollback, then the live **output** stream; forwards local keystrokes
  as **input** and terminal **resizes**; exits when the session does.

The IPC wire format is byte-compatible with the TypeScript client
(`src/ipc/frame.ts`): a 4-byte big-endian length, a 1-byte frame type, then the
payload. This keeps a future server-interop path open even though the server is
not part of this PoC.

### In scope
PTY hosting, transparent local relay, scrollback capture + replay, a live IPC
socket, a built-in viewer, host/viewer resize propagation, and the wire-
compatible frame codec.

### Out of scope (later phases)
The dashboard server, `~/.climon` session metadata/discovery, attention/idle
detection, browser resize clamping modes, title syncing, remote tunnels,
config, installer, and Windows ConPTY validation.

## Build & test

```sh
cargo build
cargo test          # 19 unit tests + 1 end-to-end shadow test
cargo clippy --all-targets
```

## Try it (two terminals)

Terminal A — host an interactive shell and shadow it:

```sh
cargo run -- run -- bash
```

Terminal B — attach a viewer and watch (and control) it live:

```sh
cargo run -- view
```

Type in either terminal; both see the same session. The default socket is
`climon-rs-default.sock` in the system temp dir; override with `--socket PATH`.

## Use it with the climon dashboard server

Add `--climon` to register the session under `$CLIMON_HOME` (default `~/.climon`)
so the existing climon **server** discovers, health-checks, and bridges browser
viewers to it — no server code changes required, because the PoC speaks the
server's exact frame protocol.

```sh
# 1. Start the climon dashboard server (from the climon repo root):
bun src/server.ts server

# 2. Host a Rust session that registers with the server:
climon-rs run --climon -- bash

# 3. Open the dashboard URL the server printed; the session appears in the
#    sidebar and you can view/control it from the browser.
```

`--climon` writes `$CLIMON_HOME/sessions/<id>.json` (mirroring `SessionMeta`),
binds the session socket under `$CLIMON_HOME/sock/<id>.sock`, records the live
`daemonPid`, and updates status to `completed`/`failed` on exit. Set
`CLIMON_HOME` to point both the server and the client at the same directory.

> Platform: macOS / Linux (Unix sockets). Windows is deferred.

## Layout

| File            | Responsibility                                             |
| --------------- | ---------------------------------------------------------- |
| `frame.rs`      | Wire-compatible frame codec (`FrameType`, encode, decoder) |
| `scrollback.rs` | Bounded ring buffer holding the captured shadow            |
| `term.rs`       | Raw-mode guard + terminal-size query                       |
| `json.rs`       | Tiny hand-rolled JSON for `{cols,rows}` / `{exitCode}`     |
| `meta.rs`       | `--climon` session metadata for dashboard-server interop   |
| `host.rs`       | `run`: PTY + local relay + IPC server                      |
| `viewer.rs`     | `view`: attach, render, forward input/resize               |
| `main.rs`       | Arg parsing and subcommand dispatch                        |
