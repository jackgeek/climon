# Windows Upgrade-Test Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an end-to-end harness that exercises the never-before-run Windows
Feature 2 migration/update paths (bridge→C migration, C→C+1 stub update, idempotent
`--migrate`, and brick+recovery) on a real Windows box before PR #97 and the bridge
release ship.

**Architecture:** A dev-only, compiled-out cargo feature (`test-update-endpoint`) lets
a locally-built `climon` read its update manifest URL from `CLIMON_TEST_MANIFEST_URL`
instead of the hardcoded `DEFAULT_MANIFEST_URL`; a build-time `CLIMON_UPDATE_PUBKEY_B64`
env override lets those local binaries trust a throwaway test key. A Bun harness
(`scripts/upgrade-test-harness.ts`) generates an ephemeral Ed25519 keypair, packages a
**bridge** zip (legacy layout) and a **C** zip (stub layout), signs them with
`signReleaseDir`, serves the signed dir over a local static server, then drives
`climon update` / `install.exe --migrate` against scratch install dirs and asserts the
resulting on-disk layout. **The production signing private key is never used or
referenced; production release builds never enable the feature or the pubkey override.**

**Tech Stack:** Rust (`climon-update`, `climon-cli`), Bun/TypeScript (`scripts/`,
`bun:test`), WebCrypto Ed25519, existing `signReleaseDir`/manifest tooling.

**Spec / approved design:** `docs/superpowers/HANDOFF-shell-integration-and-binary-lifecycle.md`
§"Item A — End-to-end upgrade test harness (DESIGN APPROVED)". Brick-test framing for
scenario 4 confirmed by the user as **simulated broken install** (materialize a corrupt
install dir; assert `install.exe`/`install.ps1` recovers a clean stub layout) — no
pre-branch "old" binary is built.

---

## Security invariants (must hold at every step)

1. **Production binaries physically lack the test code.** The manifest-URL override lives
   entirely under `#[cfg(feature = "test-update-endpoint")]`. `scripts/compile.ts` and
   `.github/workflows/release.yml` never pass `--features test-update-endpoint`.
2. **Production key untouched.** The harness only ever generates and uses a throwaway
   in-memory Ed25519 key. It never reads `CLIMON_UPDATE_PRIVATE_KEY` or any real secret.
3. **Pubkey override is inert when unset.** `climon-update/build.rs` reads
   `src/update/pubkey.ts` exactly as today unless `CLIMON_UPDATE_PUBKEY_B64` is explicitly
   set and non-empty in the build environment (mirrors the existing `CLIMON_VERSION`
   override in `climon-cli/build.rs`). Release CI never sets it.
4. **Local-only serving.** The harness static server binds `127.0.0.1` only.

---

## File Structure

| File | Responsibility | New/Modified |
|---|---|---|
| `rust/climon-update/Cargo.toml` | Declare `test-update-endpoint` feature | Modify |
| `rust/climon-update/src/update_cli.rs` | `resolve_manifest_url()` gate + use it | Modify |
| `rust/climon-update/build.rs` | Honor optional `CLIMON_UPDATE_PUBKEY_B64` env override | Modify |
| `rust/climon-cli/Cargo.toml` | Re-export `test-update-endpoint` feature | Modify |
| `rust/climon-dll/Cargo.toml` | Re-export `test-update-endpoint` so the served Windows stub payload honors the override | Modify |
| `scripts/compile.ts` | `CLIMON_LEGACY_LAYOUT=1` host packaging mode (bridge zip); `CLIMON_TEST_UPDATE_ENDPOINT=1` threads `--features test-update-endpoint` into the served client builds | Modify |
| `scripts/upgrade-harness/pack.ts` | Testable helpers: keypair, layout selection, sign+serve | Create |
| `scripts/upgrade-test-harness.ts` | CLI entrypoint: build zips, serve, run scenarios, assert | Create |
| `tests/upgrade-harness.test.ts` | Unit tests for the pure helpers in `pack.ts` + compile mode | Create |
| `docs/manual-tests/windows-binary-lifecycle.md` | Point MT-WBL-07..10 at the harness | Modify |
| `docs/architecture.md` | Note the dev-only test-update-endpoint override | Modify |

---

## Task 1: `test-update-endpoint` cargo feature + runtime manifest-URL override

**Files:**
- Modify: `rust/climon-update/Cargo.toml`
- Modify: `rust/climon-update/src/update_cli.rs`
- Modify: `rust/climon-cli/Cargo.toml`
- Test: `rust/climon-update/src/update_cli.rs` (inline `#[cfg(test)]` module)

- [ ] **Step 1: Write the failing test**

Append to the bottom of `rust/climon-update/src/update_cli.rs`:

```rust
#[cfg(test)]
mod tests {
    use super::resolve_manifest_url;
    use crate::check::DEFAULT_MANIFEST_URL;

    #[test]
    fn resolves_to_default_manifest_url_by_default() {
        // Without the test feature (or with the env unset) the resolver must
        // return the hardcoded production manifest URL.
        assert_eq!(resolve_manifest_url(), DEFAULT_MANIFEST_URL);
    }

    #[cfg(feature = "test-update-endpoint")]
    #[test]
    fn honors_test_manifest_url_env_when_feature_enabled() {
        // SAFETY: single-threaded test; we set and clear the var within it.
        std::env::set_var("CLIMON_TEST_MANIFEST_URL", "http://127.0.0.1:9/manifest.json");
        assert_eq!(resolve_manifest_url(), "http://127.0.0.1:9/manifest.json");
        std::env::remove_var("CLIMON_TEST_MANIFEST_URL");
        assert_eq!(resolve_manifest_url(), DEFAULT_MANIFEST_URL);
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd rust && cargo test -p climon-update resolves_to_default_manifest_url_by_default`
Expected: FAIL — `cannot find function resolve_manifest_url in this scope` (does not exist yet).

