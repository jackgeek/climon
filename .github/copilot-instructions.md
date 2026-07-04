# Copilot instructions for climon

## Client = Rust, server = Bun (read this first)

- The shipping `climon` **client** is the **Rust** workspace under `rust/` (crates `climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`, `climon-logging`, `climon-proto`, `climon-remote`, `climon-install`, `climon-update`). **All client work — new features and bug fixes — goes in `rust/`.**
- The Bun/TypeScript client that used to live under `src/` (`src/index.ts`, `src/launcher.ts`, `src/session-host.ts`, `src/pty.ts`, `src/cli/`, `src/client/`, `src/daemon/`, `src/install/`, most of `src/remote/`, …) has been **removed** — it was rewritten in Rust. Do **not** try to run or restore it; all client work goes in the `rust/` crates. The TypeScript that remains under `src/` is the maintained dashboard server/web plus shared support modules (configuration, logging, i18n, session defaults, the remote-ingest helpers the server imports, and `src/update/pubkey.ts`, the Ed25519 key read by `rust/climon-update` at build time).
- The dashboard **server** (`climon-server`, built from `src/server.ts` with `src/server/` and `src/web/`) is **NOT legacy**. It is still Bun, still maintained, and is never rewritten. The Rust client interoperates with it byte-for-byte over the shared metadata/socket/config surfaces.
- See `docs/architecture.md` for the component breakdown.

## Workflow

- Always start new work in a fresh git worktree under the `.worktrees/` folder, never directly on the main checkout. Create one per task with `git worktree add .worktrees/<branch-name> -b <branch-name>` (or check out an existing branch) and do all edits, builds, and tests there. The `.worktrees/` folder is gitignored.
- **Always open pull requests against the `dev` branch, never `main`.** Pushing to `main` triggers the [`Release`](.github/workflows/release.yml) workflow (it bumps the version, tags, and publishes), so feature/fix PRs must target `dev` to avoid cutting an accidental release. `dev` is only merged into `main` when we deliberately want to ship a release.

## Local Copilot CLI skills

- Repo-local Copilot CLI skills live in `copilot-plugin/` (a per-session plugin, not installed globally). Load them with `copilot --plugin-dir copilot-plugin` from the repo root, then invoke a skill by describing the task (e.g. "update the changelog" runs the `update-changelog` skill). See `copilot-plugin/README.md`.

## Build, test, and lint commands

### Rust client (canonical — do client work here)

- The client crates live in `rust/`. Build with `cargo build` (or `cargo build --release`) from `rust/`.
- Run the Rust tests with `cargo test`; lint with `cargo clippy --all-targets`; format with `cargo fmt`.
- License/attribution gates use `cargo deny` and `cargo about` (`rust/deny.toml`, `rust/about.toml`).
- The shipped `climon` binary is built from `rust/climon-cli` and packaged by `scripts/compile.ts`.

### Bun server + tests

- Install dependencies with `bun install`. The project uses Bun (`packageManager: bun@1.3.10`) and TypeScript ESM.
- Build all runtime artifacts with `bun run build` (`build:web` dashboard bundle, `build:server` server entrypoint, `build:rust` Rust `climon` client). The `build:rust` step (`scripts/build-rust.ts`) installs a minimal Rust toolchain via rustup on demand when `cargo` is missing (skip with `CLIMON_SKIP_RUST_INSTALL=1`); the `postinstall` hook (`scripts/rust-toolchain.ts`) only reports toolchain status and never downloads during `bun install`.
- Compile release binaries with `bun run compile`; bump the version and create the matching git tag with `bun run release`.
- Type-check/lint with `bun run lint` or `bun run typecheck` (`tsc -p tsconfig.json --noEmit`).
- Run the full suite with `bun test tests`.
- Run a single test file with `bun test tests/config.test.ts`.
- Run one test by name with `bun test tests/config.test.ts -t "default config binds to localhost"`.
- Useful local entrypoints: `bun src/server.ts server` (canonical dashboard server) or `cargo run -p climon-cli -- <args>` from `rust/` (the client).

## High-level architecture

> The file paths below name the roles in the shared design. The **client** role (launcher, daemon, PTY, local attach client, remote bridge) is implemented in the Rust workspace under `rust/`; the **server** role is the Bun code under `src/server/` + `src/web/`. Make client changes in the Rust crates.

