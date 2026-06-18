//! Re-spawn argument construction. Port of `src/self-spawn.ts`.
//!
//! In a compiled binary the spawn target is always `current_exe()`, so the
//! "source entrypoint" branch is effectively dead in production. It is ported
//! faithfully anyway so the logic (and its tests) match the TS client exactly.

/// Builds the arguments for re-spawning the climon executable (e.g. to start a
/// detached `__session` daemon). When `argv1` is a TS/JS source entrypoint
/// (`.../src|dist/index.<ext>`), it is prepended so the runtime runs the right
/// script; otherwise (compiled binary, a virtual `$bunfs` path, or a user
/// command) only `extra` is returned. Mirrors `selfSpawnArgs`.
pub fn self_spawn_args(extra: &[String], argv1: Option<&str>) -> Vec<String> {
    match argv1 {
        Some(a) if is_source_entrypoint(a) => {
            let mut out = Vec::with_capacity(extra.len() + 1);
            out.push(a.to_string());
            out.extend(extra.iter().cloned());
            out
        }
        _ => extra.to_vec(),
    }
}

/// Mirrors the TS `isSourceEntrypoint` regex
/// `(?:^|[/\\])(?:src|dist)[/\\]index\.(?:[cm]?js|tsx?)$`.
fn is_source_entrypoint(argv1: &str) -> bool {
    if argv1.is_empty() || argv1.contains("$bunfs") {
        return false;
    }
    const DIRS: [&str; 2] = ["src", "dist"];
    const SEPS: [char; 2] = ['/', '\\'];
    const EXTS: [&str; 5] = ["js", "cjs", "mjs", "ts", "tsx"];
    for dir in DIRS {
        for sep in SEPS {
            for ext in EXTS {
                let suffix = format!("{dir}{sep}index.{ext}");
                if let Some(prefix) = argv1.strip_suffix(&suffix) {
                    if prefix.is_empty() || prefix.ends_with(['/', '\\']) {
                        return true;
                    }
                }
            }
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(args: &[&str]) -> Vec<String> {
        args.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn source_mode_keeps_script_path() {
        assert_eq!(
            self_spawn_args(&s(&["__session", "id1"]), Some("/repo/src/index.ts")),
            s(&["/repo/src/index.ts", "__session", "id1"])
        );
    }

    #[test]
    fn compiled_mode_bunfs_omits_script_path() {
        assert_eq!(
            self_spawn_args(&s(&["__session", "id1"]), Some("/$bunfs/root/climon")),
            s(&["__session", "id1"])
        );
    }

    #[test]
    fn compiled_mode_omits_user_command() {
        assert_eq!(
            self_spawn_args(&s(&["__session", "id1"]), Some("powershell")),
            s(&["__session", "id1"])
        );
    }

    #[test]
    fn missing_argv1_behaves_like_compiled_mode() {
        assert_eq!(self_spawn_args(&s(&["__uplink"]), None), s(&["__uplink"]));
    }
}