- [ ] **Step 3: Add the feature to `climon-update`'s Cargo.toml**

In `rust/climon-update/Cargo.toml`, add a `[features]` section immediately after the
`description`/`build` lines in `[package]` — i.e. before `[lib]`:

```toml
[features]
# Dev/test only: allows `climon update` to read its manifest URL from the
# CLIMON_TEST_MANIFEST_URL env var instead of the hardcoded production URL.
# NEVER enabled by scripts/compile.ts or .github/workflows/release.yml — shipped
# binaries physically lack the override code.
test-update-endpoint = []
```

- [ ] **Step 4: Implement `resolve_manifest_url()` and use it**

In `rust/climon-update/src/update_cli.rs`, add this function just above
`pub fn run_update_cli`:

```rust
/// Resolves the manifest URL for `climon update`.
///
/// Production always returns [`DEFAULT_MANIFEST_URL`]. When the crate is compiled
/// with the dev-only `test-update-endpoint` feature, a non-empty
/// `CLIMON_TEST_MANIFEST_URL` env var overrides it so the upgrade-test harness can
/// point a scratch client at a local signed manifest. The override code is
/// physically absent from release builds (the feature is never enabled there).
pub(crate) fn resolve_manifest_url() -> &'static str {
    #[cfg(feature = "test-update-endpoint")]
    {
        if let Ok(url) = std::env::var("CLIMON_TEST_MANIFEST_URL") {
            if !url.trim().is_empty() {
                // Leak is fine: the process makes at most one update call.
                return Box::leak(url.into_boxed_str());
            }
        }
    }
    DEFAULT_MANIFEST_URL
}
```

Then change the fetch call in `run_update_cli` from:

```rust
    let manifest = match fetch_manifest(DEFAULT_MANIFEST_URL) {
```

to:

```rust
    let manifest = match fetch_manifest(resolve_manifest_url()) {
```

The `use crate::check::DEFAULT_MANIFEST_URL;` import at the top of the file stays (it is
now used inside `resolve_manifest_url`).

- [ ] **Step 5: Re-export the feature from `climon-cli`**

In `rust/climon-cli/Cargo.toml`, add a `[features]` section immediately after the
`[lib]` block (before `[dependencies]`):

```toml
[features]
# Dev/test only: forwards to climon-update's test-update-endpoint. Used solely by
# scripts/upgrade-test-harness.ts to build a scratch client that can be pointed at a
# local signed manifest. Never enabled by the release pipeline.
test-update-endpoint = ["climon-update/test-update-endpoint"]
```

- [ ] **Step 6: Run tests to verify they pass (both feature states)**

Run: `cd rust && cargo test -p climon-update resolves_to_default_manifest_url_by_default && cargo test -p climon-update --features test-update-endpoint`
Expected: PASS. The first run proves the default path; the second proves the env override
and its restore-to-default behaviour.

- [ ] **Step 7: Verify production build path is unchanged**

Run: `cd rust && cargo build -p climon-cli && cargo clippy -p climon-update -p climon-cli --all-targets`
Expected: builds clean; clippy reports no new warnings. (Default features do **not**
include `test-update-endpoint`, so the override code is compiled out.)

- [ ] **Step 8: Commit**

```bash
git add rust/climon-update/Cargo.toml rust/climon-update/src/update_cli.rs rust/climon-cli/Cargo.toml
git commit -m "feat(update): dev-only test-update-endpoint manifest URL override"
```

---

## Task 2: Build-time `CLIMON_UPDATE_PUBKEY_B64` env override

The harness signs local zips with a throwaway private key, so the scratch client must
embed the matching test **public** key. `climon-update/build.rs` currently only reads the
production key from `src/update/pubkey.ts`. Add an env override that mirrors the existing
`CLIMON_VERSION` override in `climon-cli/build.rs`: when `CLIMON_UPDATE_PUBKEY_B64` is set
and non-empty, use it; otherwise read `pubkey.ts` exactly as today (production unchanged).

**Files:**
- Modify: `rust/climon-update/build.rs`
- Test: manual build check (build scripts are not unit-tested in this repo)

- [ ] **Step 1: Add the override to `build.rs`**

In `rust/climon-update/build.rs`, replace this block:

```rust
    let contents = std::fs::read_to_string(&pubkey_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {e}", pubkey_path.display()));
    let key = extract_pubkey(&contents).unwrap_or_else(|| {
        panic!(
            "no UPDATE_PUBLIC_KEY_B64 string literal found in {}",
            pubkey_path.display()
        )
    });
    println!("cargo:rustc-env=CLIMON_UPDATE_PUBKEY_B64={key}");
```

with:

```rust
    // Dev/test override: the upgrade-test harness builds a scratch client that must
    // trust its throwaway signing key. When CLIMON_UPDATE_PUBKEY_B64 is set and
    // non-empty we embed it verbatim; otherwise we read the production key from
    // pubkey.ts exactly as before. Release CI never sets this var, so shipped
    // binaries always embed the real key. Mirrors the CLIMON_VERSION override in
    // climon-cli/build.rs.
    println!("cargo:rerun-if-env-changed=CLIMON_UPDATE_PUBKEY_B64");
    let key = match std::env::var("CLIMON_UPDATE_PUBKEY_B64") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => {
            let contents = std::fs::read_to_string(&pubkey_path)
                .unwrap_or_else(|e| panic!("failed to read {}: {e}", pubkey_path.display()));
            extract_pubkey(&contents).unwrap_or_else(|| {
                panic!(
                    "no UPDATE_PUBLIC_KEY_B64 string literal found in {}",
                    pubkey_path.display()
                )
            })
        }
    };
    println!("cargo:rustc-env=CLIMON_UPDATE_PUBKEY_B64={key}");
```

- [ ] **Step 2: Verify production build still embeds the real key**

Run: `cd rust && cargo build -p climon-update` (with `CLIMON_UPDATE_PUBKEY_B64` unset).
Expected: builds clean. The embedded key is still the one from `src/update/pubkey.ts`.

- [ ] **Step 3: Verify the override is honored when set**

Run (PowerShell):
```powershell
cd rust
$env:CLIMON_UPDATE_PUBKEY_B64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
cargo build -p climon-update
Remove-Item Env:\CLIMON_UPDATE_PUBKEY_B64
```
Expected: builds clean (the value is only a compile-time env string; validity is checked at
verify time, not build time). Rebuilding without the var restores the production key because
of `rerun-if-env-changed`.

- [ ] **Step 4: Commit**

```bash
git add rust/climon-update/build.rs
git commit -m "feat(update): optional CLIMON_UPDATE_PUBKEY_B64 build-time override for test keys"
```

---

## Task 3: `CLIMON_LEGACY_LAYOUT` host packaging mode in `compile.ts`

The harness needs a **bridge** zip in the *legacy* layout: `climon.exe` (the full
standalone `climon-cli` binary, which carries the migration-aware updater) + `climon-server.exe`,
with **no** `climon.dll` and **no** `install.exe`. The absence of `climon.dll`+`install.exe`
is exactly what marks a zip as non-stub-model to `should_migrate_legacy`. Add a host-only
`CLIMON_LEGACY_LAYOUT=1` mode to `compile.ts` (mirrors the existing `CLIMON_ASSEMBLE` env
switch) that emits this layout for the host platform. This is inert unless the env var is
set; the release pipeline never sets it.

**Files:**
- Modify: `scripts/compile.ts`
- Test: `tests/upgrade-harness.test.ts` (asserts `zipEntryNamesForPlatform` legacy variant)

- [ ] **Step 1: Write the failing test**

Create `tests/upgrade-harness.test.ts` with this first test (more tests are added in Task 4):

```ts
import { describe, expect, test } from "bun:test";
import { zipEntryNamesForPlatform } from "../scripts/compile.js";

describe("legacy layout packaging", () => {
  test("legacy Windows zip has climon.exe + climon-server.exe and no dll/installer", () => {
    const names = zipEntryNamesForPlatform("windows-x64", { legacy: true });
    expect(names).toEqual(["climon.exe", "climon-server.exe"]);
    expect(names).not.toContain("climon.dll");
    expect(names).not.toContain("install.exe");
  });

  test("stub Windows zip is unchanged (install.exe + climon.dll + server)", () => {
    const names = zipEntryNamesForPlatform("windows-x64");
    expect(names).toEqual(["install.exe", "climon.dll", "climon-server.exe"]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/upgrade-harness.test.ts -t "legacy Windows zip"`
Expected: FAIL — `zipEntryNamesForPlatform` currently takes one argument and always returns
the stub layout.

- [ ] **Step 3: Extend `zipEntryNamesForPlatform` with a legacy option**

In `scripts/compile.ts`, replace the existing function:

```ts
export function zipEntryNamesForPlatform(platform: string): string[] {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  const client = isWindows ? "climon.dll" : "climon";
  return [`install${exe}`, client, `climon-server${exe}`];
}
```

with:

```ts
/**
 * The bare zip entry names for a platform.
 *
 * Default (stub model): `install[.exe]` + client (`climon.dll` on Windows / `climon`
 * on Unix) + `climon-server[.exe]`.
 *
 * `legacy: true` returns the pre-Feature-2 bridge layout used ONLY by the upgrade-test
 * harness: the full standalone client (`climon[.exe]`) + `climon-server[.exe]`, with no
 * installer and no DLL. The absence of `install.exe`+`climon.dll` is what marks a release
 * as non-stub-model to `should_migrate_legacy`.
 */
export function zipEntryNamesForPlatform(
  platform: string,
  opts: { legacy?: boolean } = {}
): string[] {
  const isWindows = platform.startsWith("windows");
  const exe = isWindows ? ".exe" : "";
  if (opts.legacy) {
    return [`climon${exe}`, `climon-server${exe}`];
  }
  const client = isWindows ? "climon.dll" : "climon";
  return [`install${exe}`, client, `climon-server${exe}`];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/upgrade-harness.test.ts -t "Windows zip"`
Expected: PASS (both the legacy and stub cases).

- [ ] **Step 5: Wire the legacy mode into `main()` packaging**

In `scripts/compile.ts`, add a legacy-mode flag near the other mode flag. After:

```ts
const assembleMode = process.env.CLIMON_ASSEMBLE === "1";
```

