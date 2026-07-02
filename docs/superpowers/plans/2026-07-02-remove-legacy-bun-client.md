# Remove Legacy Bun Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Delete the legacy Bun/TypeScript climon client (including the Bun ingest/uplink daemon implementations now rewritten in Rust) while keeping the Bun dashboard server (`climon-server`) and web bundle fully working.

**Architecture:** The Bun server (`src/server.ts` + `src/server/` + `src/web/`) is the only maintained runtime in `src/`. It still imports a couple of client-adjacent modules, so we first extract the one function the server needs out of `launcher.ts` (into a new `src/session-defaults.ts`) and trim the dead Bun ingest daemon out of `remote/ingest.ts`. Only then can the unreachable client files be deleted without breaking the server. Correctness is proven by `tsc --noEmit` (catches any kept file importing a deleted module), the remaining Bun test suite, and server/web builds.

**Tech Stack:** Bun 1.3.x, TypeScript ESM (explicit `.js` import extensions), `bun:test`.

**Worktree:** All work happens in `.worktrees/remove-legacy-bun-client` (already created, branched off `origin/dev`). Run every command from that directory. The PR targets `dev`, never `main`.

---

## Reference: authoritative delete list (source)

These 52 tracked source files are deleted by this plan (validated by transitive-import-closure analysis from `src/server.ts`, `src/web/main.tsx`, `src/web/sw.ts` after the Task 1–2 extractions):

```
src/index.ts
src/launcher.ts
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

**Explicitly KEPT** (unreachable from runtime but still used elsewhere — do NOT delete):
`src/release/version-bump.ts` (used by `scripts/release.ts`), `src/i18n/publish.ts` (used by `scripts/extract-messages.ts`), `src/i18n/t.ts`'s sibling `src/i18n/catalog.ts`, `src/web/pino-browser.d.ts`, `src/web/xterm-theme.d.ts`, `src/setup/install-id.ts` (used by the server), and the gitignored build artifact `src/server/embedded-assets.ts`.

---

## Task 1: Extract `resolveSessionDefaults` into `src/session-defaults.ts`

The server (`src/server/server.ts:52`) imports only `resolveSessionDefaults` from `launcher.ts`. Extract it (plus `chooseAutoSessionColor` and the two interfaces) into a new focused module so `launcher.ts` can later be deleted.

**Files:**
- Create: `src/session-defaults.ts`
- Create: `tests/session-defaults.test.ts`
- Modify: `src/server/server.ts:52`

- [ ] **Step 1: Create the new module**

Create `src/session-defaults.ts` with exactly this content:

```typescript
import { resolveConfigSetting } from "./config.js";
import { listSessions } from "./store.js";
import { AUTO_COLOR_ORDER, ANSI_COLORS, DEFAULT_PRIORITY, parseColorMode } from "./session-meta.js";
import type { AnsiColor, SessionColorMode } from "./types.js";

export interface SessionDefaultFlags {
  color?: SessionColorMode | null;
  priority?: number;
}

export interface ResolvedSessionDefaults {
  color: AnsiColor | null;
  priority: number;
}

/**
 * Resolves a session's accent color and sort priority. Explicit CLI flags take
 * precedence; otherwise the hierarchical config (`session.color` /
 * `session.priority`, repo-then-global) is consulted; otherwise the built-in
 * defaults (color auto, priority 500) apply. A `session.color` of "auto"
 * resolves to the least-used concrete color, and "none" resolves to null.
 */
export async function chooseAutoSessionColor(env: NodeJS.ProcessEnv = process.env): Promise<AnsiColor> {
  const sessions = await listSessions(env);
  const counts = new Map<AnsiColor, number>();
  for (const color of AUTO_COLOR_ORDER) counts.set(color, 0);
  for (const session of sessions) {
    if (session.color && (ANSI_COLORS as readonly string[]).includes(session.color)) {
      counts.set(session.color, (counts.get(session.color) ?? 0) + 1);
    }
  }
  let selected = AUTO_COLOR_ORDER[0];
  let selectedCount = counts.get(selected) ?? 0;
  for (const color of AUTO_COLOR_ORDER.slice(1)) {
    const count = counts.get(color) ?? 0;
    if (count < selectedCount) {
      selected = color;
      selectedCount = count;
    }
  }
  return selected;
}

