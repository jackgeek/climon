//! climon client CLI library.
//!
//! A faithful Rust port of the TypeScript `climon` *client* (`src/index.ts` and
//! its CLI/launcher/attach-client modules). The Bun dashboard server stays
//! unchanged; this crate produces the `climon` binary that interoperates
//! byte-for-byte with it over the shared metadata/socket/config surfaces.
//!
//! Modules mirror their TS source files:
//! - [`args`]        <- `src/cli/args.ts` (+ `parsePriority`/`parseColorMode`)
//! - [`detach_key`]  <- `src/client/detach-key.ts`
//! - [`self_spawn`]  <- `src/self-spawn.ts`
//! - [`process_kill`]<- `src/process-kill.ts`
//! - [`detect_shell`]<- `src/detect-shell.ts`
//! - [`title`]       <- `src/client/title.ts`
//! - [`query_title`] <- `src/client/query-title.ts`
//! - [`client`]      <- `src/client/connect.ts`
//! - [`server_exec`] <- `src/cli/server-exec.ts`
//! - [`config_cmd`]  <- `src/cli/config-cmd.ts`
//! - [`spawn`]       <- `src/spawn-daemon.ts` + `src/client/spawn-session.ts`
//! - [`launcher`]    <- `src/launcher.ts`

pub mod args;
pub mod cleanup_cmd;
pub mod client;
pub mod config_cmd;
pub mod detach_key;
pub mod detect_shell;
pub mod installer;
pub mod launcher;
pub mod link_cmd;
pub mod pathenv;
pub mod process_kill;
pub mod query_title;
pub mod self_spawn;
pub mod server_exec;
pub mod spawn;
pub mod terminal_launch;
pub mod title;
pub mod uplink_spawn;
pub mod version;

/// The embedded third-party license notices, printed by `climon licenses`. The
/// TS help text does not advertise this subcommand, so to keep the help bytes
/// identical it is intentionally absent from [`args::help_text`].
pub const THIRD_PARTY_LICENSES: &str = include_str!("../../THIRD-PARTY-LICENSES.md");