add:

```ts
// Host-only, test-only: emit the pre-Feature-2 "bridge" layout (full standalone
// climon[.exe] + climon-server[.exe], no installer, no DLL) for the upgrade-test
// harness. Never set by the release pipeline. Ignored in assemble mode.
const legacyLayoutMode = process.env.CLIMON_LEGACY_LAYOUT === "1" && !assembleMode;
```

In `buildHostRustClient`, the Windows branch currently always builds `climon-dll`. Add a
legacy override at the top of the function body (first lines of `buildHostRustClient`):

```ts
async function buildHostRustClient(platform: string): Promise<Uint8Array> {
  const isWindows = platform.startsWith("windows");
  // Legacy/bridge layout ships the full standalone client on every platform,
  // including Windows (it carries the migration-aware updater via climon_cli::run).
  if (legacyLayoutMode) {
    console.log(`→ Building standalone Rust client (cargo, ${platform}, legacy layout)...`);
    await $`cargo build --release -p climon-cli`.cwd(rustDir);
    const builtName = isWindows ? "climon.exe" : "climon";
    const built = resolve(rustDir, "target", "release", builtName);
    if (!existsSync(built)) {
      throw new Error(`Expected cargo to produce ${built} but it was not found`);
    }
    return new Uint8Array(readFileSync(built));
  }
  console.log(`→ Building Rust client (cargo, ${platform})...`);
  // ...existing body unchanged...
```

In `main()`, guard the installer build and the zip entry assembly. Replace:

```ts
    const platform = targets[0].platform;
    rustClients.set(platform, await buildHostRustClient(platform));
    rustInstallers.set(platform, await buildHostInstaller(platform));
```

with:

```ts
    const platform = targets[0].platform;
    rustClients.set(platform, await buildHostRustClient(platform));
    if (!legacyLayoutMode) {
      rustInstallers.set(platform, await buildHostInstaller(platform));
    }
```

Then in the per-target zip assembly, replace:

```ts
      const clientData = rustClients.get(platform);
      if (!clientData) throw new Error(`Missing Rust client for ${platform}`);
      const installerData = rustInstallers.get(platform);
      if (!installerData) throw new Error(`Missing installer for ${platform}`);
```

with:

```ts
      const clientData = rustClients.get(platform);
      if (!clientData) throw new Error(`Missing Rust client for ${platform}`);
      const installerData = rustInstallers.get(platform);
      if (!legacyLayoutMode && !installerData) {
        throw new Error(`Missing installer for ${platform}`);
      }
```

And replace the `zipFiles` construction:

```ts
      const clientName = isWindows ? "climon.dll" : "climon";
      const zipFiles: ZipEntry[] = [
        { name: `install${exe}`, data: installerData },
        { name: clientName, data: clientData },
        { name: `climon-server${exe}`, path: serverOut },
      ];
```

with:

```ts
      const zipFiles: ZipEntry[] = legacyLayoutMode
        ? [
            { name: `climon${exe}`, data: clientData },
            { name: `climon-server${exe}`, path: serverOut },
          ]
        : [
            { name: `install${exe}`, data: installerData },
            { name: isWindows ? "climon.dll" : "climon", data: clientData },
            { name: `climon-server${exe}`, path: serverOut },
          ];
```

- [ ] **Step 6: Smoke-test both packaging modes on the host**

Run: `bun run compile` (stub mode), confirm `dist/climon-<host>.zip` contains
`zipEntryNamesForPlatform(hostPlatform())`.
Then run (PowerShell): `$env:CLIMON_LEGACY_LAYOUT=1; bun scripts/compile.ts; Remove-Item Env:\CLIMON_LEGACY_LAYOUT`
and confirm the zip now contains `zipEntryNamesForPlatform(hostPlatform(), { legacy: true })`.
Expected: stub zip has 3 entries incl. `install`/`climon.dll` (Windows) or `install`/`climon`
(Unix); legacy zip has exactly `climon[.exe]` + `climon-server[.exe]`.

- [ ] **Step 7: Confirm release pipeline never sets the flag**

Run: `git grep -n "CLIMON_LEGACY_LAYOUT" -- .github scripts | grep -v upgrade`
Expected: only the `compile.ts` definition — no reference in `.github/workflows/release.yml`.

- [ ] **Step 8: Commit**

```bash
git add scripts/compile.ts tests/upgrade-harness.test.ts
git commit -m "feat(compile): CLIMON_LEGACY_LAYOUT host packaging mode for upgrade tests"
```

---

## Task 4: Harness helper module (`scripts/upgrade-harness/pack.ts`)

Pure, unit-testable helpers the harness composes: ephemeral keypair generation, the
scratch-directory layout assertions, and a thin static file server. Signing itself reuses
the existing `signReleaseDir` from `scripts/sign-release.ts` (do not reimplement it).

**Files:**
- Create: `scripts/upgrade-harness/pack.ts`
- Test: `tests/upgrade-harness.test.ts` (extends the file from Task 3)

- [ ] **Step 1: Write the failing tests**

Append to `tests/upgrade-harness.test.ts`:

```ts
import {
  generateTestKeypair,
  assertStubLayout,
  assertLegacyLayout,
} from "../scripts/upgrade-harness/pack.js";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("test keypair", () => {
  test("generates a raw Ed25519 public key and a PKCS8 private key, both base64", async () => {
    const kp = await generateTestKeypair();
    // raw Ed25519 public key is 32 bytes -> 44 base64 chars incl. padding
    expect(Buffer.from(kp.publicKeyRawB64, "base64").length).toBe(32);
    // PKCS8 private key decodes to a non-trivial DER blob
    expect(Buffer.from(kp.privateKeyPkcs8B64, "base64").length).toBeGreaterThan(32);
  });
});

describe("layout assertions", () => {
  function scratch(): string {
    return mkdtempSync(join(tmpdir(), "climon-harness-"));
  }

  test("assertStubLayout passes on a complete stub install dir", () => {
    const dir = scratch();
    for (const f of [
      "climon.exe",
      "climon-server.exe",
      "climon-3.2.0.dll",
      "climon-server-3.2.0.exe",
    ]) {
      writeFileSync(join(dir, f), "x");
    }
    writeFileSync(join(dir, "climon.version"), "3.2.0");
    writeFileSync(join(dir, "climon-server.version"), "3.2.0");
    expect(() => assertStubLayout(dir, "3.2.0")).not.toThrow();
  });

  test("assertStubLayout throws when the pointer is missing", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon.exe"), "x");
    expect(() => assertStubLayout(dir, "3.2.0")).toThrow(/climon\.version/);
  });

  test("assertLegacyLayout passes on a single-exe install with no pointer", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon.exe"), "x");
    writeFileSync(join(dir, "climon-server.exe"), "x");
    expect(() => assertLegacyLayout(dir)).not.toThrow();
  });

  test("assertLegacyLayout throws when a stub pointer is present", () => {
    const dir = scratch();
    writeFileSync(join(dir, "climon.exe"), "x");
    writeFileSync(join(dir, "climon.version"), "3.2.0");
    expect(() => assertLegacyLayout(dir)).toThrow(/climon\.version/);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/upgrade-harness.test.ts -t "keypair"`
Expected: FAIL — cannot resolve `../scripts/upgrade-harness/pack.js` (module does not exist).

- [ ] **Step 3: Implement `pack.ts`**

Create `scripts/upgrade-harness/pack.ts`:

```ts
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:http";

export type TestKeypair = {
  /** Raw 32-byte Ed25519 public key, base64. Matches build.rs CLIMON_UPDATE_PUBKEY_B64. */
  publicKeyRawB64: string;
  /** PKCS8 Ed25519 private key, base64. Matches signReleaseDir's privateKeyPkcs8B64. */
  privateKeyPkcs8B64: string;
};

/** Generates a throwaway Ed25519 keypair for signing local harness zips. */
export async function generateTestKeypair(): Promise<TestKeypair> {
  const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const rawPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  return {
    publicKeyRawB64: Buffer.from(rawPub).toString("base64"),
    privateKeyPkcs8B64: Buffer.from(pkcs8).toString("base64"),
  };
}

/** Throws unless every named file exists in `dir`. */
function requireFiles(dir: string, names: string[]): void {
  for (const n of names) {
    if (!existsSync(join(dir, n))) {
      throw new Error(`expected ${n} in ${dir}`);
    }
  }
}

/**
 * Asserts a Windows stub-layout install: stubs, a versioned DLL + server payload
 * for `version`, and both pointer files reading `version`.
 */
export function assertStubLayout(dir: string, version: string): void {
  requireFiles(dir, [
    "climon.exe",
    "climon-server.exe",
    `climon-${version}.dll`,
    `climon-server-${version}.exe`,
    "climon.version",
    "climon-server.version",
  ]);
  const clientPtr = readFileSync(join(dir, "climon.version"), "utf8").trim();
  const serverPtr = readFileSync(join(dir, "climon-server.version"), "utf8").trim();
  if (clientPtr !== version) {
    throw new Error(`climon.version = ${clientPtr}, expected ${version}`);
  }
  if (serverPtr !== version) {
    throw new Error(`climon-server.version = ${serverPtr}, expected ${version}`);
  }
}

/** Asserts a legacy layout: single climon.exe, no stub pointer files. */
export function assertLegacyLayout(dir: string): void {
  requireFiles(dir, ["climon.exe", "climon-server.exe"]);
  if (existsSync(join(dir, "climon.version"))) {
    throw new Error(`unexpected climon.version pointer in legacy dir ${dir}`);
  }
  if (existsSync(join(dir, "climon.dll"))) {
    throw new Error(`unexpected climon.dll in legacy dir ${dir}`);
  }
}

/**
 * Serves the signed release dir (manifest.json + climon-*.zip + *.sig) over
 * loopback only. Returns the server and the base URL (e.g. http://127.0.0.1:5599).
 */
export async function serveDir(dir: string): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\//, ""));
    const allowed = new Set(readdirSync(dir));
    if (!allowed.has(name)) {
      res.statusCode = 404;
      res.end("not found");
      return;
    }
    res.statusCode = 200;
    res.end(readFileSync(join(dir, name)));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("failed to bind harness server");
  }
  return { server, baseUrl: `http://127.0.0.1:${addr.port}` };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/upgrade-harness.test.ts`
