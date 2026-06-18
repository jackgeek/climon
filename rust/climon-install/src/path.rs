//! Windows user-PATH entry editing. 1:1 port of `src/install/path.ts`.
//!
//! Pure string helpers (PATH is `;`-separated on Windows) used to add the
//! install directory to the front of the user's PATH idempotently and
//! case-insensitively, expanding `%VAR%` references before comparing.

/// Expands `%VAR%`-style Windows environment references in `value`.
pub trait ExpandEnvironmentString {
    fn expand(&self, value: &str) -> String;
}

impl<F: Fn(&str) -> String> ExpandEnvironmentString for F {
    fn expand(&self, value: &str) -> String {
        self(value)
    }
}

fn strip_wrapping_quotes(value: &str) -> &str {
    if value.len() >= 2 && value.starts_with('"') && value.ends_with('"') {
        &value[1..value.len() - 1]
    } else {
        value
    }
}

fn strip_trailing_slashes(value: &str) -> &str {
    value.trim_end_matches(['\\', '/'])
}

/// Normalizes a PATH entry for comparison: trim, expand env refs, strip
/// wrapping quotes and trailing slashes, then lowercase.
pub fn normalize_path_entry(value: &str, expand: &impl ExpandEnvironmentString) -> String {
    let expanded = expand.expand(value.trim());
    strip_trailing_slashes(strip_wrapping_quotes(&expanded)).to_lowercase()
}

/// Whether `current_path` already contains `entry` (case-insensitively, after
/// expansion).
pub fn path_contains_entry(
    current_path: &str,
    entry: &str,
    expand: &impl ExpandEnvironmentString,
) -> bool {
    let normalized_entry = normalize_path_entry(entry, expand);
    current_path
        .split(';')
        .filter(|part| !part.trim().is_empty())
        .any(|part| normalize_path_entry(part, expand) == normalized_entry)
}

/// Returns a PATH with `entry` first and any equivalent entries removed.
pub fn ensure_path_entry_first(
    current_path: &str,
    entry: &str,
    expand: &impl ExpandEnvironmentString,
) -> String {
    let normalized_entry = normalize_path_entry(entry, expand);
    let mut parts: Vec<&str> = vec![entry];
    for part in current_path.split(';') {
        let trimmed = part.trim();
        if trimmed.is_empty() {
            continue;
        }
        if normalize_path_entry(trimmed, expand) == normalized_entry {
            continue;
        }
        parts.push(trimmed);
    }
    parts.join(";")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn expand(value: &str) -> String {
        // Case-insensitive replacement of %LOCALAPPDATA%, mirroring the TS test.
        let mut out = String::with_capacity(value.len());
        let lower = value.to_lowercase();
        let needle = "%localappdata%";
        let mut i = 0;
        while i < value.len() {
            if lower[i..].starts_with(needle) {
                out.push_str("C:\\Users\\Ada\\AppData\\Local");
                i += needle.len();
            } else {
                let ch = value[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
        out
    }

    #[test]
    fn normalize_trims_whitespace_quotes_and_trailing_slashes() {
        assert_eq!(
            normalize_path_entry(
                "  \"C:\\Users\\Ada\\AppData\\Local\\Programs\\climon\\\\\"  ",
                &expand
            ),
            "c:\\users\\ada\\appdata\\local\\programs\\climon"
        );
    }

    #[test]
    fn normalize_expands_env_refs_before_comparing() {
        assert_eq!(
            normalize_path_entry("%LOCALAPPDATA%\\Programs\\climon", &expand),
            "c:\\users\\ada\\appdata\\local\\programs\\climon"
        );
    }

    #[test]
    fn contains_matches_case_insensitively() {
        let current = "C:\\Windows\\System32;C:\\USERS\\ADA\\APPDATA\\LOCAL\\PROGRAMS\\CLIMON";
        assert!(path_contains_entry(
            current,
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
            &expand
        ));
    }

    #[test]
    fn contains_matches_localappdata() {
        let current = "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon";
        assert!(path_contains_entry(
            current,
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
            &expand
        ));
    }

    #[test]
    fn ensure_returns_original_when_already_first() {
        let current = "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon";
        assert_eq!(
            ensure_path_entry_first(current, "C:\\Windows\\System32", &expand),
            current
        );
    }

    #[test]
    fn ensure_prepends_when_missing() {
        assert_eq!(
            ensure_path_entry_first(
                "C:\\Windows\\System32",
                "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
                &expand
            ),
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Windows\\System32"
        );
    }

    #[test]
    fn ensure_moves_existing_before_earlier_entries() {
        assert_eq!(
            ensure_path_entry_first(
                "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon",
                "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
                &expand
            ),
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Windows\\System32"
        );
    }

    #[test]
    fn ensure_moves_before_conflicting_local_bin() {
        assert_eq!(
            ensure_path_entry_first(
                "C:\\Users\\Ada\\.local\\bin;C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
                "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
                &expand
            ),
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Users\\Ada\\.local\\bin"
        );
    }

    #[test]
    fn ensure_removes_duplicate_equivalent_paths() {
        assert_eq!(
            ensure_path_entry_first(
                "C:\\Windows\\System32;%LOCALAPPDATA%\\Programs\\climon;C:\\USERS\\ADA\\APPDATA\\LOCAL\\PROGRAMS\\CLIMON",
                "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
                &expand
            ),
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon;C:\\Windows\\System32"
        );
    }

    #[test]
    fn ensure_returns_only_install_path_when_current_empty() {
        assert_eq!(
            ensure_path_entry_first(
                "",
                "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon",
                &expand
            ),
            "C:\\Users\\Ada\\AppData\\Local\\Programs\\climon"
        );
    }
}
