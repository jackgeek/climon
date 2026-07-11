# Lossless Config Round-Trip Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve all config data across server saves and merge each loaded caller's actual changes onto the latest on-disk config so `install.id` and unrelated concurrent updates remain stable.

**Architecture:** Add a focused deep-delta module for JSON-compatible config objects. Make `loadConfig()` lossless and register a deep-cloned golden snapshot in a `WeakMap`; make `saveConfig()` diff tracked objects against their golden snapshot, reload the latest config, apply only that delta, and then advance the golden snapshot from the caller's current state.

**Tech Stack:** Bun, TypeScript ESM, `bun:test`, JSONC config rendering.

---

## File Structure

- Create `src/config-merge.ts`: JSON-compatible deep cloning, delta calculation, and delta application.
- Create `tests/config-merge.test.ts`: focused unit tests for additions, nested updates, deletions, arrays, and no-op deltas.
- Modify `src/config.ts`: lossless normalization, golden snapshot registration, and three-way save behavior.
- Modify `tests/config.test.ts`: end-to-end config round-trip, stale-writer merge, and stable ingest tunnel ID regressions.

### Task 1: Deep Config Delta

**Files:**
- Create: `src/config-merge.ts`
- Create: `tests/config-merge.test.ts`

- [ ] **Step 1: Write failing delta tests**

Create `tests/config-merge.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { applyConfigDelta, cloneConfigValue, diffConfig } from "../src/config-merge.js";

describe("config three-way merge helpers", () => {
  test("returns undefined when config data is unchanged", () => {
    expect(diffConfig({ server: { port: 3131 } }, { server: { port: 3131 } })).toBeUndefined();
  });

  test("applies additions and nested replacements without changing siblings", () => {
    const golden = { server: { host: "127.0.0.1", port: 3131 } };
    const current = { server: { host: "localhost", port: 3131 }, install: { id: "stable" } };
    const latest = {
      server: { host: "127.0.0.1", port: 4242 },
      remote: { dashboardTunnelEnabled: true }
    };

    const delta = diffConfig(golden, current);
    expect(delta).toBeDefined();
    expect(applyConfigDelta(latest, delta!)).toEqual({
      server: { host: "localhost", port: 4242 },
      remote: { dashboardTunnelEnabled: true },
      install: { id: "stable" }
    });
  });

  test("applies explicit deletions without deleting unrelated latest keys", () => {
    const golden = {
      remote: { dashboardTunnelId: "old.eun1", dashboardTunnelEnabled: true }
    };
    const current = {
      remote: { dashboardTunnelEnabled: true }
    };
    const latest = {
      remote: {
        dashboardTunnelId: "old.eun1",
        dashboardTunnelEnabled: true,
        dashboardTunnelCluster: "eun1"
      },
      update: { lastCheck: "now" }
    };

    const delta = diffConfig(golden, current);
    expect(applyConfigDelta(latest, delta!)).toEqual({
      remote: {
        dashboardTunnelEnabled: true,
        dashboardTunnelCluster: "eun1"
      },
      update: { lastCheck: "now" }
    });
  });

  test("replaces arrays as a unit", () => {
    const delta = diffConfig({ plugin: { values: ["a", "b"] } }, { plugin: { values: ["c"] } });
    expect(applyConfigDelta({ plugin: { values: ["latest"] } }, delta!)).toEqual({
      plugin: { values: ["c"] }
    });
  });

  test("deep clones config values", () => {
    const original = { nested: { value: 1 } };
    const cloned = cloneConfigValue(original);
    cloned.nested.value = 2;
    expect(original.nested.value).toBe(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
bun test tests/config-merge.test.ts
```

Expected: FAIL because `src/config-merge.ts` does not exist.

- [ ] **Step 3: Implement the deep-delta module**

Create `src/config-merge.ts`:

