//! JSONC parse + comment-(re)generating render. 1:1 port of `src/config-jsonc.ts`.

use crate::config_settings::config_settings;
use serde_json::{Map, Value};

/// Parses a JSONC string (stripping comments) into an object, or an error message
/// that includes `path`. Mirrors `parseJsoncConfig`.
pub fn parse_jsonc_config(raw: &str, path: &str) -> Result<Value, String> {
    let result = (|| -> Result<Value, String> {
        let stripped = strip_comments(raw, path)?;
        let parsed: Value = serde_json::from_str(&stripped).map_err(|e| e.to_string())?;
        if !parsed.is_object() {
            return Err(format!("Invalid JSONC in {path}: root must be an object"));
        }
        Ok(parsed)
    })();
    result.map_err(|msg| {
        if msg.contains("Invalid JSONC in") {
            msg
        } else {
            format!("Invalid JSONC in {path}: {msg}")
        }
    })
}

/// Strips JSONC line and block comments while preserving string contents.
fn strip_comments(raw: &str, path: &str) -> Result<String, String> {
    let chars: Vec<char> = raw.chars().collect();
    let mut result = String::new();
    let mut i = 0;
    let mut in_string = false;

    while i < chars.len() {
        let ch = chars[i];
        let next = if i + 1 < chars.len() {
            chars[i + 1]
        } else {
            '\0'
        };

        if in_string {
            result.push(ch);
            if ch == '\\' {
                if i + 1 < chars.len() {
                    result.push(next);
                    i += 2;
                    continue;
                }
            } else if ch == '"' {
                in_string = false;
            }
            i += 1;
            continue;
        }

        if ch == '"' {
            in_string = true;
            result.push(ch);
            i += 1;
            continue;
        }

        if ch == '/' && next == '/' {
            i += 2;
            while i < chars.len() && chars[i] != '\n' && chars[i] != '\r' {
                i += 1;
            }
            continue;
        }

        if ch == '/' && next == '*' {
            i += 2;
            let mut found_end = false;
            while i < chars.len().saturating_sub(1) {
                if chars[i] == '*' && chars[i + 1] == '/' {
                    i += 2;
                    found_end = true;
                    break;
                }
                i += 1;
            }
            if !found_end {
                return Err(format!("Unterminated block comment in {path}"));
            }
            continue;
        }

        result.push(ch);
        i += 1;
    }

    Ok(result)
}

/// Renders a config object as formatted JSONC with comments above known settings.
/// Returns a string with a trailing newline. Mirrors `renderJsoncConfig`.
pub fn render_jsonc_config(config: &Value) -> String {
    let settings = config_settings();
    let setting_map: Vec<(String, String)> = settings
        .iter()
        .map(|s| (s.path.clone(), s.purpose.clone()))
        .collect();
    let registry_order: Vec<String> = settings.iter().map(|s| s.path.clone()).collect();

    let obj = config.as_object().cloned().unwrap_or_default();
    let rendered = render_object(&obj, "", &setting_map, &registry_order, 0);
    format!("{rendered}\n")
}

fn setting_purpose<'a>(setting_map: &'a [(String, String)], path: &str) -> Option<&'a str> {
    setting_map
        .iter()
        .find(|(p, _)| p == path)
        .map(|(_, purpose)| purpose.as_str())
}

fn setting_has(setting_map: &[(String, String)], path: &str) -> bool {
    setting_map.iter().any(|(p, _)| p == path)
}

