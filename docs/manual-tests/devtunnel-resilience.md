# Dev-tunnel resilience

Manual checks for the hardened dev-tunnel behaviour: an always-visible Tunnel
Link, classified failures with remediation, capped-backoff retry for transient
errors, manual (never automated) login and quota cleanup, and matching health in
the dashboard and `climon remotes`.

All dev-tunnel failures are classified through a shared JSON contract
(`fixtures/devtunnel/failures.json`) so the Bun gateway
(`src/devtunnel/gateway.ts`, `src/devtunnel/classify.ts`) and the Rust gateway
(`rust/climon-remote/src/devtunnel/gateway.rs`,
`rust/climon-remote/src/devtunnel/classify.rs`) produce identical codes,
remediation, and retry classes.

## DTRS-01 — CLI absent: Tunnel Link stays visible and links to install docs

- **ID:** DTRS-01
- **Feature / phase:** Dev-tunnel resilience — always-visible Tunnel Link with
  classified failure (`src/server/dashboard-tunnel.ts`,
  `src/web/components/DevtunnelFailure.tsx`, `src/devtunnel/classify.ts`).
- **Preconditions:** A local dashboard server is running. The `devtunnel`
  binary is **not** on `PATH` (rename or remove it, or launch the server with a
  `PATH` that excludes it).
- **Config-matrix cell:** Dashboard Tunnel Link
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. Ensure `devtunnel` cannot be found (e.g. `mv "$(command -v devtunnel)"
   devtunnel.bak`, or start the server from a shell whose `PATH` excludes it).
2. Open the dashboard and open the ☰ menu.
3. Confirm the **Tunnel Link** entry is present (not hidden).
4. Click **Tunnel Link** and read the dialog.

**Expected:** The ☰ menu still shows **Tunnel Link** even though Dev Tunnels
isn't ready. The dialog reports the classified `cli_missing` failure with a
friendly summary and remediation telling you to install the Microsoft
`devtunnel` CLI, a **Retry** button, and a link to the Dev Tunnels installation
docs referenced from the README. climon does **not** attempt to install the CLI
itself.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-02 — Installing the CLI then Retry advances to the next state

- **ID:** DTRS-02
- **Feature / phase:** Dev-tunnel resilience — Retry re-probes and advances state
  (`src/server/dashboard-tunnel.ts`, `src/web/components/DevtunnelFailure.tsx`,
  `src/devtunnel/gateway.ts`).
- **Preconditions:** Start from the DTRS-01 end state — the Tunnel Link dialog is
  open and showing `cli_missing`.
- **Config-matrix cell:** Dashboard Tunnel Link
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. Leave the Tunnel Link dialog open on the `cli_missing` failure.
2. In a terminal, restore/install the `devtunnel` CLI onto `PATH` (e.g. move
   `devtunnel.bak` back, or install per the linked docs).
3. Back in the dialog, click **Retry**.

**Expected:** The dialog re-probes and advances to the next state instead of
staying on `cli_missing`: if you are not signed in it now shows
`not_authenticated`; if you are already signed in the tunnel starts and the
dialog shows the running Tunnel Link URL. No page reload is required.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-03 — Logged out: exact login command, manual login, explicit Retry

- **ID:** DTRS-03
- **Feature / phase:** Dev-tunnel resilience — manual authentication
  (`not_authenticated` classification; `src/web/components/DevtunnelFailure.tsx`,
  `rust/climon-remote/src/devtunnel/classify.rs`).
- **Preconditions:** `devtunnel` CLI is installed. You are signed **out**
  (`devtunnel user logout`). A local dashboard server is running.
- **Config-matrix cell:** Dashboard Tunnel Link
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. Run `devtunnel user logout` to force the signed-out state.
2. Open the dashboard ☰ menu → **Tunnel Link**.
3. Read the failure summary and remediation.
4. Without touching climon, run `devtunnel user login` in a terminal and
   complete the Microsoft/GitHub sign-in.
5. Return to the dialog and click **Retry**.

**Expected:** Step 3 shows the classified `not_authenticated` failure whose
remediation tells you to run the exact command `devtunnel user login` and then
Retry. climon never auto-logs-in and never launches the sign-in for you. After
the manual login (step 4), the explicit **Retry** succeeds and the Tunnel Link
starts.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-04 — Tunnel quota exhausted: friendly message, manual cleanup only

- **ID:** DTRS-04
- **Feature / phase:** Dev-tunnel resilience — manual quota cleanup
  (`tunnel_quota_exhausted` classification; `src/devtunnel/classify.ts`,
  `rust/climon-remote/src/devtunnel/classify.rs`).
- **Preconditions:** `devtunnel` CLI installed and signed in. The account has
  reached its dev tunnel limit (create tunnels with `devtunnel create` until the
  limit is hit, or otherwise ensure a new create will fail with the quota error).
