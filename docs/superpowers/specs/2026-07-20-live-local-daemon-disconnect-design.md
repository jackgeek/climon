# Live Local Daemon Disconnect Reconciliation

## Purpose

DAR-09 force-terminates a local session host while the dashboard is attached.
The daemon socket disappears, but the dashboard currently leaves the session in
its previous live status and repeatedly reconnects the terminal. The server must
reconcile that known bridge failure into durable `disconnected` metadata without
overwriting a concurrent terminal transition.

## Scope

This change applies only to local sessions whose dashboard-to-daemon bridge
fails. It does not change remote-session liveness, browser reconnect policy for
healthy sessions, daemon shutdown behavior, or the legacy/actor engine boundary.

Remote sessions retain their existing ingest lifecycle: an uplink loss marks
materialized sessions disconnected and removes their bridge sockets; a
reconnected client advertises the same sessions under the same namespaced IDs,
recreates the sockets, restores their advertised status, and lets an open
terminal attach again automatically.

## Design

Add a testable server helper that reconciles a possible local daemon loss by:

1. Re-reading the session metadata by ID so the decision uses current state.
2. Returning without mutation when the session no longer exists, is remote, or
   is already terminal/disconnected.
3. Probing the current metadata's socket path.
4. Returning without mutation when the socket responds.
5. Applying a current-state conditional patch only while the session remains a
   live local session, setting:
   - `status: "disconnected"`
   - `priorityReason: "disconnected"`

The WebSocket bridge invokes this reconciliation when its daemon socket emits
`error` or `close`. The two events are deduplicated per bridge. The browser
WebSocket is then closed so the metadata update can move the terminal out of its
live reconnect loop.

Closing a browser WebSocket is not evidence of daemon death. The existing
browser-close handler only destroys that viewer's daemon bridge and does not run
reconciliation.

## Race Safety

The re-read, probe, and conditional patch protect two important races:

- A transient bridge error with a still-responsive current socket does not mark
  the session disconnected.
- A daemon that persists `completed` or `failed` while reconciliation is in
  flight keeps that terminal status; the conditional patch must not overwrite
  it.

Remote metadata is excluded even if its local bridge socket closes because the
ingest connection owns remote liveness and recovery.

## Error Handling

Socket failure still closes the affected browser WebSocket immediately.
Reconciliation runs asynchronously. A metadata read, probe, or patch failure is
reported through a catalogued warning with the session ID and error detail; it
is not swallowed or represented as a successful reconciliation.

## Test Strategy

Use strict TDD for focused server tests covering:

- A dead socket marks a live local session disconnected.
- A responsive current socket leaves metadata unchanged.
- A concurrent `completed` or `failed` transition is preserved.
- Remote sessions are never reconciled by the local helper.
- Browser-initiated close does not invoke daemon-loss reconciliation.
- Daemon `error` plus `close` invokes reconciliation once.
- Reconciliation failures emit the catalogued warning.

After automated tests, rerun DAR-09 against the exact actor candidate:

1. Open a live local session in the dashboard.
2. Force-terminate the `climon __session` host.
3. Confirm the daemon listener disappears.
4. Confirm the card changes to `disconnected`.
5. Confirm the open terminal stops reconnecting and no longer appears live.

This defect must pass before DAR-10 and the final same-candidate DAR-01 through
DAR-10 sweep.
