# Remove legacy Bun client — design

## Context

The shipping `climon` **client** is now the Rust workspace under `rust/`
(`climon-cli`, `climon-session`, `climon-pty`, `climon-store`, `climon-config`,
`climon-remote`, `climon-install`, `climon-update`, …). The Bun/TypeScript client
under `src/` is frozen legacy, kept only for local reference and the Bun test
suite. The Bun **dashboard server** (`climon-server`, from `src/server.ts` with
`src/server/` + `src/web/`) is **not** legacy and must keep working byte-for-byte.

Goal: delete the legacy Bun client code — including the Bun ingest/uplink
daemon implementations that have been rewritten in Rust — without regressing the
maintained server.

## Scope (agreed: "safe scope")

Delete only code that is **unreachable** from the two live runtime entrypoints:

- Server binary: `src/server.ts`
- Web bundle: `src/web/main.tsx` and the service worker `src/web/sw.ts`

Everything the server or web bundle still imports is **kept**. Build/release/i18n
tooling under `scripts/` (and the `src/` files those scripts import) is kept even
if unreachable from the runtime, because that tooling still ships the server and
supports the Rust crates.

Out of scope: refactoring the server to drop its remaining coordination with the
Rust ingest/uplink/tunnel processes; pruning individual entries from the config
settings registry (kept intact for config-file backward compatibility).

## Key finding: the entanglement

`src/server.ts` handles only the `server` command; the legacy client root is
`src/index.ts`. But the maintained server still reaches into "client/remote"
code, so a blanket directory delete would break it:

- `server/server.ts` imports `resolveSessionDefaults` from `launcher.ts`.
  Importing `launcher.ts` transitively drags in the entire legacy launch flow
  (`session-host.ts` → `daemon/*`, `pty.ts`; `client/spawn-session.ts` →
  `spawn-daemon.ts` → `self-spawn.ts`; `client/query-title.ts`, `client/title.ts`).
- `server/server.ts` imports helpers and wire types from `remote/ingest.ts`
  (`namespacedId`, `readRemoteHostState`, `getIngestPidPath`,
  `resolveIngestBindAddress`, `ingestNeedsRecycle`, `SpawnControlRequest/Response`).
  That file also contains the dead Bun ingest daemon `runIngestDaemon`, which
  imports `spawnUplinkDetached` from `remote/uplink-spawn.ts`.
- The server spawns the **Rust** ingest via `resolveClientInvocation(["__ingest"])`
  (resolves to the sibling `climon` binary), so the Bun `runIngestDaemon` and Bun
  `remote/uplink.ts` are dead at runtime.

Therefore the deletion needs two surgical extractions before the dependent files
can be removed.

## Approach

### 1. Extract server-needed launcher logic, then delete `launcher.ts`

Create `src/session-defaults.ts` containing the only launcher pieces the server
uses:

- `chooseAutoSessionColor`
- `resolveSessionDefaults`
- interfaces `SessionDefaultFlags`, `ResolvedSessionDefaults`

Its dependencies are clean and non-client: `config` (`resolveConfigSetting`),
`store` (`listSessions`), `session-meta` (`AUTO_COLOR_ORDER`, `ANSI_COLORS`,
`DEFAULT_PRIORITY`, `parseColorMode`), and `types`.

Repoint `src/server/server.ts` to import `resolveSessionDefaults` from
`./session-defaults.js`, then delete `src/launcher.ts`. This frees
`session-host.ts`, `daemon/*`, `pty.ts`, `client/spawn-session.ts`,
`client/query-title.ts`, `client/title.ts`, `spawn-daemon.ts`, `self-spawn.ts`,
`session-id.ts`, and the launcher-only remote helpers
(`remote/discovery.ts`, `remote/link.ts`, `remote/client-id.ts`).

### 2. Trim `remote/ingest.ts` (keep the file)

Remove the dead Bun ingest daemon and its uplink launcher usage:

- Delete `runIngestDaemon` and any functions/classes that become unused solely
  through it (e.g. the connection/daemon-only machinery not imported by the
  server or other kept modules).
- Remove the `spawnUplinkDetached` import from `remote/uplink-spawn.ts`.

Keep the server-consumed helpers and wire types. This frees
`remote/uplink-spawn.ts` and `remote/uplink.ts`.

### 3. Delete unreachable source files

Delete these tracked source files (validated by transitive-closure analysis from
the two runtime entrypoints, after the two extractions above):