climon is a cross-platform PTY session manager with three main roles: the launcher/client, one detached daemon per session, and a dashboard server. The launcher (`rust/climon-cli`) writes session metadata, starts a detached daemon, waits for its socket, prints the dashboard URL, and attaches the local terminal. The daemon (`rust/climon-session`) owns the PTY (`rust/climon-pty`), scrollback ring buffer, client IPC, status transitions, and final persisted output.

The dashboard server (`src/server.ts`, `src/server/server.ts`) is stateless with respect to PTYs: it scans `~/.climon/sessions/*.json`, watches for metadata updates, serves REST/SSE/WebSocket APIs, and bridges browser WebSocket traffic to daemon sockets. The React 19 + Fluent UI dashboard lives under `src/web/` and is served from `src/server/assets.ts`; compiled builds embed the web bundle into the server binary.

The client and server are intentionally separate binaries. The Rust `climon` client is lean and delegates the `server` subcommand to the compiled `climon-server` binary (built from `src/server.ts`). Keep server-only code, embedded assets, React, Fluent UI, and xterm dependencies in the server entrypoint; the Rust client never embeds them.

Session state is filesystem-backed under `$CLIMON_HOME` (default `~/.climon`): `config.jsonc`, legacy `config.json` backups, session metadata JSON, final scrollback, daemon logs, and sockets/pipes. Metadata is the cross-process coordination boundary; `src/store.ts` writes metadata atomically and serializes per-process patch bursts.

Remote clients use an ingest/uplink bridge over Microsoft dev tunnels or a direct Windows/WSL same-machine connection. The remote client code lives in the Rust `climon-remote` crate; the Bun server keeps a small set of ingest helpers in `src/remote/ingest.ts` that it imports directly. Remote session metadata is materialized locally with namespaced IDs so the existing dashboard/session-list plumbing can treat local and remote sessions uniformly.

## Key conventions

- Use explicit `.js` extensions in TypeScript relative imports, matching the existing ESM/Bun pattern (`import { x } from "./module.js"`).
- Tests use `bun:test`; add focused tests under `tests/*.test.ts` near related existing tests rather than introducing another runner.
- Tests that touch climon state should isolate with `CLIMON_HOME` pointing at a temporary directory. Some socket/PTY tests need a real Linux filesystem temp dir because Unix sockets do not work reliably on all mounted filesystems.
- Preserve the session status and priority model from `src/types.ts` and `src/priority.ts`: `needs-attention` sorts first, then `running`, then terminal states, with user priority as an additional ordering input.
- The daemon is the single writer for live session state such as attention and exit transitions. Server APIs should avoid directly mutating daemon-owned live fields unless they are explicitly server-owned operations.
- Browser resize behavior is shared PTY state. Viewer resizes are clamped to the host terminal by default and reverted when the last browser viewer disconnects; update daemon, IPC, and web-terminal behavior together when changing this flow.
- Treat remote input as untrusted. Keep remote ID validation, metadata namespacing, patch allowlists, bounded mux frames, and loopback-only privileged dashboard APIs aligned with `docs/security.md`.
- Configuration is hierarchical for `climon config`: local `.climon/config.jsonc` files are checked from the cwd upward before global `$CLIMON_HOME/config.jsonc`; legacy `config.json` files are read for backward compatibility and migrated on first write. Writes use explicit `--local`/`--global` or the nearest existing config.
- Config settings are declared in `src/config-settings.ts`. Whenever a config setting is added, removed, renamed, re-scoped, retyped, or has its purpose or default changed, update that registry, regenerate config docs/comments with `bun run docs:config`, and keep the change backward compatible with existing config files.
- When changing install or release behavior, check `scripts/`, `rust/climon-install`, and `src/release/` together because version bumping, binary compilation, PATH setup, and installer packaging are coupled.
- Keep docs in sync with behavior that users rely on: `README.md` for user-facing workflow, `docs/architecture.md` for component/data-flow changes, `docs/security.md` for remote or network-facing changes, and `docs/setup.md`/`docs/usage.md` for setup and command changes.
- Every new feature MUST ship with manual checks in `docs/manual-tests/`. Add or update a `phaseNN-<feature>.md` (or feature-named) file using the test-case shape from `docs/manual-tests/README.md` (ID, feature, preconditions, config-matrix cell, numbered steps, expected result, platforms, result-tracking row), and link it from the README index. A feature is not complete until its manual checks exist.
