//! Stable anonymous install id. 1:1 port of `src/setup/install-id.ts`. The id
//! is a random UUIDv4 persisted to the global config on first use.

use climon_config::config::{read_global_config_setting, write_config_setting, Env, WriteScope};
use serde_json::Value;
use std::path::Path;

/// Returns the persisted anonymous install id, or `None` if not yet set.
pub fn get_install_id(env: &Env) -> Option<String> {
    match read_global_config_setting("install.id", env) {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// Returns the anonymous install id, generating and persisting a random UUIDv4
/// to the global config on first call. Idempotent.
pub fn ensure_install_id(env: &Env) -> Result<String, String> {
    if let Some(existing) = get_install_id(env) {
        return Ok(existing);
    }
    let id = random_uuid_v4();
    write_config_setting("install.id", &id, WriteScope::Global, env, Path::new("."))?;
    Ok(id)
}

/// Generates a random RFC-4122 version-4 UUID string.
fn random_uuid_v4() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("getrandom for install id");
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        bytes[0], bytes[1], bytes[2], bytes[3],
        bytes[4], bytes[5], bytes[6], bytes[7],
        bytes[8], bytes[9], bytes[10], bytes[11],
        bytes[12], bytes[13], bytes[14], bytes[15],
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eula::tempdir::TempHome;

    fn temp_env() -> (TempHome, Env) {
        let home = TempHome::new();
        let env = Env::new(Some(home.path_str()), home.path());
        (home, env)
    }

    fn is_uuid(s: &str) -> bool {
        let parts: Vec<&str> = s.split('-').collect();
        parts.len() == 5
            && [8, 4, 4, 4, 12]
                .iter()
                .zip(&parts)
                .all(|(&len, p)| p.len() == len && p.bytes().all(|b| b.is_ascii_hexdigit()))
    }

    #[test]
    fn install_id_is_none_before_setup() {
        let (_h, env) = temp_env();
        assert_eq!(get_install_id(&env), None);
    }

    #[test]
    fn ensure_generates_and_persists_uuid() {
        let (_h, env) = temp_env();
        let id = ensure_install_id(&env).unwrap();
        assert!(is_uuid(&id), "not a uuid: {id}");
        assert_eq!(get_install_id(&env).as_deref(), Some(id.as_str()));
    }

    #[test]
    fn ensure_is_idempotent() {
        let (_h, env) = temp_env();
        let first = ensure_install_id(&env).unwrap();
        let second = ensure_install_id(&env).unwrap();
        assert_eq!(first, second);
    }
}
