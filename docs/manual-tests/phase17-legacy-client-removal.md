# Phase 17 — Legacy Bun client removal

These checks prove that the deleted Bun/TypeScript client is no longer required
for local development, builds, tests, or the dashboard workflow. The Rust
workspace provides the `climon` client, while the maintained Bun code builds and
runs only the dashboard server/web and shared support modules.

No configuration matrix applies beyond platform coverage.

---

## MT-P17-01 — Rust client works with the maintained Bun dashboard

- **ID:** MT-P17-01
- **Feature / phase:** Legacy Bun client removal
- **Preconditions:** Clean checkout of this branch with Rust stable and Bun
  installed.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Install Bun dependencies: `bun install`.
2. Type-check the maintained TypeScript server/web support code:
   `bun run typecheck`.
3. Run the Bun test suite: `bun test tests`.
4. Build the dashboard server: `bun run build:server`.
5. Build the dashboard web bundle: `bun run build:web`.
6. Build the Rust client:
   `cargo build --release --manifest-path rust/Cargo.toml`.
7. In terminal 1, start the dashboard server:
   `bun src/server.ts server`.
8. Load http://127.0.0.1:3131 in a browser.
9. In terminal 2, start a monitored session with the Rust client:
   `./rust/target/release/climon echo hello`.
10. Return to the dashboard and open the new session.

**Expected result:**
- `bun install`, `bun run typecheck`, `bun test tests`, `bun run build:server`,
  `bun run build:web`, and the Rust release build all pass.
- The dashboard loads from `bun src/server.ts server`.
- The session started by the Rust `climon` client appears in the dashboard and
  shows the expected output.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