export async function resolveSessionDefaults(
  flags: SessionDefaultFlags,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd()
): Promise<ResolvedSessionDefaults> {
  let color: AnsiColor | null;
  if (flags.color !== undefined) {
    color = flags.color === "auto" ? await chooseAutoSessionColor(env) : flags.color === "none" ? null : flags.color;
  } else {
    const raw = resolveConfigSetting("session.color", env, cwd);
    const mode = typeof raw === "string" ? parseColorMode(raw) : "auto";
    color = mode === "auto" ? await chooseAutoSessionColor(env) : mode === "none" ? null : mode;
  }

  let priority: number;
  if (typeof flags.priority === "number") {
    priority = flags.priority;
  } else {
    const raw = resolveConfigSetting("session.priority", env, cwd);
    const n = typeof raw === "number" ? raw : Number(raw);
    priority = Number.isInteger(n) && n >= 0 && n <= 1000 ? n : DEFAULT_PRIORITY;
  }

  return { color, priority };
}
```

- [ ] **Step 2: Create the migrated test file**

Create `tests/session-defaults.test.ts`. Copy the `chooseAutoSessionColor` and `resolveSessionDefaults` `describe` blocks currently in `tests/launcher.test.ts` (lines ~57–84 and ~119 onward), but change the import to the new module. Preserve any shared test setup (temp `CLIMON_HOME`, imports of `join`, `mkdtempSync`, etc.) that those blocks rely on. The import line must be:

```typescript
import { resolveSessionDefaults, chooseAutoSessionColor } from "../src/session-defaults.js";
```

Do NOT copy the `launchBanner` or `resolveDefaultSessionName` blocks — those functions are being deleted with `launcher.ts`.

- [ ] **Step 3: Run the new test to verify it passes**

Run: `bun test tests/session-defaults.test.ts`
Expected: PASS (all `chooseAutoSessionColor` and `resolveSessionDefaults` cases green).

- [ ] **Step 4: Repoint the server import**

In `src/server/server.ts`, change line 52 from:

```typescript
import { resolveSessionDefaults } from "../launcher.js";
```

to:

```typescript
import { resolveSessionDefaults } from "../session-defaults.js";
```

- [ ] **Step 5: Type-check to confirm the server compiles against the new module**

Run: `bun run typecheck`
Expected: PASS (no errors — `launcher.ts` still exists at this point, so nothing else breaks yet).

- [ ] **Step 6: Commit**

```bash
git add src/session-defaults.ts tests/session-defaults.test.ts src/server/server.ts
git commit -m "refactor: extract resolveSessionDefaults into session-defaults module

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Remove the dead Bun ingest daemon from `remote/ingest.ts`

The server spawns the **Rust** ingest via `resolveClientInvocation(["__ingest"])`, so the Bun `runIngestDaemon` (`src/remote/ingest.ts:701`) is dead. It is the sole user of `spawnUplinkDetached` (`ingest.ts:830`), whose only importer is this file (`ingest.ts:31`). Removing it frees `remote/uplink-spawn.ts`. Keep every server-consumed helper and wire type in this file.

**Files:**
- Modify: `src/remote/ingest.ts`

- [ ] **Step 1: Delete the `runIngestDaemon` function**

Remove the entire `runIngestDaemon` function (from its doc comment above `export async function runIngestDaemon(...)` at ~line 696 through its closing brace at the end of the function). This is the last exported function in the file.

- [ ] **Step 2: Remove the now-unused `spawnUplinkDetached` import**

Delete line 31: `import { spawnUplinkDetached } from "./uplink-spawn.js";`

- [ ] **Step 3: Remove any other imports/private helpers left unused by the deletion**

Type-check will report imports/locals used only by `runIngestDaemon`. Run:

Run: `bun run typecheck`

For each `'X' is declared but its value is never read` error pointing into `src/remote/ingest.ts`, delete that unused import or private (non-exported) helper. Do NOT delete any `export`ed symbol (those may be consumed by kept modules such as `src/server/server.ts` and `src/server/remote-spawn-client.ts`). Re-run `bun run typecheck` until it passes with no errors.

Expected final: PASS.

- [ ] **Step 4: Sanity-check the server still imports what it needs**