- **Config-matrix cell:** Dashboard Tunnel Link
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. With the account at its tunnel limit, open the dashboard ☰ menu →
   **Tunnel Link** (or restart the ingest tunnel) so a tunnel create is
   attempted.
2. Read the failure summary and remediation.
3. Confirm no tunnels were deleted by climon (`devtunnel list`).

**Expected:** The failure is classified `tunnel_quota_exhausted` with a friendly
message that you have reached your dev tunnel limit, and remediation telling you
to remove unused tunnels with `devtunnel list` / `devtunnel delete`. climon does
**not** automatically delete any tunnels — `devtunnel list` shows the same
tunnels before and after.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-05 — HTTP 429: transient retry with capped backoff and Retry now

- **ID:** DTRS-05
- **Feature / phase:** Dev-tunnel resilience — transient retry with
  capped-exponential backoff (`rate_limited`; `src/devtunnel/retry.ts`,
  `rust/climon-remote/src/devtunnel/retry.rs`).
- **Preconditions:** `devtunnel` CLI installed and signed in. A way to provoke an
  HTTP 429 from the Dev Tunnels service (rapid repeated tunnel operations, or a
  test double that returns `HTTP 429 Too Many Requests`).
- **Config-matrix cell:** Dashboard Tunnel Link
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. Provoke a `429` response while starting or refreshing Tunnel Link.
2. Observe the dialog/status while it retries.
3. Click **Retry now** before the scheduled retry elapses.

**Expected:** The failure is classified as transient (`rate_limited`) and climon
retries automatically with capped-exponential backoff (1s → 30s) plus jitter,
honouring any `Retry-After`. The dialog shows the next retry time (state
`retrying`), and **Retry now** forces an immediate re-attempt. The local
dashboard stays usable throughout.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-06 — Service/network outage: local dashboard stays available, status retries

- **ID:** DTRS-06
- **Feature / phase:** Dev-tunnel resilience — transient outage handling
  (`network_unavailable`/`service_unavailable`; `src/devtunnel/classify.ts`,
  `src/devtunnel/retry.ts`).
- **Preconditions:** `devtunnel` CLI installed and signed in. A running local
  dashboard with Tunnel Link started. Ability to sever network reachability to
  the Dev Tunnels service (disable the network, block `*.devtunnels.ms`).
- **Config-matrix cell:** Dashboard Tunnel Link
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. With Tunnel Link running, cut network reachability to the Dev Tunnels service.
2. Load the **local** dashboard URL (`127.0.0.1`) in a browser.
3. Watch the Tunnel Link status.

**Expected:** The local (loopback) dashboard remains fully available. The
Tunnel Link failure is classified transient and the status shows it is retrying
with capped backoff (state `retrying`) rather than a hard error. When the
network returns, the tunnel recovers on the next retry.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-07 — Persisted tunnel missing: exactly one safe recreate

- **ID:** DTRS-07
- **Feature / phase:** Dev-tunnel resilience — single safe recreate on
  `tunnel_not_found` (`rust/climon-remote/src/devtunnel/gateway.rs`,
  `src/devtunnel/gateway.ts`).
- **Preconditions:** `devtunnel` CLI installed and signed in. A persisted
  climon-owned tunnel exists (e.g. the `climon-ingest` tunnel recorded in
  `~/.climon/remote-host.json`, or a started Tunnel Link).
- **Config-matrix cell:** Remote ingest/uplink
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. Note the persisted tunnel id (`devtunnel list`).
2. Out-of-band, delete that tunnel: `devtunnel delete <id>`.
3. Trigger the operation that uses it again (restart ingest, or reopen Tunnel
   Link).
4. Observe the logs/status and `devtunnel list`.

**Expected:** climon detects the `tunnel_not_found` condition and performs
**exactly one** safe recreate of the missing tunnel, then continues. It does not
loop recreating tunnels; a second missing-tunnel event surfaces the classified
failure rather than spawning additional tunnels.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-08 — Host/connect process exit: transient retry vs actionable pause

- **ID:** DTRS-08
- **Feature / phase:** Dev-tunnel resilience — process-exit classification and
  retry (`process_exited`; `src/devtunnel/process.ts`,
  `rust/climon-remote/src/devtunnel/gateway.rs`,
  `rust/climon-remote/src/devtunnel/retry.rs`).
- **Preconditions:** `devtunnel` CLI installed and signed in. A remote
  ingest/uplink bridge running via `devtunnel host`/`devtunnel connect`.
- **Config-matrix cell:** Remote ingest/uplink
- **Platforms:** macOS, Linux, Windows (host/devbox)

**Steps:**
1. With the bridge running, kill the long-lived `devtunnel host`/`devtunnel
   connect` process by PID.