Expected: PASS (keypair + all four layout-assertion cases + the Task 3 packaging cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/upgrade-harness/pack.ts tests/upgrade-harness.test.ts
git commit -m "feat(harness): pure helpers for keypair, layout assertions, loopback serve"
```

---

## Task 5: Harness entrypoint (`scripts/upgrade-test-harness.ts`)

The Windows-only orchestrator: build the test client, build+sign both zips at two versions,
serve them, and drive the four scenarios against scratch install dirs, asserting layout after
each. It shells out to the built binaries; it makes no production network calls.

**Files:**
- Create: `scripts/upgrade-test-harness.ts`
- Test: exercised end-to-end on a Windows box (documented in Task 6); the pure helpers it
  composes are already unit-tested in Task 4.

- [ ] **Step 1: Implement the harness entrypoint**

Create `scripts/upgrade-test-harness.ts`:

> **Implementation note (corrected design — supersedes the code listing below).**
> The served clients must themselves carry the `test-update-endpoint` feature, since
> `climon update` runs from the *served* binary, not a scratch build. So there is **no**
> standalone scratch-client build (it would be overwritten by `compile.ts` anyway). Instead:
> `rust/climon-dll/Cargo.toml` re-exports `test-update-endpoint`, and `compile.ts` threads
> `--features test-update-endpoint` into **both** served client builds (`climon-cli` legacy +
> `climon-dll` stub) when `CLIMON_TEST_UPDATE_ENDPOINT=1`. The harness sets that env in all
> three `compile.ts` invocations. Reaper timing: the in-process `climon update` holds the old
> `climon-<V>.dll` open (loaded), so it is correctly skipped-locked; the harness then runs a
> fresh `climon cleanup` (with an isolated `CLIMON_HOME`) which loads the new DLL and reaps the
> old one. See the committed `scripts/upgrade-test-harness.ts` for the authoritative code.

```ts
#!/usr/bin/env bun
/**
 * End-to-end Windows upgrade-test harness for the Feature 2 binary lifecycle.
 *
 * Runs on a REAL Windows box (the migration paths are #[cfg(windows)]-only). It:
 *   1. generates a throwaway Ed25519 keypair,
 *   2. builds a scratch `climon` client with --features test-update-endpoint and the
 *      test public key embedded (CLIMON_UPDATE_PUBKEY_B64),
 *   3. packages a bridge zip (legacy layout) and a C zip (stub layout) at version V,
 *      and a C+1 stub zip at version V2,
 *   4. signs them with the test private key via signReleaseDir + serves over loopback,
 *   5. drives: bridge->C migration, C->C+1 stub update, idempotent --migrate, and
 *      simulated-brick recovery, asserting on-disk layout after each.
 *
 * SECURITY: never reads the production signing key; the test feature/pubkey override are
 * never used by the release pipeline. See the plan's "Security invariants".
 */
import { $ } from "bun";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { signReleaseDir } from "./sign-release.js";
import {
  generateTestKeypair,
  assertStubLayout,
  assertLegacyLayout,
  serveDir,
} from "./upgrade-harness/pack.js";

if (process.platform !== "win32") {
  console.error("upgrade-test-harness must run on Windows (migration is #[cfg(windows)]).");
  process.exit(2);
}

const projectRoot = dirname(import.meta.dir);
const rustDir = resolve(projectRoot, "rust");
const V = "9.9.0"; // C release version (well above any real version)
const V2 = "9.9.1"; // C+1 release version

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `climon-${prefix}-`));
}

/** Unzips a harness zip into `dest` using PowerShell's Expand-Archive. */
async function unzipInto(zip: string, dest: string): Promise<void> {
  mkdirSync(dest, { recursive: true });
  await $`powershell -NoProfile -Command Expand-Archive -Path ${zip} -DestinationPath ${dest} -Force`;
}