Run: `grep -nE "from \"\\.\\./remote/ingest\\.js\"" src/server/server.ts`
Confirm the imported symbols (`namespacedId`, `readRemoteHostState`, `getIngestPidPath`, `resolveIngestBindAddress`, `ingestNeedsRecycle`, `SpawnControlRequest`, `SpawnControlResponse`) still exist as exports in `src/remote/ingest.ts` (grep each name with `^export`).

- [ ] **Step 5: Commit**

```bash
git add src/remote/ingest.ts
git commit -m "refactor: remove dead Bun ingest daemon (runIngestDaemon)

The server now spawns the Rust ingest binary; the Bun daemon is unused.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Delete unreachable client source files

Now that the server no longer imports `launcher.ts` and `ingest.ts` no longer imports `uplink-spawn.ts`, the entire legacy client tree is unreachable. Delete it in one commit.

**Files:** Delete all 52 files listed in the "authoritative delete list" above.

- [ ] **Step 1: Delete the files with git**

```bash
git rm \
  src/index.ts \
  src/launcher.ts \
  src/cli/cleanup-cmd.ts src/cli/config-cmd.ts src/cli/link-cmd.ts src/cli/server-exec.ts \
  src/client/connect.ts src/client/detach-key.ts src/client/query-title.ts src/client/spawn-session.ts src/client/title.ts \
  src/daemon/buffer.ts src/daemon/daemon.ts src/daemon/idle-detector.ts \
  src/detect-shell.ts \
  src/i18n/t.ts \
  src/install/changelog.ts src/install/files-unix.ts src/install/files.ts src/install/index.ts \
  src/install/install-manifest.ts src/install/linux-main.ts src/install/linux.ts src/install/macos-main.ts \
  src/install/macos.ts src/install/path.ts src/install/processes.ts src/install/windows.ts \
  src/installer-bundle-entry.ts \
  src/pty.ts \
  src/remote/client-id.ts src/remote/discovery.ts src/remote/link.ts src/remote/uplink-spawn.ts src/remote/uplink.ts \
  src/self-spawn.ts \
  src/server-bundle-entry.ts \
  src/session-host.ts src/session-id.ts \
  src/setup/onboarding.ts src/setup/setup-cmd.ts \
  src/spawn-daemon.ts \
  src/update/check.ts src/update/download.ts src/update/launch-hooks.ts src/update/manifest.ts \
  src/update/pubkey.ts src/update/state.ts src/update/swap.ts src/update/update-cli.ts \
  src/update/update-cmd.ts src/update/verify.ts
```

- [ ] **Step 2: Remove now-empty directories if any remain**

Run: `find src/client src/daemon src/install src/update -type d -empty -delete 2>/dev/null; ls src/client src/daemon src/install src/update 2>&1 | head`
Expected: `src/client`, `src/daemon`, `src/install`, `src/update` are gone (empty and removed). `src/cli`, `src/remote`, `src/setup` still exist (they retain kept files).

- [ ] **Step 3: Type-check the whole project**

Run: `bun run typecheck`
Expected: PASS. If any error reports a kept file importing a deleted module, that indicates a missed dependency — investigate that specific import (it should not happen given the closure analysis, but the compiler is the source of truth). Do NOT resurrect deleted files; fix by removing the stray import or, if a genuinely-needed helper was in a deleted file, extract it into a kept module.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "chore: delete legacy Bun client source tree

Removes the frozen Bun/TypeScript client (index, launcher, daemon, pty,
session-host, client/, install/, update/, setup cmds) and the Bun ingest/
uplink daemon files now provided by the Rust crates. The Bun dashboard
server and web bundle are unaffected.

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Delete client-only tests and finish launcher test triage

**Files:** Delete 48 client-only test files + 3 remaining launcher test files (the 4th, `tests/launcher.test.ts`, is superseded by `tests/session-defaults.test.ts` from Task 1 and is also deleted).

- [ ] **Step 1: Delete client-only test files**

```bash
git rm \
  tests/buffer.test.ts tests/changelog.test.ts tests/cleanup-cmd.test.ts tests/client-id.test.ts \
  tests/client-input.test.ts tests/client-output.test.ts tests/config-cmd.test.ts tests/config-global-only.test.ts \
  tests/daemon-attention.test.ts tests/detach-key.test.ts tests/detect-shell.test.ts tests/i18n-messages.test.ts \
  tests/idle-detector.test.ts tests/install-cli.test.ts tests/install-files-unix.test.ts tests/install-files.test.ts \
  tests/install-fixtures.test.ts tests/install-macos.test.ts tests/install-manifest.test.ts tests/install-path.test.ts \
  tests/install-processes.test.ts tests/onboarding.test.ts tests/peer-link.test.ts tests/pty-resize.test.ts \
  tests/query-title.test.ts tests/resize.test.ts tests/resolve-ingest-port.test.ts tests/self-spawn.test.ts \
  tests/server-exec.test.ts tests/session-fixtures.test.ts tests/session-id.test.ts tests/setup-options.test.ts \
  tests/sign-release.test.ts tests/spawn-session.test.ts tests/title.test.ts tests/update-banner.test.ts \
  tests/update-check.test.ts tests/update-cli.test.ts tests/update-cmd.test.ts tests/update-download.test.ts \
  tests/update-fixtures.test.ts tests/update-manifest.test.ts tests/update-pubkey.test.ts tests/update-state.test.ts \
  tests/update-swap.test.ts tests/update-verify.test.ts tests/uplink.test.ts tests/windows-user-path.test.ts