```ts
import { isDeepStrictEqual } from "node:util";

export type ConfigDelta =
  | { kind: "delete" }
  | { kind: "replace"; value: unknown }
  | { kind: "object"; entries: Record<string, ConfigDelta> };

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function cloneConfigValue<T>(value: T): T {
  return structuredClone(value);
}

export function diffConfig(golden: unknown, current: unknown): ConfigDelta | undefined {
  if (isDeepStrictEqual(golden, current)) return undefined;

  if (isObjectRecord(golden) && isObjectRecord(current)) {
    const entries: Record<string, ConfigDelta> = {};
    const keys = new Set([...Object.keys(golden), ...Object.keys(current)]);
    for (const key of keys) {
      if (!(key in current)) {
        entries[key] = { kind: "delete" };
        continue;
      }
      if (!(key in golden)) {
        entries[key] = { kind: "replace", value: cloneConfigValue(current[key]) };
        continue;
      }
      const child = diffConfig(golden[key], current[key]);
      if (child) entries[key] = child;
    }
    return Object.keys(entries).length > 0 ? { kind: "object", entries } : undefined;
  }

  return { kind: "replace", value: cloneConfigValue(current) };
}

export function applyConfigDelta(
  latest: Record<string, unknown>,
  delta: ConfigDelta
): Record<string, unknown> {
  if (delta.kind !== "object") {
    throw new Error("Root config delta must be an object delta.");
  }
  return applyObjectDelta(cloneConfigValue(latest), delta.entries);
}

function applyObjectDelta(
  target: Record<string, unknown>,
  entries: Record<string, ConfigDelta>
): Record<string, unknown> {
  for (const [key, delta] of Object.entries(entries)) {
    if (delta.kind === "delete") {
      delete target[key];
    } else if (delta.kind === "replace") {
      target[key] = cloneConfigValue(delta.value);
    } else {
      const child = isObjectRecord(target[key]) ? cloneConfigValue(target[key]) : {};
      target[key] = applyObjectDelta(child, delta.entries);
    }
  }
  return target;
}
```

- [ ] **Step 4: Run the focused tests**

Run:

```bash
bun test tests/config-merge.test.ts
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit the helper**

```bash
git add src/config-merge.ts tests/config-merge.test.ts
git commit -m "feat(config): add three-way merge helpers" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 771fc610-17a0-449a-92bc-c6a157c40317"
```

### Task 2: Lossless Config Loading

**Files:**
- Modify: `src/config.ts:117-206`
- Modify: `tests/config.test.ts:73-187`

- [ ] **Step 1: Write failing lossless-load tests**

Add these tests inside `describe("config migration", ...)` in `tests/config.test.ts`:

```ts
  test("loadConfig preserves registered and unknown sections", async () => {
    const home = await makeTestHome("climon-lossless-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131, futureServerKey: "keep" },
        dashboard: { theme: "Campbell" },
        tunnelLink: { keepAlive: 15 },
        logging: { level: "debug" },
        telemetry: { enabled: true },
        update: { lastCheck: "2026-07-11T00:00:00.000Z" },
        install: { id: "stable-install-id" },
        futureSection: { nested: { value: 42 } }
      })
    );

    const config = await loadConfig(env);
    config.server.host = "localhost";
    const { saveConfig } = await import("../src/config.js");
    await saveConfig(config, env);
    const reloaded = await loadConfig(env);
    const record = reloaded as unknown as Record<string, unknown>;

    expect(reloaded.install?.id).toBe("stable-install-id");
    expect(reloaded.update?.lastCheck).toBe("2026-07-11T00:00:00.000Z");
    expect(record.futureSection).toEqual({ nested: { value: 42 } });
    expect((reloaded.server as unknown as Record<string, unknown>).futureServerKey).toBe("keep");
    await rm(home, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
bun test tests/config.test.ts -t "loadConfig preserves registered and unknown sections"
```

Expected: FAIL because `install`, `update`, `futureSection`, and `futureServerKey` are discarded.

- [ ] **Step 3: Make loading lossless and register golden snapshots**

In `src/config.ts`, import the clone helper:

```ts
import { applyConfigDelta, cloneConfigValue, diffConfig } from "./config-merge.js";
```

Add module state after the config filename constants:

```ts
const configGoldenSnapshots = new WeakMap<ClimonConfig, Record<string, unknown>>();
```

Extract the existing load body into a private function and build the normalized object from the full parsed record:

```ts
async function loadConfigInternal(env: NodeJS.ProcessEnv): Promise<ClimonConfig> {
  await ensureClimonHome(env);
  const home = getClimonHome(env);
  const canonicalPath = getConfigPathForDir(home);
  const legacyPath = getLegacyConfigPathForDir(home);
  const configPath = existsSync(canonicalPath)
    ? canonicalPath
    : existsSync(legacyPath)
      ? legacyPath
      : undefined;

  if (!configPath) {
    return defaultConfig();
  }

  const parsed = await readConfigRecordFromPath(configPath);
  if (parsed.version !== undefined && parsed.version !== CONFIG_VERSION) {
    throw new Error(`Unsupported climon config format in ${configPath}`);
  }

  const defaults = defaultConfig();
  const parsedServer = isObjectRecord(parsed.server) ? parsed.server : {};
  const parsedTerminal = isObjectRecord(parsed.terminal) ? parsed.terminal : {};
  const parsedAttention = isObjectRecord(parsed.attention) ? parsed.attention : {};
  const parsedSession = isObjectRecord(parsed.session) ? parsed.session : {};
  const parsedFeature = isObjectRecord(parsed.feature) ? parsed.feature : {};
  const parsedHotKeys = isObjectRecord(parsed.hotKeys) ? parsed.hotKeys : {};
  const parsedPriority =
    typeof parsedSession.priority === "number" ? { priority: parsedSession.priority } : {};
  const parsedColor =
    typeof parsedSession.color === "string" ? { color: parsedSession.color } : {};
  const parsedConfigObject = {
    ...parsed,
    version: CONFIG_VERSION,
    server: { ...defaults.server, ...parsedServer },
    terminal: { ...defaults.terminal, ...parsedTerminal },
    attention: { ...defaults.attention, ...parsedAttention },
    remote: isObjectRecord(parsed.remote) ? { ...parsed.remote } : undefined,
    session: { ...parsedSession, ...defaults.session, ...parsedPriority, ...parsedColor },
    feature: { ...(defaults.feature ?? {}), ...parsedFeature },
    hotKeys: { ...(defaults.hotKeys ?? {}), ...parsedHotKeys }
  } as ClimonConfig;

  if (typeof parsedConfigObject.terminal.clampBrowserToHost !== "boolean") {
    parsedConfigObject.terminal.clampBrowserToHost = false;
  }
  parsedConfigObject.terminal.detachPrefix = normalizeDetachPrefix(
    parsedConfigObject.terminal.detachPrefix
  );
  if (typeof parsedConfigObject.attention.idleSeconds !== "number") {
    parsedConfigObject.attention.idleSeconds = 10;
  }
  try {
    parsedConfigObject.session!.color =
      typeof parsedConfigObject.session?.color === "string"
        ? parseColorMode(parsedConfigObject.session.color)
        : "auto";
  } catch {
    parsedConfigObject.session!.color = "auto";
  }
  if (typeof parsedConfigObject.hotKeys.focusTopSession !== "string") {
    parsedConfigObject.hotKeys.focusTopSession = "Alt+J";
  }
  return parsedConfigObject;
}

export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<ClimonConfig> {
  const configPath = existingConfigPathForDir(getClimonHome(env));
  const config = await loadConfigInternal(env);
  if (!configPath) {
    await saveConfig(config, env);
  }
  configGoldenSnapshots.set(
    config,
    cloneConfigValue(config as unknown as Record<string, unknown>)
  );
  return config;
}
```

- [ ] **Step 4: Run config migration tests**

Run:

```bash
bun test tests/config.test.ts -t "config migration"
```

Expected: all config migration tests pass.

- [ ] **Step 5: Commit lossless loading**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "fix(config): preserve complete loaded config" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 771fc610-17a0-449a-92bc-c6a157c40317"
```

### Task 3: Three-Way Config Saving

**Files:**
- Modify: `src/config.ts:208-239`
- Modify: `tests/config.test.ts:305-378`

- [ ] **Step 1: Write failing stale-writer tests**

Add a new `describe("config three-way saves", ...)` block in `tests/config.test.ts`:

```ts
describe("config three-way saves", () => {
  test("preserves disjoint changes from stale loaded configs", async () => {
    const home = await makeTestHome("climon-three-way-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        remote: { dashboardTunnelEnabled: false },
        install: { id: "stable-install-id" }
      })
    );

    const serverConfig = await loadConfig(env);
    const cliConfig = await loadConfig(env);
    serverConfig.server.host = "localhost";
    cliConfig.remote = { ...cliConfig.remote, dashboardTunnelEnabled: true };

    const { saveConfig } = await import("../src/config.js");
    await saveConfig(cliConfig, env);
    await saveConfig(serverConfig, env);

    const saved = await loadConfig(env);
    expect(saved.server.host).toBe("localhost");
    expect(saved.remote?.dashboardTunnelEnabled).toBe(true);
    expect(saved.install?.id).toBe("stable-install-id");
    await rm(home, { recursive: true, force: true });
  });

  test("preserves disjoint nested changes and explicit deletions", async () => {
    const home = await makeTestHome("climon-three-way-nested-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        remote: {
          dashboardTunnelId: "old.eun1",
          dashboardTunnelCluster: "eun1",
          dashboardTunnelEnabled: false
        }
      })
    );

    const deletingConfig = await loadConfig(env);
    const enablingConfig = await loadConfig(env);
    delete deletingConfig.remote!.dashboardTunnelId;
    enablingConfig.remote!.dashboardTunnelEnabled = true;

    const { saveConfig } = await import("../src/config.js");
    await saveConfig(enablingConfig, env);
    await saveConfig(deletingConfig, env);

    const saved = await loadConfig(env);
    expect(saved.remote?.dashboardTunnelId).toBeUndefined();
    expect(saved.remote?.dashboardTunnelCluster).toBe("eun1");
    expect(saved.remote?.dashboardTunnelEnabled).toBe(true);
    await rm(home, { recursive: true, force: true });
  });

  test("uses last-writer-wins for the same setting", async () => {
    const home = await makeTestHome("climon-three-way-conflict-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({ version: 1, server: { host: "127.0.0.1", port: 3131 } })
    );

    const first = await loadConfig(env);
    const second = await loadConfig(env);
    first.server.port = 4001;
    second.server.port = 4002;

    const { saveConfig } = await import("../src/config.js");
    await saveConfig(first, env);
    await saveConfig(second, env);

    expect((await loadConfig(env)).server.port).toBe(4002);
    await rm(home, { recursive: true, force: true });
  });

  test("advances the golden snapshot from caller state after each save", async () => {
    const home = await makeTestHome("climon-three-way-repeat-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        update: { lastCheck: "initial" }
      })
    );

    const serverConfig = await loadConfig(env);
    serverConfig.server.host = "localhost";
    const { saveConfig, writeConfigSetting } = await import("../src/config.js");
    await saveConfig(serverConfig, env);
    writeConfigSetting("update.lastCheck", "external", "global", env);
    serverConfig.server.port = 4242;
    await saveConfig(serverConfig, env);

    const saved = await loadConfig(env);
    expect(saved.server).toMatchObject({ host: "localhost", port: 4242 });
    expect(saved.update?.lastCheck).toBe("external");
    await rm(home, { recursive: true, force: true });
  });

  test("keeps full-save behavior for objects not returned by loadConfig", async () => {
    const home = await makeTestHome("climon-full-save-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "127.0.0.1", port: 3131 },
        futureSection: { keepOnlyForTrackedSaves: true }
      })
    );

    const replacement = defaultConfig();
    replacement.server.port = 4242;
    const { saveConfig } = await import("../src/config.js");
    await saveConfig(replacement, env);

    const raw = await readFile(join(home, "config.jsonc"), "utf8");
    expect(raw).not.toContain("futureSection");
    expect((await loadConfig(env)).server.port).toBe(4242);
    await rm(home, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the stale-writer tests to verify they fail**

Run:

```bash
bun test tests/config.test.ts -t "config three-way saves"
```

Expected: FAIL because `saveConfig()` still writes the stale full object.

- [ ] **Step 3: Implement tracked three-way saves**

Refactor the persistence portion of `src/config.ts` into a private writer:

```ts
async function writeCompleteConfig(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv
): Promise<void> {
  await ensureClimonHome(env);
  const home = getClimonHome(env);
  const canonicalPath = getConfigPathForDir(home);
  const legacyPath = getLegacyConfigPathForDir(home);
  const backupPath = getLegacyBackupPathForDir(home);
  const hasLegacy = existsSync(legacyPath);
  const hasCanonical = existsSync(canonicalPath);

  await writeFile(canonicalPath, renderJsoncConfig(config), { mode: 0o600 });
  try {
    await chmod(canonicalPath, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX permissions.
  }

  if (hasLegacy && !hasCanonical) {
    try {
      await rename(legacyPath, backupPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Wrote ${canonicalPath} but failed to back up legacy ${legacyPath} to ${backupPath}: ${message}`
      );
    }
  }
}
```

Replace `saveConfig()` with:

```ts
export async function saveConfig(
  config: ClimonConfig,
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const current = config as unknown as Record<string, unknown>;
  const golden = configGoldenSnapshots.get(config);
  let toWrite = current;

  if (golden) {
    const delta = diffConfig(golden, current);
    const latest = await loadConfigInternal(env);
    toWrite = delta
      ? applyConfigDelta(
          latest as unknown as Record<string, unknown>,
          delta
        )
      : latest as unknown as Record<string, unknown>;
  }

  await writeCompleteConfig(toWrite, env);
  if (golden) {
    configGoldenSnapshots.set(config, cloneConfigValue(current));
  }
}
```

Ensure `loadConfigInternal()` never calls public `loadConfig()` or registers a snapshot, preventing recursive tracking during the merge reload.

- [ ] **Step 4: Run config tests**

Run:

```bash
bun test tests/config.test.ts tests/config-merge.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit three-way saving**

```bash
git add src/config.ts tests/config.test.ts
git commit -m "fix(config): merge tracked saves onto latest state" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 771fc610-17a0-449a-92bc-c6a157c40317"
```

### Task 4: Stable Ingest Tunnel Regression

**Files:**
- Modify: `tests/config.test.ts`

- [ ] **Step 1: Write the server-style tunnel stability test**

Add this import to `tests/config.test.ts`:

```ts
import { deriveIngestTunnelId } from "../src/remote/ingest-tunnel-id.js";
```

Add this test to `describe("config three-way saves", ...)`:

```ts
  test("server-style saves preserve install id and derived ingest tunnel id", async () => {
    const home = await makeTestHome("climon-install-roundtrip-");
    const env = { CLIMON_HOME: home } as NodeJS.ProcessEnv;
    const installId = "00000000-0000-4000-8000-000000000000";
    await writeFile(
      join(home, "config.jsonc"),
      JSON.stringify({
        version: 1,
        server: { host: "0.0.0.0", port: 3131 },
        install: { id: installId }
      })
    );

    const before = deriveIngestTunnelId(installId);
    const config = await loadConfig(env);
    config.server.host = "127.0.0.1";
    const { saveConfig } = await import("../src/config.js");
    await saveConfig(config, env);

    const reloaded = await loadConfig(env);
    expect(reloaded.install?.id).toBe(installId);
    expect(deriveIngestTunnelId(reloaded.install!.id!)).toBe(before);
    await rm(home, { recursive: true, force: true });
  });
```

- [ ] **Step 2: Run the regression test**

Run:

```bash
bun test tests/config.test.ts -t "server-style saves preserve install id"
```

Expected: PASS with the completed implementation.

- [ ] **Step 3: Run targeted config and tunnel tests**

Run:

```bash
bun test tests/config.test.ts tests/config-merge.test.ts tests/install-id.test.ts tests/ingest-tunnel-id.test.ts tests/tunnel.test.ts
```

Expected: all targeted tests pass.

- [ ] **Step 4: Run type checking**

Run:

```bash
bun run typecheck
```

Expected: TypeScript exits successfully with no diagnostics.

- [ ] **Step 5: Commit the regression coverage**

```bash
git add tests/config.test.ts
git commit -m "test(remote): keep ingest tunnel identity stable" \
  -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" \
  -m "Copilot-Session: 771fc610-17a0-449a-92bc-c6a157c40317"
```

### Task 5: Final Verification

**Files:**
- Verify: `src/config.ts`
- Verify: `src/config-merge.ts`
- Verify: `tests/config.test.ts`
- Verify: `tests/config-merge.test.ts`

- [ ] **Step 1: Format-check the changed TypeScript**

Run the repository's existing lint/typecheck command:

```bash
bun run lint
```

Expected: command exits successfully.

- [ ] **Step 2: Run the focused regression suite once more**

```bash
bun test tests/config.test.ts tests/config-merge.test.ts tests/install-id.test.ts tests/ingest-tunnel-id.test.ts tests/tunnel.test.ts
```

Expected: all targeted tests pass without retries.

- [ ] **Step 3: Inspect the final diff**

```bash
git --no-pager diff dev...HEAD -- src/config.ts src/config-merge.ts tests/config.test.ts tests/config-merge.test.ts
```

Expected: only the lossless loader, three-way merge, and focused tests are present.

- [ ] **Step 4: Confirm the worktree is clean**

```bash
git --no-pager status --short
```

Expected: no output.