```
src/index.ts
src/launcher.ts                       (after extracting session-defaults.ts)
src/cli/cleanup-cmd.ts
src/cli/config-cmd.ts
src/cli/link-cmd.ts
src/cli/server-exec.ts
src/client/connect.ts
src/client/detach-key.ts
src/client/query-title.ts
src/client/spawn-session.ts
src/client/title.ts
src/daemon/buffer.ts
src/daemon/daemon.ts
src/daemon/idle-detector.ts
src/detect-shell.ts
src/i18n/t.ts
src/install/changelog.ts
src/install/files-unix.ts
src/install/files.ts
src/install/index.ts
src/install/install-manifest.ts
src/install/linux-main.ts
src/install/linux.ts
src/install/macos-main.ts
src/install/macos.ts
src/install/path.ts
src/install/processes.ts
src/install/windows.ts
src/installer-bundle-entry.ts
src/pty.ts
src/remote/client-id.ts
src/remote/discovery.ts
src/remote/link.ts
src/remote/uplink-spawn.ts
src/remote/uplink.ts
src/self-spawn.ts
src/server-bundle-entry.ts
src/session-host.ts
src/session-id.ts
src/setup/onboarding.ts
src/setup/setup-cmd.ts
src/spawn-daemon.ts
src/update/check.ts
src/update/download.ts
src/update/launch-hooks.ts
src/update/manifest.ts
src/update/pubkey.ts
src/update/state.ts
src/update/swap.ts
src/update/update-cli.ts
src/update/update-cmd.ts
src/update/verify.ts
```

### Explicitly KEEP (unreachable from runtime, but still needed)

- `src/release/version-bump.ts` — used by `scripts/release.ts`.
- `src/i18n/publish.ts` — used by `scripts/extract-messages.ts`.
- `src/web/pino-browser.d.ts`, `src/web/xterm-theme.d.ts` — ambient type shims for
  the web build (not statically imported).
- `src/server/embedded-assets.ts` — gitignored build artifact, loaded via runtime
  `require` with a source-build fallback; never tracked, so nothing to delete.
- `src/setup/install-id.ts` — used by the server.

### 4. Delete client-only tests

Delete Bun test files that exercise only deleted client concerns (daemon, pty,
resize, client input/output, install, update, self-spawn, session-id, cleanup/
config/link commands, onboarding/setup, uplink, detach-key, query-title, title,
buffer, idle-detector, peer-link, version-bump-as-client, etc.).

Triage the launcher tests:

- Tests of `resolveSessionDefaults` / `chooseAutoSessionColor` → repoint to
  `src/session-defaults.ts`.
- Tests of the deleted launch flow (`startMonitoredCommand`, `killSession`,
  banner/size helpers, remote auto-link) → delete.

Keep all server/web/shared tests (config, store, session-meta, i18n catalog,
logging, priority, server, web, push, tunnel/ingest helpers still used by server).

The implementation plan verifies the final suite with `bun test tests`.

### 5. Update `package.json` scripts

- `build` currently bundles the deleted `src/index.ts`. Remove it (the client is
  Rust) and update `build:all` to `build:web` + `build:server`.
- `start` runs `bun src/index.ts`; remove it.
- Keep `build:server`, `build:web`, `compile`, `server`, `server:loop`, `dev`,
  `logs`, `log-level`, `docs:config`, `messages:*`, `release`, `sign-release`,
  `typecheck`, `lint`, `test`, `clean`.

### 6. Scripts & docs sweep

- Keep `scripts/gen-update-{fixtures,keys}.ts` — they generate `fixtures/update/*`
  consumed by the Rust `climon-update` tests and the release signing keys the Rust
  updater verifies. Neither imports `src/update/*`.
- Update `README.md` and `docs/architecture.md` (and `docs/setup.md`/`docs/usage.md`
  where they describe the Bun client) to state the client lives solely in `rust/`
  and the Bun `src/` tree is server + web only.
- Add a manual-check note under `docs/manual-tests/` covering "server still builds
  and runs after legacy client removal" per the repo's manual-test convention.

## Verification

- `bun run typecheck` (`tsc --noEmit`) passes — the authoritative check that no
  kept file still imports a deleted module.
- `bun run lint` passes (typecheck + `messages:check`).
- `bun test tests` passes after removing client-only tests.
- `bun run build:server` and `bun run build:web` succeed.
- Optional: `bun run compile` server smoke test still produces a working
  `climon-server`.

## Risks

- **Hidden dynamic imports / `require`** not caught by static closure analysis
  (e.g. `assets.ts`'s `require("./embedded-assets.js")`). Mitigation: rely on
  `typecheck` + `bun test` + a server build/run, not just the static list.
- **`remote/ingest.ts` trim** could remove a symbol still referenced by a kept
  module. Mitigation: remove only `runIngestDaemon` + provably-unused helpers;
  let `typecheck` confirm.
- **Test triage** for the launcher tests must not silently drop coverage of
  `resolveSessionDefaults`; repoint rather than delete those cases.

## Branch / workflow

Work in `.worktrees/remove-legacy-bun-client` (branched off `origin/dev`). Open
the PR against `dev`, never `main`.