```

Note on borderline files: `tests/i18n-messages.test.ts` tests the deleted user-facing `t()` function (it imports `../src/i18n/t.js`); the message catalog is still validated by `bun run messages:check`. `tests/sign-release.test.ts` tests the deleted `src/update/verify.ts` (the `scripts/sign-release.ts` build tool is kept and imports no `src/` code). `tests/resolve-ingest-port.test.ts` imports the deleted `src/remote/discovery.ts`.

- [ ] **Step 2: Delete the launcher test files superseded by Task 1**

```bash
git rm tests/launcher.test.ts tests/launcher-remote.test.ts tests/launcher-size.test.ts tests/kill-session-escalate.test.ts
```

(These cover deleted functions: `launchBanner`/`resolveDefaultSessionName`/`planUplinkStart`/`resolveLaunchSize`/`killSession`/`killAllSessions`. The kept `resolveSessionDefaults`/`chooseAutoSessionColor` cases now live in `tests/session-defaults.test.ts`.)

- [ ] **Step 3: Run the full remaining test suite**

Run: `bun test tests`
Expected: PASS, with no test files referencing deleted modules. If any surviving test fails to import a deleted module, delete or repoint that test (it was missed by the categorization).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "test: remove Bun client-only tests

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Update `package.json` scripts

The `build` and `start` scripts target the deleted `src/index.ts`. Remove them and simplify `build:all`.

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove the `build` and `start` scripts and fix `build:all`**

In `package.json` `scripts`:

Delete these two lines:

```json
    "build": "bun run clean && bun build ./src/index.ts --outdir ./dist --target bun --format esm",
    "start": "bun src/index.ts",
```

Change `build:all` from:

```json
    "build:all": "bun run build && bun run build:web && bun run build:server",
```

to:

```json
    "build:all": "bun run clean && bun run build:web && bun run build:server",
