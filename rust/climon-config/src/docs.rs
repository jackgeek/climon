//! `docs:config` section generator. 1:1 port of `scripts/generate-config-docs.ts`.

use crate::config_settings::render_config_settings_table;

const START: &str = "<!-- BEGIN GENERATED CONFIG SETTINGS -->";
const END: &str = "<!-- END GENERATED CONFIG SETTINGS -->";

/// Renders the registry-backed `### \`climon config\`` docs section (with trailing newline).
pub fn render_config_docs_section() -> String {
    format!(
        "### `climon config`\n\n\
`climon config` works like `git config`. It reads project-local config first, then ancestor directories, then the global config under `$CLIMON_HOME`.\n\n\
- `climon config remote.tunnelId <id>` — set a value.\n\
- `climon config remote.tunnelId` — print a value (exit 1 if unset).\n\
- `climon config --list` — print all set user-facing values.\n\
- `climon config --debug` — print each candidate config file and the keys and values found in resolution order; sensitive and unknown values are redacted.\n\
- `climon config --unset remote.tunnelId` — remove a value.\n\
- `climon config --help` — print this settings reference in the terminal.\n\
- `--global` writes `$CLIMON_HOME/config.jsonc`; `--local` writes `./.climon/config.jsonc`.\n\n\
climon writes `config.jsonc` so generated comments can explain each setting. Legacy `config.json` files are read for backward compatibility and migrated to `config.jsonc` on first write, leaving `config.json.bak` as a backup.\n\n\
{}\n",
        render_config_settings_table()
    )
}

/// Replaces the content between the START/END markers in `source` with `content`.
///
/// Errors when markers are missing, out of order, or duplicated.
pub fn replace_generated_config_section(source: &str, content: &str) -> Result<String, String> {
    let start = source.find(START);
    let end = source.find(END);

    let (start, end) = match (start, end) {
        (Some(s), Some(e)) if e >= s => (s, e),
        _ => return Err("Missing generated config markers".to_string()),
    };

    if let Some(rel) = source[start + START.len()..].find(START) {
        let second = start + START.len() + rel;
        return Err(format!("Duplicate START marker found at position {second}"));
    }
    if let Some(rel) = source[end + END.len()..].find(END) {
        let second = end + END.len() + rel;
        return Err(format!("Duplicate END marker found at position {second}"));
    }

    Ok(format!(
        "{}\n{}\n{}",
        &source[..start + START.len()],
        content.trim_end(),
        &source[end..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn section_contains_expected_anchors() {
        let section = render_config_docs_section();
        assert!(section.contains("### `climon config`"));
        assert!(section.contains("config.jsonc"));
        assert!(section.contains("config.json.bak"));
        assert!(section.contains(&render_config_settings_table()));
        assert!(section.contains("Legacy `config.json` files are read for backward compatibility"));
    }

    #[test]
    fn replace_swaps_marked_region() {
        let source = format!("intro\n{START}\nold content\n{END}\noutro\n");
        let out = replace_generated_config_section(&source, "new content").unwrap();
        assert_eq!(out, format!("intro\n{START}\nnew content\n{END}\noutro\n"));
    }

    #[test]
    fn replace_is_idempotent() {
        let source = format!("intro\n{START}\nold\n{END}\noutro\n");
        let once = replace_generated_config_section(&source, "body").unwrap();
        let twice = replace_generated_config_section(&once, "body").unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn replace_errors_on_missing_markers() {
        assert!(replace_generated_config_section("no markers", "x").is_err());
    }

    #[test]
    fn replace_errors_on_duplicate_start() {
        let source = format!("{START}\nSome content\n{START}\nMore content\n{END}");
        let err = replace_generated_config_section(&source, "x").unwrap_err();
        assert!(err.to_lowercase().contains("duplicate") && err.contains("START"));
    }

    #[test]
    fn replace_errors_on_duplicate_end() {
        let source = format!("{START}\nSome content\n{END}\nMore content\n{END}");
        let err = replace_generated_config_section(&source, "x").unwrap_err();
        assert!(err.to_lowercase().contains("duplicate") && err.contains("END"));
    }
}