async function main() {
  const kp = await generateTestKeypair();
  const workRoot = scratch("work");
  console.log(`harness work dir: ${workRoot}`);

  // 1. Build the scratch test client (feature-gated override + test pubkey embedded).
  console.log("→ Building scratch test client (climon-cli, test-update-endpoint)...");
  await $`cargo build --release -p climon-cli --features test-update-endpoint`
    .env({ ...process.env, CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64, CLIMON_VERSION: V })
    .cwd(rustDir);
  const testClientExe = resolve(rustDir, "target", "release", "climon.exe");
  if (!existsSync(testClientExe)) throw new Error(`missing test client ${testClientExe}`);

  // 2. Build the release dir served to the client: bridge + C at V, plus C+1 at V2.
  //    Each is produced by compile.ts into dist/, then copied into the served dir with a
  //    versioned name so the manifest can advertise V then V2.
  const releaseDir = join(workRoot, "release");
  mkdirSync(releaseDir, { recursive: true });

  console.log("→ Packaging bridge (legacy) zip...");
  await $`bun ${resolve(projectRoot, "scripts/compile.ts")}`
    .env({ ...process.env, CLIMON_LEGACY_LAYOUT: "1", CLIMON_VERSION: V,
           CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64 });
  const bridgeZip = join(releaseDir, "bridge-climon-windows-x64.zip");
  cpSync(resolve(projectRoot, "dist", "climon-windows-x64.zip"), bridgeZip);

  console.log("→ Packaging C (stub) zip at", V, "...");
  await $`bun ${resolve(projectRoot, "scripts/compile.ts")}`
    .env({ ...process.env, CLIMON_VERSION: V, CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64 });
  // signReleaseDir signs every climon-*.zip in a dir and writes manifest.json for that
  // version, so build one signed dir per advertised version.
  const cDir = join(workRoot, "serve-c");
  mkdirSync(cDir, { recursive: true });
  cpSync(resolve(projectRoot, "dist", "climon-windows-x64.zip"),
         join(cDir, "climon-windows-x64.zip"));

  console.log("→ Packaging C+1 (stub) zip at", V2, "...");
  await $`bun ${resolve(projectRoot, "scripts/compile.ts")}`
    .env({ ...process.env, CLIMON_VERSION: V2, CLIMON_UPDATE_PUBKEY_B64: kp.publicKeyRawB64 });
  const c1Dir = join(workRoot, "serve-c1");
  mkdirSync(c1Dir, { recursive: true });
  cpSync(resolve(projectRoot, "dist", "climon-windows-x64.zip"),
         join(c1Dir, "climon-windows-x64.zip"));

  // 3. Serve C first, sign for V.
  const { server: cServer, baseUrl: cBase } = await serveDir(cDir);
  await signReleaseDir({ distDir: cDir, version: V,
    privateKeyPkcs8B64: kp.privateKeyPkcs8B64, baseUrl: cBase });
  const cManifest = `${cBase}/manifest.json`;

  // ---- Scenario 1: bridge -> C migration ----
  console.log("\n=== Scenario 1: bridge -> C migration ===");
  const install = scratch("install");
  await unzipInto(bridgeZip, install);
  assertLegacyLayout(install); // sanity: started legacy, no pointer
  const stubClient = join(install, "climon.exe");
  await $`${stubClient} update`
    .env({ ...process.env, CLIMON_TEST_MANIFEST_URL: cManifest });
  assertStubLayout(install, V);
  const oldPreserved = existsSync(join(install, "climon.exe.old"));
  console.log(`  migrated to stub layout at ${V}; climon.exe.old preserved: ${oldPreserved}`);
  const ver1 = await $`${join(install, "climon.exe")} --version`.text();
  if (!ver1.includes(V)) throw new Error(`--version after migration = ${ver1}, want ${V}`);

  // ---- Scenario 2: C -> C+1 stub update (additive write + pointer flip, reaper) ----
  console.log("\n=== Scenario 2: C -> C+1 stub update ===");
  const { server: c1Server, baseUrl: c1Base } = await serveDir(c1Dir);
  await signReleaseDir({ distDir: c1Dir, version: V2,
    privateKeyPkcs8B64: kp.privateKeyPkcs8B64, baseUrl: c1Base });
  await $`${join(install, "climon.exe")} update`
    .env({ ...process.env, CLIMON_TEST_MANIFEST_URL: `${c1Base}/manifest.json` });
  assertStubLayout(install, V2);
  const files2 = readdirSync(install);
  if (files2.includes(`climon-${V}.dll`)) {
    throw new Error(`reaper failed: strictly-older climon-${V}.dll still present`);
  }
  console.log(`  updated to ${V2}; older payload reaped`);

  // ---- Scenario 3: idempotent install.exe --migrate ----
  console.log("\n=== Scenario 3: idempotent --migrate ===");
  const stagedC = scratch("staged-c");
  await unzipInto(join(cDir, "climon-windows-x64.zip"), stagedC);
  const migrateTarget = scratch("install-mig");
  await unzipInto(bridgeZip, migrateTarget);
  const installerExe = join(stagedC, "install.exe");
  await $`${installerExe} --migrate --dir ${migrateTarget} --source ${stagedC}`;
  assertStubLayout(migrateTarget, V);
  const before = readdirSync(migrateTarget).sort().join(",");
  await $`${installerExe} --migrate --dir ${migrateTarget} --source ${stagedC}`;
  assertStubLayout(migrateTarget, V);
  const after = readdirSync(migrateTarget).sort().join(",");
  if (before !== after) throw new Error(`--migrate not idempotent: ${before} != ${after}`);
  console.log("  --migrate is idempotent");

  // ---- Scenario 4: simulated brick + recovery (confirmed framing) ----
  console.log("\n=== Scenario 4: simulated brick + recovery ===");
  const broken = scratch("install-broken");
  mkdirSync(broken, { recursive: true });
  // Corrupt install: legacy climon.exe (actually C's installer bytes) + stray C files,
  // no working stub, no valid pointer — the documented "skipped the bridge" brick.
  cpSync(installerExe, join(broken, "climon.exe"));
  cpSync(join(stagedC, "climon.dll"), join(broken, `climon-${V}.dll`));
  cpSync(join(stagedC, "climon-server.exe"), join(broken, "climon-server.exe"));
  // Recovery: run the dedicated installer's migrate path against staged C.
  await $`${installerExe} --migrate --dir ${broken} --source ${stagedC}`;
  assertStubLayout(broken, V);
  const ver4 = await $`${join(broken, "climon.exe")} --version`.text();
  if (!ver4.includes(V)) throw new Error(`--version after recovery = ${ver4}, want ${V}`);
  console.log("  recovered a bricked install to a clean stub layout");

  cServer.close();
  c1Server.close();
  console.log("\n✓ All upgrade-test scenarios passed.");
  console.log(`  (scratch dirs left under ${tmpdir()} for inspection; delete when done)`);
}

