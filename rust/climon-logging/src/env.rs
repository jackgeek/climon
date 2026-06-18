//! Environment-variable lookup abstraction.
//!
//! Mirrors the `NodeJS.ProcessEnv` parameter threaded through the TypeScript
//! logging functions: real code reads the process environment, while tests pass
//! an explicit set of key/value pairs.

use std::collections::HashMap;

/// A read-only environment-variable source.
#[derive(Clone, Debug, Default)]
pub struct Env {
    vars: HashMap<String, String>,
}

impl Env {
    /// Builds an [`Env`] from the current process environment.
    pub fn from_process() -> Self {
        Self {
            vars: std::env::vars().collect(),
        }
    }

    /// Builds an [`Env`] from explicit key/value pairs (testing).
    pub fn from_pairs<I, K, V>(pairs: I) -> Self
    where
        I: IntoIterator<Item = (K, V)>,
        K: Into<String>,
        V: Into<String>,
    {
        Self {
            vars: pairs
                .into_iter()
                .map(|(k, v)| (k.into(), v.into()))
                .collect(),
        }
    }

    /// Returns the value for `key`, if present.
    pub fn get(&self, key: &str) -> Option<&str> {
        self.vars.get(key).map(String::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_pairs_round_trips_a_key() {
        let env = Env::from_pairs([("CLIMON_HOME", "/tmp/x"), ("NODE_ENV", "test")]);
        assert_eq!(env.get("CLIMON_HOME"), Some("/tmp/x"));
        assert_eq!(env.get("NODE_ENV"), Some("test"));
    }

    #[test]
    fn get_returns_none_for_absent_key() {
        let env = Env::from_pairs::<[(String, String); 0], _, _>([]);
        assert_eq!(env.get("MISSING"), None);
    }
}