fn render_object(
    obj: &Map<String, Value>,
    prefix: &str,
    setting_map: &[(String, String)],
    registry_order: &[String],
    base_indent: usize,
) -> String {
    let indent_str = "  ".repeat(base_indent);
    let child_indent_str = "  ".repeat(base_indent + 1);

    let mut lines: Vec<String> = vec!["{".to_string()];

    let mut known_keys: Vec<String> = Vec::new();
    let mut unknown_keys: Vec<String> = Vec::new();
    for key in obj.keys() {
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        let is_known =
            setting_has(setting_map, &path) || has_known_descendant(&obj[key], &path, setting_map);
        if is_known {
            known_keys.push(key.clone());
        } else {
            unknown_keys.push(key.clone());
        }
    }

    known_keys.sort_by_key(|k| {
        let path = if prefix.is_empty() {
            k.clone()
        } else {
            format!("{prefix}.{k}")
        };
        find_earliest_registry_index(&path, registry_order)
    });
    unknown_keys.sort();

    let sorted_keys: Vec<String> = known_keys.into_iter().chain(unknown_keys).collect();

    for (i, key) in sorted_keys.iter().enumerate() {
        let value = &obj[key];
        let path = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        let is_last = i == sorted_keys.len() - 1;

        if let Some(purpose) = setting_purpose(setting_map, &path) {
            lines.push(format!("{child_indent_str}// {purpose}"));
        }

        match value {
            Value::Object(nested) => {
                if nested.is_empty() {
                    lines.push(format!(
                        "{child_indent_str}\"{key}\": {{}}{}",
                        if is_last { "" } else { "," }
                    ));
                } else {
                    let nested_obj =
                        render_object(nested, &path, setting_map, registry_order, base_indent + 1);
                    let nested_lines: Vec<&str> = nested_obj.split('\n').collect();
                    lines.push(format!("{child_indent_str}\"{key}\": {}", nested_lines[0]));
                    for line in &nested_lines[1..nested_lines.len() - 1] {
                        lines.push((*line).to_string());
                    }
                    lines.push(format!(
                        "{}{}",
                        nested_lines[nested_lines.len() - 1],
                        if is_last { "" } else { "," }
                    ));
                }
            }
            _ => {
                let rendered_value = render_leaf_value(value);
                lines.push(format!(
                    "{child_indent_str}\"{key}\": {rendered_value}{}",
                    if is_last { "" } else { "," }
                ));
            }
        }
    }

    lines.push(format!("{indent_str}}}"));
    lines.join("\n")
}

/// Serializes a JSON leaf value the way `JSON.stringify` would. serde_json renders
/// an integer-valued `f64` (e.g. a hand-edited `3131.0`) as `3131.0`, whereas JS
/// normalizes it to `3131`; this collapses such values to integer form so writes
/// stay byte-identical to the Bun renderer. Genuine fractional floats are unchanged.
fn render_leaf_value(value: &Value) -> String {
    if let Value::Number(n) = value {
        if let Some(f) = n.as_f64() {
            if n.as_i64().is_none() && n.as_u64().is_none() && f.fract() == 0.0 && f.is_finite() {
                if f >= i64::MIN as f64 && f <= i64::MAX as f64 {
                    return (f as i64).to_string();
                }
                if f >= 0.0 && f <= u64::MAX as f64 {
                    return (f as u64).to_string();
                }
            }
        }
    }
    serde_json::to_string(value).unwrap()
}

fn has_known_descendant(value: &Value, prefix: &str, setting_map: &[(String, String)]) -> bool {
    let obj = match value {
        Value::Object(m) => m,
        _ => return false,
    };
    for key in obj.keys() {
        let path = format!("{prefix}.{key}");
        if setting_has(setting_map, &path) {
            return true;
        }
        if has_known_descendant(&obj[key], &path, setting_map) {
            return true;
        }
    }
    false
}