main().catch((err) => {
  console.error("\n✗ upgrade-test-harness failed:", err);
  process.exit(1);
});
```

- [ ] **Step 2: Lint/type-check the harness scripts**

Run: `bun run typecheck`
Expected: no *new* type errors in `scripts/upgrade-test-harness.ts`,
`scripts/upgrade-harness/pack.ts`, or `tests/upgrade-harness.test.ts`. (Pre-existing
`@types/node` errors noted in the handoff are not regressions.)

- [ ] **Step 3: Run the harness on a Windows box**

Run (on Windows, from repo root): `bun scripts/upgrade-test-harness.ts`
Expected: prints each scenario header and `✓ All upgrade-test scenarios passed.` If a
scenario fails, it exits non-zero with the failing assertion and the scratch dir path.

> If `install.exe --migrate` argument names differ from `--dir/--source`, reconcile with
> `rust/climon-install/src/installer.rs::parse_migrate_args` and update the harness calls
> (do not change the installer to match the harness).

- [ ] **Step 4: Commit**

```bash
git add scripts/upgrade-test-harness.ts
git commit -m "feat(harness): end-to-end Windows upgrade-test scenarios"
```

---

## Task 6: Docs — map manual tests to the harness + note the dev-only override

**Files:**
- Modify: `docs/manual-tests/windows-binary-lifecycle.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Add a harness note to the manual-test doc**

At the top of `docs/manual-tests/windows-binary-lifecycle.md`, after the intro paragraph
(the block ending "...and bridge `--migrate` conversion."), add:

```markdown
> **Automated coverage:** `scripts/upgrade-test-harness.ts` automates the migration/update
> paths on a real Windows box (bridge→C, C→C+1, idempotent `--migrate`, and a simulated
> brick+recovery). It uses a throwaway Ed25519 key and a loopback manifest via the dev-only
> `test-update-endpoint` feature; the production signing key and release pipeline are never
> involved. Run it with `bun scripts/upgrade-test-harness.ts` on Windows. The cases below
> remain the manual source of truth; MT-WBL-07/08/09/10 map onto harness scenarios
> 1/1/4/3 respectively.
```

- [ ] **Step 2: Note the override in architecture docs**

In `docs/architecture.md`, in the "Binary lifecycle and release layout" section (find it
with `grep -n "Binary lifecycle" docs/architecture.md`), add a short paragraph at the end
of that section:

```markdown
For pre-release verification, `climon-update` carries a dev-only, compiled-out
`test-update-endpoint` cargo feature: when enabled it lets `climon update` read its manifest
URL from `CLIMON_TEST_MANIFEST_URL`, and `climon-update/build.rs` accepts a
`CLIMON_UPDATE_PUBKEY_B64` build-time override so a scratch client can trust a throwaway test
key. Neither is enabled by `scripts/compile.ts` or `.github/workflows/release.yml`, so
shipped binaries physically lack the override and always embed the real key. The
`scripts/upgrade-test-harness.ts` end-to-end harness composes these to exercise the Windows
migration paths on a real Windows box.
```

- [ ] **Step 3: Verify docs reference real paths**

Run: `git grep -n "upgrade-test-harness" docs/`
Expected: references in both `docs/manual-tests/windows-binary-lifecycle.md` and
`docs/architecture.md`, and the file `scripts/upgrade-test-harness.ts` exists.

- [ ] **Step 4: Commit**

```bash
git add docs/manual-tests/windows-binary-lifecycle.md docs/architecture.md
git commit -m "docs: document the Windows upgrade-test harness and dev-only override"
```

---

## Final verification (run before opening/updating the PR)

- [ ] **Rust:** `cd rust && cargo build -p climon-cli && cargo test -p climon-update && cargo test -p climon-update --features test-update-endpoint && cargo clippy --all-targets && cargo fmt --check`
  Expected: all clean; the feature-gated tests pass in both states.
- [ ] **Bun unit:** `bun test tests/upgrade-harness.test.ts`
  Expected: PASS (packaging + keypair + layout assertions).
- [ ] **Packaging inertness:** `git grep -n "CLIMON_LEGACY_LAYOUT\|CLIMON_TEST_UPDATE_ENDPOINT\|test-update-endpoint\|CLIMON_TEST_MANIFEST_URL" -- .github`
  Expected: **no matches** — the release pipeline never enables any test hook.
- [ ] **Windows E2E (real box):** `bun scripts/upgrade-test-harness.ts`
  Expected: `✓ All upgrade-test scenarios passed.`
- [ ] **Hybrid phase B (manual, per handoff §4):** cut a CI-signed GitHub **pre-release** of a
  C build and run `climon update` against it on Windows to confirm the *real* embedded key
  verifies *real* CI-signed artifacts. No test code involved; nothing published to `latest`.

---

## Notes for the executor

- **Do the Rust tasks (1–2) first**, then packaging (3), then the harness (4–5), then docs (6).
  Tasks 1–4 are verifiable on the macOS/Linux dev host; task 5's end-to-end run requires
  Windows.
- **Never** add `test-update-endpoint`, `CLIMON_TEST_UPDATE_ENDPOINT`, `CLIMON_TEST_MANIFEST_URL`,
  `CLIMON_LEGACY_LAYOUT`, or `CLIMON_UPDATE_PUBKEY_B64` to `.github/workflows/release.yml` or the
  default `compile.ts` path. If a step tempts you to, stop — it violates Security invariant 1/2.
- This harness is test tooling, not a shipped user feature, so it needs **no** `docs/features.md`
  row and **no** `feature.*` flag. It does update the existing WBL manual-test doc.
- If `install.exe` migrate flags or reaper file-naming differ from what the harness asserts,
  treat the shipping Feature 2 code as the source of truth and adjust the harness — do not
  bend Feature 2 to fit the test.
