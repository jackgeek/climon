//! Human-readable session id generation. Ports `session-id.ts`: lowercase
//! hyphen-separated ids (e.g. `rare-geckos-jam`) that re-roll on a metadata-file
//! collision, with no random-suffix fallback.

use crate::error::{StoreError, StoreResult};
use crate::paths::Env;

/// Maximum candidate ids tried before giving up. Mirrors `MAX_ATTEMPTS`.
pub const MAX_ATTEMPTS: usize = 50;

/// Default id generator: `human_id` produces lowercase adjective-noun-verb ids
/// joined by `-` (verified filesystem-safe and matching `^[a-z]+(-[a-z]+){2}$`).
pub fn default_human_id() -> String {
    human_id::id("-", false)
}

/// Generates a unique session id using the default `human_id` generator.
pub fn generate_session_id(env: &Env) -> StoreResult<String> {
    generate_session_id_with(env, default_human_id)
}

/// Generates a session id using a caller-supplied generator. Re-rolls when the
/// candidate already has a metadata file so ids stay unique within this host;
/// errors after `MAX_ATTEMPTS` collisions (no random-suffix fallback by design).
pub fn generate_session_id_with<G>(env: &Env, mut generate: G) -> StoreResult<String>
where
    G: FnMut() -> String,
{
    for _ in 0..MAX_ATTEMPTS {
        let id = generate();
        if !env.session_meta_path(&id).exists() {
            return Ok(id);
        }
    }
    Err(StoreError::Validation(format!(
        "Could not generate a unique session id after {MAX_ATTEMPTS} attempts"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn env_for(tag: &str) -> Env {
        let home = crate::test_support::scratch_dir(tag);
        fs::create_dir_all(home.join("sessions")).unwrap();
        Env::with_home(home)
    }

    #[test]
    fn returns_lowercase_adjective_noun_verb_id() {
        let env = env_for("sid-format");
        let id = generate_session_id(&env).unwrap();
        let parts: Vec<&str> = id.split('-').collect();
        assert_eq!(parts.len(), 3, "expected three segments in {id}");
        for part in parts {
            assert!(!part.is_empty());
            assert!(
                part.chars().all(|c| c.is_ascii_lowercase()),
                "segment {part} not lowercase ascii"
            );
        }
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn rerolls_when_candidate_has_metadata_file() {
        let env = env_for("sid-reroll");
        fs::write(env.session_meta_path("taken-words-here"), "{}").unwrap();

        let candidates = ["taken-words-here", "free-words-here"];
        let mut i = 0;
        let id = generate_session_id_with(&env, || {
            let c = candidates[i];
            i += 1;
            c.to_string()
        })
        .unwrap();

        assert_eq!(id, "free-words-here");
        let _ = fs::remove_dir_all(env.climon_home());
    }

    #[test]
    fn errors_after_max_attempts_of_collisions() {
        let env = env_for("sid-exhaust");
        fs::write(env.session_meta_path("always-taken-id"), "{}").unwrap();
        let err = generate_session_id_with(&env, || "always-taken-id".to_string()).unwrap_err();
        assert!(matches!(err, StoreError::Validation(_)));
        let _ = fs::remove_dir_all(env.climon_home());
    }
}