2. Observe the status and retry behaviour.
3. Repeat, but this time cause an actionable failure (e.g. sign out with
   `devtunnel user logout` so the reconnect hits `not_authenticated`).

**Expected:** A transient process exit is classified `process_exited` and the
bridge retries with capped backoff and recovers when the process comes back. An
actionable failure (auth/quota/permission) instead **pauses** — the status shows
`retry: paused` and waits for you to fix it and Retry, rather than looping.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-09 — Dashboard and `climon remotes --json` expose matching code/state

- **ID:** DTRS-09
- **Feature / phase:** Dev-tunnel resilience — normalized `DevtunnelHealth`
  across surfaces (`src/devtunnel/types.ts` `DevtunnelHealth`,
  `rust/climon-cli/src/remotes_cmd.rs`, `src/web/components/DevtunnelFailure.tsx`).
- **Preconditions:** `devtunnel` CLI installed. Force any classified failure
  (e.g. sign out for `not_authenticated`, or exhaust quota for
  `tunnel_quota_exhausted`). A local dashboard server is running.
- **Config-matrix cell:** Remote ingest/uplink
- **Platforms:** macOS, Linux, Windows (dashboard host)

**Steps:**
1. Provoke a known classified failure.
2. Open the dashboard and note the failure code/state it shows.
3. Run `climon remotes` and read the human output.
4. Run `climon remotes --json` and read the structured health.

**Expected:** The dashboard and `climon remotes --json` report the **same**
error `code` and lifecycle `state`. Default `climon remotes` renders a friendly
line `<summary> [<code>] at <occurred_at>`, the remediation, and either
`retry: paused` (actionable) or `retry: <next_retry_at>` (transient); the raw
technical detail is hidden in human output but present under `--json`. The
`--json` health carries `available`, `authenticated`, `version`, `state`,
`lastSuccessAt`, `lastFailure`, `retry`, and `probedAt`.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-10 — Happy path: normal Tunnel Link and remote ingest/uplink operation

- **ID:** DTRS-10
- **Feature / phase:** Dev-tunnel resilience — healthy Tunnel Link and remote
  bridge (`src/devtunnel/gateway.ts`, `rust/climon-remote/src/devtunnel/gateway.rs`).
- **Preconditions:** `devtunnel` CLI installed and signed in on all hosts.
  `feature.remotes` enabled with a home dashboard and a devbox uplink.
- **Config-matrix cell:** Remote ingest/uplink
- **Platforms:** macOS, Linux, Windows (home + devbox)

**Steps:**
1. On the home dashboard, open ☰ → **Tunnel Link** and confirm it starts and
   prints an HTTPS `*.devtunnels.ms` URL.
2. Open that URL from another device and confirm the dashboard loads.
3. On the devbox, start the uplink and confirm remote sessions appear on the
   home dashboard.
4. Run `climon remotes` on both sides.

**Expected:** Tunnel Link starts cleanly and is reachable; remote sessions
appear on the home dashboard; `climon remotes` reports healthy ingest/uplink
state (`state: running`, `available: true`, `authenticated: true`) with no
failure line. No spurious failures or retries are shown while everything is
healthy.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |

---

## DTRS-11 — Stalled devtunnel at launch: 5s timeout, warning, best-effort spawn

- **ID:** DTRS-11
- **Feature / phase:** Dev-tunnel resilience — bounded launch probe with
  best-effort spawn (`rust/climon-cli/src/launcher.rs` `probe_devtunnel_sync`,
  `plan_uplink_start`).
- **Preconditions:** `remote.enabled = true` and `remote.tunnelId` set (no
  direct `remote.host`), so launching a session runs the synchronous devtunnel
  probe. Ability to put a **stub `devtunnel` that sleeps > 5s** first on `PATH`
  (e.g. a script that runs `sleep 30` for any args, or on Windows a `.cmd` that
  `timeout /t 30`). This simulates a stalled Dev Tunnels network call.
- **Config-matrix cell:** Remote ingest/uplink
- **Platforms:** macOS, Linux, Windows (devbox/uplink side)

**Steps:**
1. Put the sleeping stub `devtunnel` first on `PATH` so `devtunnel --version`
   hangs for ~30s.
2. Launch a session, e.g. `climon shell` (or `bun run dev shell` from source).
3. Time how long until the session terminal appears, and read stderr.

**Expected:** The session starts within ~5 seconds (not blocked for the full
stub sleep). Before/at launch, stderr prints the warning `climon: Dev Tunnels
didn't respond within 5s; starting remote monitoring anyway. If sessions don't
appear on the remote dashboard, check `climon remotes` or run `devtunnel user
login`.` The uplink is still spawned (best-effort). Removing the stub and using
a real, healthy `devtunnel` prints no such warning and starts normally.

**Result-tracking row:**

| Date | Build | Platform | Result | Notes |
|---|---|---|---|---|
| | | | | |
