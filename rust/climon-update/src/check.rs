//! Background update check. Port of `src/update/check.ts`.

use climon_config::config::Env;

use crate::manifest::{compare_semver, current_artifact_key, fetch_manifest, Manifest};
use crate::state::{clear_available_version, record_check, set_available_version};

/// The manifest URL the background check polls.
pub const DEFAULT_MANIFEST_URL: &str =
    "https://github.com/jackgeek/climon/releases/latest/download/manifest.json";

/// Fetches the manifest and caches the available version if newer. Records the
/// check time and never errors (offline-safe), so it is safe to fire-and-forget.
///
/// `fetch` is injectable for tests; production callers pass
/// [`fetch_manifest`] via [`run_background_check_default`].
pub fn run_background_check<F>(env: &Env, current_version: &str, url: &str, fetch: F)
where
    F: Fn(&str) -> Result<Manifest, String>,
{
    match fetch(url) {
        Ok(manifest) => {
            // Only cache a version we could actually install on this platform.
            let has_artifact = manifest.artifacts.contains_key(&current_artifact_key());
            if has_artifact && compare_semver(&manifest.version, current_version) > 0 {
                set_available_version(&manifest.version, env);
            } else {
                clear_available_version(env);
            }
        }
        Err(_) => {
            // Offline or transient failure: leave state untouched and move on.
        }
    }
    record_check(env);
}

/// Convenience wrapper that fetches the real manifest from [`DEFAULT_MANIFEST_URL`].
pub fn run_background_check_default(env: &Env, current_version: &str) {
    run_background_check(env, current_version, DEFAULT_MANIFEST_URL, fetch_manifest);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::ManifestArtifact;
    use crate::state::get_available_version;
    use std::collections::BTreeMap;

    fn temp_env() -> (tempfile::TempDir, Env) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_string_lossy().into_owned();
        let env = Env::new(Some(&home), dir.path());
        (dir, env)
    }

    fn manifest(version: &str, artifact_key: &str) -> Manifest {
        let mut artifacts = BTreeMap::new();
        artifacts.insert(
            artifact_key.to_string(),
            ManifestArtifact {
                url: "u".to_string(),
                sig: "s".to_string(),
            },
        );
        Manifest {
            version: version.to_string(),
            encryption: None,
            artifacts,
        }
    }

    #[test]
    fn caches_a_newer_version_and_records_the_check_time() {
        let (_d, env) = temp_env();
        let m = manifest("0.99.0", &current_artifact_key());
        run_background_check(&env, "0.12.1", DEFAULT_MANIFEST_URL, |_| Ok(m.clone()));
        assert_eq!(get_available_version(&env).as_deref(), Some("0.99.0"));
    }

    #[test]
    fn does_not_cache_with_no_artifact_for_this_platform() {
        let (_d, env) = temp_env();
        let m = manifest("0.99.0", "some-other-plat");
        run_background_check(&env, "0.12.1", DEFAULT_MANIFEST_URL, |_| Ok(m.clone()));
        assert_eq!(get_available_version(&env), None);
    }

    #[test]
    fn clears_a_stale_cache_when_newer_version_has_no_artifact_here() {
        let (_d, env) = temp_env();
        set_available_version("0.50.0", &env);
        let m = manifest("0.99.0", "some-other-plat");
        run_background_check(&env, "0.12.1", DEFAULT_MANIFEST_URL, |_| Ok(m.clone()));
        assert_eq!(get_available_version(&env), None);
    }

    #[test]
    fn clears_the_cached_version_when_not_newer() {
        let (_d, env) = temp_env();
        let m = Manifest {
            version: "0.12.1".to_string(),
            encryption: None,
            artifacts: BTreeMap::new(),
        };
        run_background_check(&env, "0.12.1", DEFAULT_MANIFEST_URL, |_| Ok(m.clone()));
        assert_eq!(get_available_version(&env), None);
    }

    #[test]
    fn swallows_fetch_errors_offline_safe() {
        let (_d, env) = temp_env();
        run_background_check(&env, "0.12.1", DEFAULT_MANIFEST_URL, |_| {
            Err("offline".to_string())
        });
        assert_eq!(get_available_version(&env), None);
    }

    #[test]
    fn default_manifest_url_points_at_the_releases_repo() {
        assert!(DEFAULT_MANIFEST_URL.contains("jackgeek/climon/"));
        assert!(DEFAULT_MANIFEST_URL.ends_with("manifest.json"));
    }
}
