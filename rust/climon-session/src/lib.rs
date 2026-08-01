//! climon session host.
//!
//! A thread-based Rust port of the TypeScript client's session host. It is the
//! production superset of `src/session-host.ts` and `src/daemon/daemon.ts`: one
//! cohesive [`host::SessionHost`] that owns the PTY, the per-session IPC socket
//! server (Unix domain socket / loopback TCP), the scrollback shadow, screen
//! idle/attention detection, the full frame-protocol relay, dashboard-driven
//! title broadcast, optional local-terminal relay (attached vs headless), and
//! the session lifecycle (`running`→`completed`/`failed`).
//!
//! ## Interop boundary
//! Every byte that crosses to the Bun server (and on to browser viewers) is
//! produced via [`climon_proto::frame`], whose encodings already match the Bun
//! `src/ipc/frame.ts`. This crate never redefines those types.
//!
//! ## Idle detection: PTY output inactivity
//! The idle detector ([`idle::OutputIdleDetector`]) flags attention once no PTY
//! output chunk has been recorded for `idle_seconds`, and clears on the next
//! chunk. It does not sample or compare rendered screen content: a session that
//! is genuinely producing no output (a hung command, a prompt waiting on
//! input) is what "idle" means here, independent of whether the screen redraws
//! identical bytes. The [`vt100`]-backed grid ([`fingerprint::HeadlessGrid`])
//! is retained separately for reattach repaint and smart-notification snippet
//! extraction — it is no longer sampled for idle detection.
//!
//! ## Deviation: force-exit safety net dropped
//! `daemon.ts` arms a 2 s `process.exit(0)` to escape Bun's leaked ConPTY
//! handles. The Rust host blocks on `Pty::wait` and returns cleanly, so there is
//! no leaked-handle event loop to escape; the safety net is intentionally
//! omitted.

pub mod attention;
pub mod control;
pub mod error;
pub mod fingerprint;
pub mod host;
pub mod idle;
pub mod replay;
pub mod snippet;
pub mod socket;
pub mod title_capture;

pub use error::{SessionError, SessionResult};
pub use host::{run_session_host, SessionHostOptions};
pub use idle::{IdleTransition, OutputIdleDetector};
