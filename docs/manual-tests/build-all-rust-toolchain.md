# `bun run build` builds the Rust client + on-demand toolchain bootstrap

These cases prove that `bun run build` also builds the Rust `climon` client
(`build:rust`), and that a fresh checkout needs only `bun install` followed by
`bun run build` — the `build:rust` step provisions a minimal Rust toolchain
via rustup when `cargo` is missing.

Background: the client is the Rust binary built from `rust/climon-cli`. Before
this change `build` built only the web bundle and server entrypoint.
`build:rust` (`scripts/build-rust.ts`) now runs `cargo build -p climon-cli`,
locating cargo via the shared helper (`scripts/rust-toolchain.ts` → `ensureRust`,
which checks `PATH` and rustup's default `~/.cargo/bin`, installing rustup if
neither has cargo). The `postinstall` hook only *reports* toolchain status and
never downloads, so `bun install` stays lightweight.

No configuration matrix applies. On **Windows**, building the client also
requires the Visual Studio C++ Build Tools (`link.exe`); rustup cannot install
those.

---

## MT-BR-01 — `build` builds the Rust client when cargo is present

- **ID:** MT-BR-01
- **Feature / phase:** `build` builds the Rust client
- **Preconditions:** Repo checked out; `bun install` done; `cargo --version`
  works on `PATH`. On Windows, VS C++ Build Tools installed.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. From the repo root, run `bun run build`.
2. Watch the output for the `build:rust` step
   (`→ Building Rust client (... build -p climon-cli)`).
3. Confirm the client binary exists afterwards:
   `rust/target/debug/climon` (`climon.exe` on Windows).

**Expected result:**
- `build` runs `clean` → `build:web` → `build:server` → `build:rust` in
  order and exits 0.
- The `build:rust` step compiles `climon-cli` and produces
  `rust/target/debug/climon[.exe]`.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-BR-02 — `build:rust` installs the toolchain when cargo is missing

- **ID:** MT-BR-02
- **Feature / phase:** on-demand rustup bootstrap
- **Preconditions:** A machine (or container) with **no** Rust toolchain
  (`cargo` not on `PATH` and no `~/.cargo/bin/cargo`); network access to
  rustup.rs; `bun install` done. On Windows, VS C++ Build Tools installed (so the
  subsequent compile can link).
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Confirm cargo is absent (`cargo --version` fails; `~/.cargo/bin` has no
   `cargo`).
2. Run `bun run build:rust`.
3. Observe the log line
   `→ cargo not found; installing the Rust toolchain via rustup (minimal profile)...`
   followed by rustup output, then the client build.
4. After it completes, run `cargo --version` (opening a new shell / sourcing
   `~/.cargo/env` if needed) and confirm cargo is now installed.

**Expected result:**
- `build:rust` downloads and runs rustup (minimal profile, stable), then builds
  `climon-cli` — no manual Rust install was required beforehand.
- cargo is available for subsequent builds.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-BR-03 — `postinstall` reports status only and never downloads

- **ID:** MT-BR-03
- **Feature / phase:** lightweight `postinstall` hook
- **Preconditions:** Repo checked out.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run `bun scripts/rust-toolchain.ts` (the `postinstall` entry) with cargo
   present: confirm it prints `✓ Rust toolchain detected (...)` and exits 0.
2. Run it again in an environment where cargo is absent (or temporarily move
   `~/.cargo/bin` aside): confirm it prints
   `ℹ Rust toolchain (cargo) not found — \`bun run build\` will install it on
   first client build.`, exits 0, and does **not** download anything.
3. Confirm `CLIMON_SKIP_RUST_INSTALL=1 bun run build:rust` fails fast with a
   clear "cargo not found and CLIMON_SKIP_RUST_INSTALL=1" error instead of
   installing.

**Expected result:**
- `postinstall` never downloads a toolchain and never fails `bun install`.
- `CLIMON_SKIP_RUST_INSTALL=1` disables the on-demand install in `build:rust`.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
