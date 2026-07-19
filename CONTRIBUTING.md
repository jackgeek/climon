# Contributing to climon

Thanks for your interest in improving climon! This guide covers the repository
layout, how to build and test, and the workflow we follow.

## Repository layout

climon has two shipping components that live in one repo:

- **Client — Rust (canonical).** The shipping `climon` client is the Rust
  workspace under `rust/` (crates `climon-cli`, `climon-session`, `climon-pty`,
  `climon-store`, `climon-config`, `climon-logging`, `climon-proto`,
  `climon-remote`, `climon-install`, `climon-update`). **All client work — new
  features and bug fixes — goes in `rust/`.**
- **Dashboard server — Bun (maintained).** The dashboard server (`climon-server`,
  built from `src/server.ts` with `src/server/` and `src/web/`) is still Bun and
  is actively maintained.
- **Client rewritten in Rust — old Bun client removed.** The Bun/TypeScript
  client that used to live under `src/` (`src/index.ts`, `src/launcher.ts`,
  `src/cli/`, `src/client/`, `src/daemon/`, …) has been removed. Do **not** try
  to restore it; all client work goes in the `rust/` crates. The TypeScript that
  remains under `src/` is the maintained dashboard server/web plus shared support
  modules.

See [docs/architecture.md](docs/architecture.md) for the full component
breakdown.

## Build, test, and lint

### Rust client (do client work here)

From `rust/`:

```bash
cargo build            # or: cargo build --release
cargo test             # run the test suite
cargo clippy --all-targets
cargo fmt
```

The shipped `climon` binary is built from `rust/climon-cli` and packaged by
`scripts/compile.ts`.

### Bun server + tests

From the repo root (the project uses Bun and TypeScript ESM):

```bash
bun install            # install dependencies (checks for the Rust toolchain)
bun run build            # build the dashboard bundle, server entrypoint, and Rust client
bun run test           # run the full Bun suite
bun run lint           # typecheck + message-catalog check
bun run typecheck      # tsc --noEmit only
```

`bun run build` also builds the Rust `climon` client. If `cargo` is missing,
the `build:rust` step installs a minimal Rust toolchain via
[rustup](https://rustup.rs) on demand, so first-time setup is just `bun install`
followed by `bun run build`. Set `CLIMON_SKIP_RUST_INSTALL=1` to opt out of
the automatic install (then provision Rust yourself). On **Windows**, building
the client also requires the Visual Studio C++ Build Tools (for `link.exe`);
rustup cannot install those, so install them separately if `bun run build`
reports a missing linker.

Run a single test file with `bun test tests/config.test.ts`, or one test by name
with `bun test tests/config.test.ts -t "name"`.

## Workflow

- **Work in an isolated git worktree**, never directly on the main checkout:

  ```bash
  git worktree add .worktrees/<branch-name> -b <branch-name>
  ```

  Do all edits, builds, and tests there. The `.worktrees/` folder is gitignored.

- **Open pull requests against `dev`, never `main`.** Pushing to `main` triggers
  the release workflow (version bump, tag, publish), so feature/fix PRs must
  target `dev`. `dev` is merged into `main` only when we deliberately ship a
  release.

- **Every new feature ships with manual checks** in
  [`docs/manual-tests/`](docs/manual-tests/). Add or update a feature file using
  the test-case shape in
  [docs/manual-tests/README.md](docs/manual-tests/README.md) and link it from the
  index.

- Keep docs in sync with behavior users rely on: `README.md` for workflow,
  `docs/architecture.md` for component/data-flow changes, `docs/security.md` for
  remote/network-facing changes, and `docs/setup.md`/`docs/usage.md` for setup
  and command changes.

- Config settings are declared in `src/config-settings.ts` and mirrored in
  `rust/climon-config/src/config_settings.rs`. When you add, remove, rename, or
  re-type a setting, update both registries, regenerate the docs/fixtures with
  `bun run docs:config`, and keep both test suites green.

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By
participating you agree to uphold it.

## Reporting security issues

Please do **not** open public issues for security vulnerabilities. Follow the
process in [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be licensed under the
[MIT License](LICENSE) that covers this project.
