//! Install orchestration helpers. Port of the pure, testable parts of
//! `src/install/index.ts` (Windows user-PATH update + the `runSetupCli`
//! pause-before-exit wrapper).
//!
//! The platform installer `main()` entrypoints (`index.ts` / `macos-main.ts` /
//! `linux-main.ts`) drive a real self-install from the installer bundle binary,
//! which only exists once the Phase-12 release/compile pipeline produces it.
//! Those entrypoints are therefore deferred to Phase 12; the reusable building
//! blocks they compose (manifest, file placement, PATH editing, onboarding,
//! changelog) are all ported and tested here so Phase 12 only needs to wire
//! them into a binary.

use crate::path::ensure_path_entry_first;

/// Injectable Windows user-PATH I/O, mirroring the TS `UserPathIO`.
pub struct UserPathIo<'a> {
    pub read_user_path: &'a mut dyn FnMut() -> String,
    pub write_user_path: &'a mut dyn FnMut(&str),
    pub broadcast_environment_change: &'a mut dyn FnMut(),
    pub expand_environment_string: &'a dyn Fn(&str) -> String,
}

/// Ensures `install_dir` is first on the user's PATH, writing + broadcasting the
/// change only when it actually differs. Returns whether PATH was changed.
pub fn update_user_path_with_io(install_dir: &str, io: UserPathIo<'_>) -> bool {
    let UserPathIo {
        read_user_path,
        write_user_path,
        broadcast_environment_change,
        expand_environment_string,
    } = io;

    let current_path = read_user_path();
    let expand = |s: &str| expand_environment_string(s);
    let next_path = ensure_path_entry_first(&current_path, install_dir, &expand);

    if next_path == current_path {
        return false;
    }

    write_user_path(&next_path);
    broadcast_environment_change();
    true
}

/// Injectable runtime for [`run_setup_cli`], mirroring the TS `SetupCliRuntime`.
pub struct SetupCliRuntime<'a> {
    pub main: &'a mut dyn FnMut() -> Result<(), String>,
    pub write_error: &'a mut dyn FnMut(&str),
    pub pause_for_exit: &'a mut dyn FnMut(),
    pub exit: &'a mut dyn FnMut(i32),
}

/// Runs the installer `main`, then always pauses before exit so double-click
/// users can read the output, exiting non-zero on failure. 1:1 port of
/// `runSetupCli` in `src/install/index.ts`.
pub fn run_setup_cli(runtime: SetupCliRuntime<'_>) {
    let SetupCliRuntime {
        main,
        write_error,
        pause_for_exit,
        exit,
    } = runtime;

    let mut exit_code: Option<i32> = None;
    if let Err(err) = main() {
        write_error(&format!("Setup failed: {err}"));
        exit_code = Some(1);
    }

    pause_for_exit();
    if let Some(code) = exit_code {
        exit(code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn expand(value: &str) -> String {
        value.replace("%LOCALAPPDATA%", "C:\\Users\\Ada\\AppData\\Local")
    }

    #[test]
    fn rewrites_path_when_climon_after_conflicting_entry() {
        let written = RefCell::new(String::new());
        let broadcast = RefCell::new(0);
        let mut read = || {
            "C:\\Users\\Ada\\.local\\bin;C:\\Users\\Ada\\AppData\\Local\\Programs\\climon"
                .to_string()
        };
        let mut write = |value: &str| *written.borrow_mut() = value.to_string();
        let mut bcast = || *broadcast.borrow_mut() += 1;

        let changed = update_user_path_with_io(
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
            UserPathIo {
                read_user_path: &mut read,
                write_user_path: &mut write,
                broadcast_environment_change: &mut bcast,
                expand_environment_string: &expand,
            },
        );

        assert!(changed);
        assert_eq!(
            *written.borrow(),
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Users\\Ada\\.local\\bin"
        );
        assert_eq!(*broadcast.borrow(), 1);
    }

    #[test]
    fn pauses_before_exit_after_success() {
        let events = RefCell::new(Vec::<String>::new());
        let mut main = || {
            events.borrow_mut().push("main".to_string());
            Ok(())
        };
        let mut write_error = |m: &str| events.borrow_mut().push(format!("error:{m}"));
        let mut pause = || events.borrow_mut().push("pause".to_string());
        let mut exit = |c: i32| events.borrow_mut().push(format!("exit:{c}"));

        run_setup_cli(SetupCliRuntime {
            main: &mut main,
            write_error: &mut write_error,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        });

        assert_eq!(
            *events.borrow(),
            vec!["main".to_string(), "pause".to_string()]
        );
    }

    #[test]
    fn pauses_before_exit_after_failure() {
        let events = RefCell::new(Vec::<String>::new());
        let mut main = || Err("copy failed".to_string());
        let mut write_error = |m: &str| events.borrow_mut().push(format!("error:{m}"));
        let mut pause = || events.borrow_mut().push("pause".to_string());
        let mut exit = |c: i32| events.borrow_mut().push(format!("exit:{c}"));

        run_setup_cli(SetupCliRuntime {
            main: &mut main,
            write_error: &mut write_error,
            pause_for_exit: &mut pause,
            exit: &mut exit,
        });

        assert_eq!(
            *events.borrow(),
            vec![
                "error:Setup failed: copy failed".to_string(),
                "pause".to_string(),
                "exit:1".to_string(),
            ]
        );
    }
}
