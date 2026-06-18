//! climon client install/setup subsystem.
//!
//! A 1:1 Rust port of the TypeScript client's install/setup surface
//! (`src/install/`, `src/setup/`, `src/eula/`, `src/release/version-bump.ts`).
//! The controlling invariant is **install-manifest + on-disk layout + PATH
//! setup + EULA/onboarding parity** with the unchanged Bun installer, so a
//! Rust-built installer produces the same installed result and the
//! non-destructive updater keeps swapping the same files.
//!
//! Modules mirror their TS source files:
//!
//! - [`manifest`]     <- `src/install/install-manifest.ts`
//! - [`files`]        <- `src/install/files.ts` (Windows file placement)
//! - [`files_unix`]   <- `src/install/files-unix.ts` (Unix file placement)
//! - [`path`]         <- `src/install/path.ts` (Windows user-PATH editing)
//! - [`processes`]    <- `src/install/processes.ts`
//! - [`windows`]      <- `src/install/windows.ts` (PowerShell / registry helpers)
//! - [`changelog`]    <- `src/install/changelog.ts`
//! - [`macos`]        <- `src/install/macos.ts`
//! - [`linux`]        <- `src/install/linux.ts`
//! - [`orchestrate`]  <- `src/install/index.ts` (pure orchestration + run_setup_cli)
//! - [`installer`]    <- `src/install/{index,macos-main,linux-main}.ts` + `installer-bundle-entry.ts` (native self-install mains)
//! - [`eula`]         <- `src/eula/text.ts` + `src/eula/accept.ts`
//! - [`install_id`]   <- `src/setup/install-id.ts`
//! - [`onboarding`]   <- `src/setup/onboarding.ts`
//! - [`setup_cmd`]    <- `src/setup/setup-cmd.ts`
//! - [`version_bump`] <- `src/release/version-bump.ts`
//!
//! OS-specific behaviour (PowerShell, FFI broadcasts, `pkill`) is gated with
//! `cfg(target_os = ...)`; the pure helpers compile and are unit-tested on
//! every host via injected platform/env parameters, mirroring how the TS tests
//! pass platform/env in.

pub mod changelog;
pub mod eula;
pub mod files;
pub mod files_unix;
pub mod install_id;
pub mod installer;
pub mod linux;
pub mod macos;
pub mod manifest;
pub mod onboarding;
pub mod orchestrate;
pub mod path;
pub mod processes;
pub mod setup_cmd;
pub mod version_bump;
pub mod windows;

pub use installer::{run_installer, run_installer_main, InstallerIo, PathSetup};
pub use setup_cmd::run_setup_command;
