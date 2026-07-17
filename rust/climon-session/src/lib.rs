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
//! ## Idle fingerprint
//! The idle detector samples a screen *fingerprint* once a second. That
//! fingerprint is **internal** daemon state — never sent over the wire — so it
//! does not require byte-parity with xterm.js. We render PTY output into a
//! [`vt100`]-backed grid ([`fingerprint::HeadlessGrid`]) and emit
//! `{cols}x{rows}\n<trimmed rows>`; idle tests assert *behavior*, not exact
//! bytes.
//!
//! ## Deviation: force-exit safety net dropped
//! `daemon.ts` arms a 2 s `process.exit(0)` to escape Bun's leaked ConPTY
//! handles. The Rust host blocks on `Pty::wait` and returns cleanly, so there is
//! no leaked-handle event loop to escape; the safety net is intentionally
//! omitted.
//!
//! ## `engine` is a crate-private implementation detail
//! The actor engine stub is an internal detail of [`host::run_session_host`]'s
//! engine selection; it is not part of this crate's public API. The following
//! snippet must fail to compile from outside the crate, proving `engine` stays
//! `pub(crate)`:
//!
//! ```compile_fail
//! let _ = climon_session::engine::run_session_host;
//! ```

pub mod attention;
pub mod control;
pub(crate) mod engine;
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
pub use idle::{IdleTransition, ScreenIdleDetector};