```

Leave all other scripts unchanged (`clean`, `build:server`, `build:web`, `compile`, `sign-release`, `typecheck`, `lint`, `test`, `release`, `dev`, `server`, `server:loop`, `logs`, `log-level`, `docs:config`, `messages:*`).

- [ ] **Step 2: Verify the build pipeline still works end-to-end**

Run: `bun run build:all`
Expected: succeeds — writes the web bundle and `dist/server.js` with no reference to `src/index.ts`.

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "build: drop client build/start scripts targeting deleted src/index.ts

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 6: Documentation sweep

Update user- and contributor-facing docs to state the client lives solely in `rust/` and the Bun `src/` tree is server + web only. Add a manual-check note per the repo convention.

**Files:**
- Modify: `README.md` (any section describing installing/running the Bun client, `bun run build`, `bun src/index.ts`, or the Bun client architecture)
- Modify: `docs/architecture.md` (component breakdown — the Bun client role is gone; keep the server + web description; note ingest/uplink daemons are Rust-only)
- Modify: `docs/setup.md`, `docs/usage.md` (only where they reference the Bun client build/run/install; leave server + Rust-client instructions intact)
- Create: `docs/manual-tests/<NN>-legacy-client-removal.md`

- [ ] **Step 1: Grep for stale references and update prose**

Run: `grep -rnE "src/index\.ts|bun run build\b|bun src/index|runIngestDaemon|server-bundle-entry|installer-bundle-entry" README.md docs`
For each hit, update the surrounding prose so it no longer instructs building/running the Bun client. Do NOT change references to `scripts/gen-update-*` (kept), `src/server.ts`, `bun run build:server`, `bun run build:web`, or the Rust client. In `docs/architecture.md:215`, keep the `scripts/gen-update-keys.ts` signing-tooling reference.

- [ ] **Step 2: Add the manual-test note**

Follow the test-case shape from `docs/manual-tests/README.md`. Create `docs/manual-tests/<NN>-legacy-client-removal.md` (use the next free `NN`) with: ID, feature ("Legacy Bun client removal"), preconditions (clean checkout of this branch), numbered steps (`bun install`; `bun run typecheck`; `bun test tests`; `bun run build:server`; `bun run build:web`; start the server with `bun src/server.ts server` and load the dashboard), expected result (all pass; dashboard loads; sessions from the Rust client appear), platforms, and a result-tracking row. Then add a link to it from the `docs/manual-tests/README.md` index.

- [ ] **Step 3: Commit**

```bash
git add README.md docs
git commit -m "docs: client is Rust-only; drop Bun client build/run references

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 7: Final verification

Prove the server and web bundle are intact and nothing references deleted code.

**Files:** none (verification only).

- [ ] **Step 1: Full lint (typecheck + message catalog)**

Run: `bun run lint`
Expected: PASS (`tsc --noEmit` clean + `messages:check` clean).

- [ ] **Step 2: Full test suite**

Run: `bun test tests`
Expected: PASS. Record the passing count.

- [ ] **Step 3: Server and web builds**

Run: `bun run build:server && bun run build:web`
Expected: both succeed.

- [ ] **Step 4: Confirm no dangling references to deleted modules remain**

Run: `grep -rnE "launcher\.js|/session-host\.js|/spawn-daemon\.js|/self-spawn\.js|/pty\.js|/daemon/(daemon|buffer|idle-detector)\.js|/client/(connect|detach-key|query-title|spawn-session|title)\.js|/install/|/update/(check|download|launch-hooks|manifest|pubkey|state|swap|update-cli|update-cmd|verify)\.js|uplink\.js|uplink-spawn\.js|remote/(discovery|link|client-id)\.js|server-bundle-entry|installer-bundle-entry|i18n/t\.js" src scripts`
Expected: no output. (Any hit is a dangling import to fix.)

- [ ] **Step 5: Server smoke run (optional but recommended)**

Run: `bun src/server.ts server` (in the background), then `curl -sS http://127.0.0.1:<printed-port>/ | head` and confirm the dashboard HTML is served, then stop the process.
Expected: dashboard HTML returned.

- [ ] **Step 6: Push and open the PR against `dev`**

```bash
git push -u origin remove-legacy-bun-client
gh pr create --base dev --title "Remove legacy Bun client" --body "Deletes the frozen Bun/TypeScript client (now shipped as the Rust workspace) including the Bun ingest/uplink daemon implementations. Extracts resolveSessionDefaults into src/session-defaults.ts and trims the dead runIngestDaemon so the maintained dashboard server and web bundle keep working. See docs/superpowers/specs/2026-07-02-remove-legacy-bun-client-design.md."
```

---

## Self-review checklist (completed by plan author)

- **Spec coverage:** Extractions (Task 1–2), source deletions (Task 3), test deletions + launcher triage (Task 4), package.json (Task 5), docs + manual test (Task 6), verification incl. typecheck/tests/builds (Task 7) — all spec sections mapped.
- **Placeholders:** none — every code/command step is concrete; the `<NN>` in the manual-test filename is an intentional "next free index" instruction, and the ingest unused-symbol cleanup is compiler-driven by design (the exact dead-symbol set cannot be safely hardcoded).
- **Type consistency:** `resolveSessionDefaults`, `chooseAutoSessionColor`, `SessionDefaultFlags`, `ResolvedSessionDefaults` names match between `src/session-defaults.ts` and the server import; the ingest exports the server relies on are enumerated and re-checked in Task 2 Step 4.