fn find_earliest_registry_index(path: &str, registry_order: &[String]) -> usize {
    if let Some(idx) = registry_order.iter().position(|p| p == path) {
        return idx;
    }
    let needle = format!("{path}.");
    let mut earliest: Option<usize> = None;
    for (i, reg_path) in registry_order.iter().enumerate() {
        if reg_path.starts_with(&needle) {
            earliest = Some(earliest.map_or(i, |e| e.min(i)));
        }
    }
    earliest.unwrap_or(registry_order.len())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_line_and_block_comments() {
        let parsed = parse_jsonc_config(
            "{\n  // Dashboard host.\n  \"server\": {\n    \"host\": \"127.0.0.1\",\n    /* Dashboard port. */\n    \"port\": 3131\n  }\n}",
            "/test/config.jsonc",
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({ "server": { "host": "127.0.0.1", "port": 3131 } })
        );
    }

    #[test]
    fn reports_path_on_bad_json() {
        let err = parse_jsonc_config("{", "/test/bad.config.jsonc").unwrap_err();
        assert!(err.contains("Invalid JSONC in /test/bad.config.jsonc"));
    }

    #[test]
    fn preserves_comment_like_text_in_strings() {
        let parsed = parse_jsonc_config(
            "{\n  \"url\": \"http://example.com/path\",\n  \"lineComment\": \"// not a comment\",\n  \"blockComment\": \"/* not a comment */\",\n  \"escapedQuote\": \"quote: \\\" // still text\"\n}",
            "/test/strings.jsonc",
        )
        .unwrap();
        assert_eq!(
            parsed,
            json!({
                "url": "http://example.com/path",
                "lineComment": "// not a comment",
                "blockComment": "/* not a comment */",
                "escapedQuote": "quote: \" // still text"
            })
        );
    }

    #[test]
    fn rejects_non_object_roots() {
        for raw in ["[]", "\"value\"", "1", "null"] {
            let err = parse_jsonc_config(raw, "/test/bad-root.config.jsonc").unwrap_err();
            assert!(err.contains("Invalid JSONC in"), "got: {err}");
        }
    }

    #[test]
    fn reports_unterminated_block_comment_with_path() {
        let err = parse_jsonc_config("{\"a\": 1 /* unterminated", "/x/bad-comment.config.jsonc")
            .unwrap_err();
        assert!(err.contains("Unterminated block comment"));
        assert!(err.contains("/x/bad-comment.config.jsonc"));
    }

    #[test]
    fn renders_comments_above_known_settings() {
        let rendered = render_jsonc_config(&json!({
            "version": 1,
            "session": { "color": "auto" },
            "remote": { "tunnelId": "abc123" }
        }));
        assert!(rendered.contains("// Schema version for the persisted config.json format. Always 1 for the current release."));
        assert!(rendered.contains("\"version\": 1"));
        assert!(rendered.contains("// Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment."));
        assert!(rendered.contains("\"color\": \"auto\""));
        assert!(rendered.contains("// Dev tunnel id"));
        assert!(rendered.contains("\"tunnelId\": \"abc123\""));
        assert!(rendered.ends_with('\n'));
    }

    #[test]
    fn preserves_unknown_keys_without_comments() {
        let rendered = render_jsonc_config(&json!({ "custom": { "value": true } }));
        assert!(rendered.contains("\"custom\""));
        assert!(rendered.contains("\"value\": true"));
        assert!(!rendered.contains("// custom"));
    }

    #[test]
    fn renders_known_then_unknown_alphabetical() {
        let rendered = render_jsonc_config(&json!({
            "zzz": true,
            "session": { "color": "auto" },
            "server": { "port": 3131 },
            "aaa": true,
            "version": 1
        }));
        let keys: Vec<String> = rendered
            .lines()
            .filter_map(|line| {
                let trimmed = line.strip_prefix("  ")?;
                if trimmed.starts_with(' ') {
                    return None;
                }
                let name = trimmed.strip_prefix('"')?;
                let end = name.find('"')?;
                if name[end..].starts_with("\":") {
                    Some(name[..end].to_string())
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(keys, vec!["version", "server", "session", "aaa", "zzz"]);
    }

    #[test]
    fn parent_container_keys_get_no_comment() {
        let rendered = render_jsonc_config(&json!({ "server": { "host": "127.0.0.1" } }));
        let lines: Vec<&str> = rendered.lines().collect();
        let idx = lines
            .iter()
            .position(|l| l.contains("\"server\":"))
            .unwrap();
        assert!(!lines[idx - 1].trim_start().starts_with("//"));
        assert!(rendered.contains("// IP address the dashboard server binds to"));
        assert!(rendered.contains("\"host\": \"127.0.0.1\""));
    }

    #[test]
    fn renders_empty_nested_objects() {
        let rendered = render_jsonc_config(&json!({ "server": {}, "custom": {} }));
        assert!(rendered.contains("\"server\": {}"));
        assert!(rendered.contains("\"custom\": {}"));
        assert!(rendered.ends_with('\n'));
    }

    #[test]
    fn normalizes_float_formatted_integers_like_json_stringify() {
        // JS `JSON.stringify(3131.0)` emits `3131`, not `3131.0`. A hand-edited
        // config carrying a float-formatted integer must round-trip byte-identical
        // to the Bun renderer.
        let rendered = render_jsonc_config(&json!({ "server": { "port": 3131.0 } }));
        assert!(rendered.contains("\"port\": 3131"), "got: {rendered}");
        assert!(!rendered.contains("3131.0"), "got: {rendered}");
        // Genuine non-integer floats keep their fractional form.
        let frac = render_jsonc_config(&json!({ "custom": { "ratio": 1.5 } }));
        assert!(frac.contains("\"ratio\": 1.5"), "got: {frac}");
    }

    #[test]
    fn round_trips_and_omits_absent_sections() {
        // Rust has no `undefined`; the TS "omit undefined" case maps to an absent key.
        let rendered = render_jsonc_config(&json!({ "version": 1 }));
        assert!(!rendered.contains("undefined"));
        assert!(!rendered.contains("\"remote\""));
        let parsed = parse_jsonc_config(&rendered, "/test/round-trip.jsonc").unwrap();
        assert_eq!(parsed["version"], json!(1));
        assert!(!parsed.as_object().unwrap().contains_key("remote"));
    }
}
