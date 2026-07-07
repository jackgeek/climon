//! Client-id resolution for the devbox uplink. 1:1 port of
//! `src/remote/client-id.ts`.
//!
//! The wire value (`resolve_client_id`) is the configured `remote.clientId` or
//! the sanitised machine hostname — identical to `climon-cli`'s `resolve_client_id`
//! for every real input. Only the junk-only fallback differs (a random
//! `dev-<hex>` id), and such a value never appears on the wire in practice.

use std::path::Path;

use climon_config::config::{resolve_config_setting, Env as ConfigEnv};
use climon_store::paths::hostname;

/// Coerces an arbitrary string into a valid clientId: letters, digits, dots,
/// hyphens, underscores; 1-64 chars; no leading/trailing hyphens. Falls back to
/// a random `dev-<hex>` id when nothing valid remains. Mirrors `sanitizeClientId`.
pub fn sanitize_client_id(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = replaced.trim_matches('-');
    let cleaned: String = trimmed.chars().take(64).collect();
    if cleaned.is_empty() {
        let mut bytes = [0u8; 5];
        getrandom::fill(&mut bytes).expect("getrandom");
        let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
        format!("dev-{hex}")
    } else {
        cleaned
    }
}

/// The per-host default clientId: the sanitised machine hostname. Mirrors
/// `defaultClientId`.
pub fn default_client_id() -> String {
    sanitize_client_id(&hostname())
}

/// Resolves this machine's clientId: the configured `remote.clientId` if set,
/// otherwise the sanitised hostname. Does not persist anything. Mirrors
/// `resolveClientId`.
pub fn resolve_client_id(env: &ConfigEnv, cwd: &Path) -> String {
    if let Some(serde_json::Value::String(s)) = resolve_config_setting("remote.clientId", env, cwd)
    {
        if !s.is_empty() {
            return s;
        }
    }
    default_client_id()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_a_valid_hostname_unchanged() {
        assert_eq!(sanitize_client_id("my-devbox"), "my-devbox");
    }

    #[test]
    fn replaces_disallowed_characters_with_hyphens_and_trims() {
        assert_eq!(sanitize_client_id("My Box!!"), "My-Box");
    }

    #[test]
    fn truncates_to_64_characters() {
        assert_eq!(sanitize_client_id(&"a".repeat(100)).len(), 64);
    }

    #[test]
    fn falls_back_to_a_dev_id_when_nothing_valid_remains() {
        let id = sanitize_client_id("!!!");
        assert!(id.starts_with("dev-"));
        let hex = &id["dev-".len()..];
        assert_eq!(hex.len(), 10);
        assert!(hex.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn defaults_to_the_sanitised_hostname_when_unconfigured() {
        let dir = std::env::temp_dir().join(format!("climon-clientid-{}", std::process::id()));
        let env = ConfigEnv::new(Some(dir.to_str().unwrap()), dir.clone());
        assert_eq!(
            resolve_client_id(&env, &dir),
            sanitize_client_id(&hostname())
        );
    }
}
