# Devtunnel launch-probe timeout + messaging

Date: 2026-07-11
Branch: `design/devtunnel-resilience`

## Problem

When a session is launched with remote monitoring configured
(`remote.enabled = true`, `remote.tunnelId` set, no direct `remote.host`), the
launcher runs a **synchronous** Dev Tunnels probe before starting the session:
`probe_devtunnel_sync()` calls `gateway.detect()` (`devtunnel --version`, a
network round-trip) followed by `gateway.show_user()`
(`devtunnel user show --json`). This probe has **no timeout**. If `devtunnel`
stalls on its network call, session start hangs indefinitely with **no message**
to the user — exactly the failure originally hit on the Windows devbox.

The launcher already surfaces clear messages for two devtunnel problems:

- CLI missing / not runnable → warning via `plan_uplink_start`.
- CLI present but not signed in → warning via `plan_uplink_start`.

The missing case is a **stall/timeout**, which currently produces silence.

## Goal

Ensure the client always tells the user when there is a problem with the
devtunnel at launch time. Specifically: a stalled probe must never hang session
start or fail silently. Scope is **launch-time only** — post-spawn runtime
failures of the detached uplink remain surfaced through `climon remotes` and are
out of scope here.

## Design

### 1. Third probe state: timed out

`DevtunnelProbe` (in `rust/climon-cli/src/launcher.rs`) gains a third state so
planning can distinguish "the CLI is missing" from "the CLI didn't answer in
time":

```rust
pub struct DevtunnelProbe {
    pub available: bool,
    pub authenticated: bool,
    pub timed_out: bool,
}
```

`timed_out` is mutually the "we don't know" signal: `available` and
`authenticated` are `false` when `timed_out` is `true`.

### 2. Bounded probe

`probe_devtunnel_sync()` wraps the combined `detect() + show_user()` future in a
single total timeout:

```rust
const DEVTUNNEL_PROBE_TIMEOUT: Duration = Duration::from_secs(5);
```

- On success within the budget: unchanged behaviour (`available` /
  `authenticated` reflect the gateway result; `timed_out = false`).
- On elapse: return
  `DevtunnelProbe { available: false, authenticated: false, timed_out: true }`.
- Runtime build failure (current early return) stays
  `{ available: false, authenticated: false, timed_out: false }` — that is a
  genuine "cannot even try" condition and keeps the existing missing-CLI
  warning.

The 5-second budget is long enough for a healthy round-trip yet short enough to
not feel like a hang.

### 3. Best-effort planning on timeout

`plan_uplink_start()` handles `timed_out` **after** the `tunnel_id` check and
**before** the availability check, so it only applies when a tunnel was actually
needed:

```
if !config.enabled                     -> no spawn, no warning
if host && port                        -> spawn (direct; no devtunnel needed)
if tunnel_id.is_none()                 -> no spawn, no warning
if probe.timed_out                     -> spawn (best-effort) + warning   // NEW
if !probe.available                    -> no spawn + "not installed" warning
if !probe.authenticated                -> no spawn + "not signed in" warning
else                                   -> spawn
```

On timeout the plan is `should_spawn: true` with the warning:

> `climon: Dev Tunnels didn't respond within 5s; starting remote monitoring
> anyway. If sessions don't appear on the remote dashboard, check
> `climon remotes` or run `devtunnel user login`.`

Rationale: a slow-but-working devtunnel should still connect. The detached
uplink runs its own discovery with capped exponential backoff and reports state
via `climon remotes`, so spawning best-effort is the resilient choice, while the
warning keeps the user informed.

## Error handling / edge cases

- **Direct `host + port`**: never probes; unaffected.
- **Runtime build failure**: falls through to the existing missing-CLI warning
  (acceptable — we could not run the probe at all).
- **Probe returns unavailable/unauthenticated quickly**: unchanged existing
  warnings.

## Testing

- Unit tests on the pure `plan_uplink_start`:
  - `timed_out: true` (with `enabled`, `tunnel_id`, no host) →
    `should_spawn: true` and a warning whose text mentions the timeout and
    `climon remotes`.
  - `host + port` with `timed_out: true` → still the direct-spawn path, no
    warning (timeout ignored when no tunnel is needed).
  - Update existing `DevtunnelProbe` literals in tests to add
    `timed_out: false`.
- The I/O timeout wrapper in `probe_devtunnel_sync()` is covered by the manual
  test rather than a unit test, because the gateway is constructed inline
  (`DevtunnelGateway::new()`) and is not injectable there. Extracting a trait to
  unit-test the wrapper is deliberately out of scope (YAGNI).

## Docs

- Add a manual-test case under `docs/manual-tests/` (stub a `devtunnel` on PATH
  that sleeps > 5s; confirm the session starts within ~5s and prints the
  timeout warning). Link it from the manual-tests README index.
- Note the probe timeout behaviour briefly in `docs/architecture.md` where the
  launch/uplink flow is described.
- Update `docs/features.md` if this hardening warrants a catalogue row.

## Out of scope

- Surfacing live post-spawn uplink/discovery failures back to the launching
  terminal (would require the detached uplink to report back).
- Making the timeout configurable via config/env (YAGNI; fixed 5s const).
