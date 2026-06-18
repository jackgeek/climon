//! Descendant-PID discovery for delivering `SIGWINCH` to nested TUIs on resize.
//!
//! When the PTY runs a shell, the actual foreground program is often a
//! *grandchild* in a different process group, so a kernel-delivered `SIGWINCH`
//! (or one sent to the direct child) never reaches it. To match `src/pty.ts`,
//! a resize signals the direct child *and every descendant* so nested programs
//! re-read the new size. This module finds those descendants.

/// Parses the output of `ps -A -o pid= -o ppid=` and returns every descendant
/// PID of `root` (children, grandchildren, ...). `root` itself is excluded.
///
/// Tolerates blank and malformed lines and is cycle-safe. This is the pure core
/// of `descendantPids` in `src/pty.ts` and is unit-tested with synthetic input.
pub fn descendant_pids_from_ps(ps_output: &str, root: u32) -> Vec<u32> {
    use std::collections::{HashMap, HashSet};

    let mut children_by_parent: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in ps_output.lines() {
        let mut fields = line.split_whitespace();
        let (Some(pid), Some(ppid)) = (fields.next(), fields.next()) else {
            continue;
        };
        let (Ok(pid), Ok(ppid)) = (pid.parse::<u32>(), ppid.parse::<u32>()) else {
            continue;
        };
        children_by_parent.entry(ppid).or_default().push(pid);
    }

    let mut descendants = Vec::new();
    let mut stack = vec![root];
    let mut seen = HashSet::new();
    seen.insert(root);
    while let Some(current) = stack.pop() {
        if let Some(children) = children_by_parent.get(&current) {
            for &child in children {
                if seen.insert(child) {
                    descendants.push(child);
                    stack.push(child);
                }
            }
        }
    }
    descendants
}

/// Returns the descendant PIDs of `root` by shelling out to `ps`. Returns an
/// empty vector on failure or on Windows (no `ps` / no `SIGWINCH`).
#[cfg(unix)]
pub fn descendant_pids(root: u32) -> Vec<u32> {
    let output = std::process::Command::new("ps")
        .args(["-A", "-o", "pid=", "-o", "ppid="])
        .output();
    match output {
        Ok(out) if out.status.success() => {
            descendant_pids_from_ps(&String::from_utf8_lossy(&out.stdout), root)
        }
        _ => Vec::new(),
    }
}

#[cfg(not(unix))]
pub fn descendant_pids(_root: u32) -> Vec<u32> {
    Vec::new()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collects_children_and_grandchildren() {
        // 100 -> 200 -> 300, plus a sibling 201 of 200.
        let ps = "\
            100 1\n\
            200 100\n\
            201 100\n\
            300 200\n";
        let mut got = descendant_pids_from_ps(ps, 100);
        got.sort_unstable();
        assert_eq!(got, vec![200, 201, 300]);
    }

    #[test]
    fn excludes_unrelated_trees() {
        let ps = "\
            100 1\n\
            200 100\n\
            900 1\n\
            901 900\n";
        let mut got = descendant_pids_from_ps(ps, 100);
        got.sort_unstable();
        assert_eq!(got, vec![200]);
    }

    #[test]
    fn root_with_no_children_is_empty() {
        let ps = "100 1\n200 1\n";
        assert!(descendant_pids_from_ps(ps, 100).is_empty());
    }

    #[test]
    fn tolerates_blank_and_malformed_lines() {
        let ps = "\
            \n\
            pid ppid\n\
            100 1\n\
            garbage line here\n\
            200 100\n\
            \t300   200  \n";
        let mut got = descendant_pids_from_ps(ps, 100);
        got.sort_unstable();
        assert_eq!(got, vec![200, 300]);
    }

    #[test]
    fn cycle_is_safe() {
        // Pathological self/loop references must not hang or double-count.
        let ps = "\
            100 100\n\
            200 100\n\
            100 200\n";
        let got = descendant_pids_from_ps(ps, 100);
        assert_eq!(got, vec![200]);
    }
}
