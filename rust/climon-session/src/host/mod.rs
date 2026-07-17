mod legacy;

use std::ffi::OsStr;

use climon_proto::meta::SessionMeta;

use crate::error::{SessionError, SessionResult};

pub use legacy::SessionHostOptions;

const ENGINE_ENV: &str = "CLIMON_SESSION_ENGINE";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Engine {
    Legacy,
    Actor,
}

fn selected_engine(value: Option<&str>) -> SessionResult<Engine> {
    match value {
        None | Some("") | Some("legacy") => Ok(Engine::Legacy),
        Some("actor") => Ok(Engine::Actor),
        Some(value) => Err(SessionError::InvalidEngine(value.to_string())),
    }
}

/// Runs the session host, selecting the legacy thread-based engine or the
/// (not yet available) actor engine based on the `CLIMON_SESSION_ENGINE`
/// environment variable. Defaults to the legacy engine.
pub fn run_session_host(
    id: &str,
    meta: SessionMeta,
    options: SessionHostOptions,
) -> SessionResult<i32> {
    let value = std::env::var_os(ENGINE_ENV);
    match selected_engine(value.as_deref().and_then(OsStr::to_str))? {
        Engine::Legacy => legacy::run_session_host(id, meta, options),
        Engine::Actor => crate::engine::run_session_host(id, meta, options),
    }
}

#[cfg(test)]
mod tests {
    use super::{selected_engine, Engine};

    #[test]
    fn selector_defaults_to_legacy() {
        assert_eq!(selected_engine(None).unwrap(), Engine::Legacy);
    }

    #[test]
    fn selector_accepts_actor() {
        assert_eq!(selected_engine(Some("actor")).unwrap(), Engine::Actor);
    }

    #[test]
    fn selector_rejects_unknown_values() {
        let err = selected_engine(Some("future")).unwrap_err();
        assert_eq!(
            err.to_string(),
            "invalid CLIMON_SESSION_ENGINE 'future'; expected 'legacy' or 'actor'"
        );
    }
}
