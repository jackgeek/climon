//! climon PTY/terminal primitives.
//!
//! A synchronous Rust port of the TypeScript client's PTY layer (`src/pty.ts`),
//! absorbing the proof-of-concept modules `rust/climon-rs/src/term.rs` and
//! `rust/climon-rs/src/scrollback.rs` and the PTY-spawn mechanics of
//! `rust/climon-rs/src/host.rs`.
//!
//! This crate is the terminal *primitive* layer: it owns PTY spawn/resize,
//! raw-mode termios handling, terminal-size queries, and a bounded scrollback
//! ring buffer. Cross-platform PTY backends (Unix `openpty`, Windows ConPTY)
//! come from [`portable_pty`]. The socket/viewer/relay protocol and session
//! metadata are intentionally *not* here — those are the session host's job
//! (Phase 7), which consumes this crate's pull-based [`Pty`] API.
//!
//! ## Interop / UX parity with `src/pty.ts`
//! - Default `TERM=xterm-256color` when unset.
//! - On Unix the command is wrapped in `setsid -c` when available, adopting the
//!   PTY as the controlling terminal so job control works; never on Windows.
//! - [`Pty::resize`] clamps to `>= 1`, de-dupes against the last applied size,
//!   and on Unix delivers `SIGWINCH` to the child and every descendant so
//!   nested TUIs re-read the new size.
//!
//! ## SIGWINCH ownership
//! This crate *delivers* `SIGWINCH` to the PTY's descendants on resize, but it
//! does **not** install a process-global `SIGWINCH` *listener*. Listening for
//! the controlling terminal's own resize and calling [`Pty::resize`] is the
//! session host's responsibility.

pub mod command;
pub mod descendants;
pub mod error;
pub mod pty;
pub mod scrollback;
pub mod term;

pub use command::resolve_command;
pub use error::{PtyError, PtyResult};
pub use pty::{prime_headless_conpty, Pty, PtyKiller, PtyOptions, PtyParts, PtyResizer, PtyWaiter};
pub use scrollback::Scrollback;
pub use term::{terminal_size, RawMode};
