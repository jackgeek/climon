//! EULA text + acceptance gate. 1:1 port of `src/eula/text.ts` and
//! `src/eula/accept.ts`. Acceptance state lives in the global `$CLIMON_HOME`
//! config, keyed by the embedded [`EULA_VERSION`] so a bumped licence
//! re-triggers acceptance.

use climon_config::config::{read_global_config_setting, write_config_setting, Env, WriteScope};
use serde_json::Value;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

/// Bump when the licence text changes; a newer value re-triggers acceptance.
pub const EULA_VERSION: &str = "1";

/// The embedded English EULA, the single source of truth (also published as
/// `EULA.md` at the repo root). Mirrors `EULA_TEXTS.en.text` in the TS client.
pub const EULA_EN_TEXT: &str = include_str!("../../../EULA.md");

// i18n strings (English) mirrored from `src/i18n/messages.en.json`.
const MSG_NEED_ACCEPT_FLAG: &str =
    "Non-interactive run requires --accept-eula to accept the licence.";
const MSG_ACCEPT_PROMPT: &str = "Type 'I AGREE' to accept the licence and continue: ";
const MSG_DECLINED: &str = "Licence not accepted. Installation aborted.";

/// A localized EULA document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EulaDocument {
    pub version: String,
    pub text: String,
}

/// Returns the EULA document for a locale, falling back to English.
pub fn get_eula(_locale: &str) -> EulaDocument {
    EulaDocument {
        version: EULA_VERSION.to_string(),
        text: EULA_EN_TEXT.to_string(),
    }
}

/// True only when the user accepted the EULA AND the accepted version matches
/// the currently embedded [`EULA_VERSION`].
pub fn is_eula_accepted(env: &Env) -> bool {
    let accepted = read_global_config_setting("eula.accepted", env) == Some(Value::Bool(true));
    let version = read_global_config_setting("eula.version", env);
    accepted && version == Some(Value::String(EULA_VERSION.to_string()))
}

/// Formats the current UTC time as an ISO-8601 string (matching
/// `Date#toISOString`).
fn now_iso() -> String {
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0) as i64;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    let (hh, mm, ss) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    format!("{y:04}-{m:02}-{d:02}T{hh:02}:{mm:02}:{ss:02}.000Z")
}

/// Howard Hinnant's `civil_from_days`: days since the Unix epoch -> (y, m, d).
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y, m as u32, d as u32)
}

/// Records acceptance of the current EULA version in the global config.
pub fn record_eula_acceptance(env: &Env) -> Result<(), String> {
    let cwd = Path::new(".");
    write_config_setting("eula.accepted", "true", WriteScope::Global, env, cwd)?;
    write_config_setting("eula.version", EULA_VERSION, WriteScope::Global, env, cwd)?;
    write_config_setting("eula.acceptedAt", &now_iso(), WriteScope::Global, env, cwd)?;
    Ok(())
}

/// Injectable options for [`ensure_eula_accepted`], mirroring the TS gate.
pub struct EulaGateOptions<'a> {
    pub env: &'a Env,
    /// When false, do not prompt; require `accept_eula`.
    pub interactive: bool,
    /// Non-interactive acceptance (e.g. from a `--accept-eula` flag).
    pub accept_eula: bool,
    pub print: &'a mut dyn FnMut(&str),
    pub prompt: &'a mut dyn FnMut(&str) -> String,
}

/// Ensures the EULA is accepted, returning whether it is (now or already). A
/// `false` return means "not accepted" and callers decide how to handle it.
pub fn ensure_eula_accepted(options: EulaGateOptions<'_>) -> Result<bool, String> {
    let EulaGateOptions {
        env,
        interactive,
        accept_eula,
        print,
        prompt,
    } = options;

    if is_eula_accepted(env) {
        return Ok(true);
    }

    if accept_eula {
        record_eula_acceptance(env)?;
        return Ok(true);
    }

    if !interactive {
        print(&format!("{MSG_NEED_ACCEPT_FLAG}\n"));
        return Ok(false);
    }

    print(&format!("{}\n", get_eula("en").text));
    let answer = prompt(MSG_ACCEPT_PROMPT);
    if answer.trim().to_lowercase() == "i agree" {
        record_eula_acceptance(env)?;
        return Ok(true);
    }
    print(&format!("{MSG_DECLINED}\n"));
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_env() -> (tempdir::TempHome, Env) {
        let home = tempdir::TempHome::new();
        let env = Env::new(Some(home.path_str()), home.path());
        (home, env)
    }

    #[test]
    fn version_is_non_empty() {
        assert!(!EULA_VERSION.is_empty());
    }

    #[test]
    fn english_text_mentions_licensor_ireland_and_as_is() {
        let doc = get_eula("en");
        assert!(doc.text.contains("Brodie Jack Allan"));
        assert!(doc.text.contains("Ireland"));
        assert!(doc.text.contains("AS IS"));
    }

    #[test]
    fn falls_back_to_en_for_unknown_locale() {
        assert_eq!(get_eula("xx").text, EULA_EN_TEXT);
    }

    #[test]
    fn eula_md_is_byte_identical_to_embedded_text() {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../EULA.md");
        let file_text = std::fs::read_to_string(path).unwrap();
        assert_eq!(file_text, EULA_EN_TEXT);
    }

    #[test]
    fn not_accepted_on_fresh_install() {
        let (_h, env) = temp_env();
        assert!(!is_eula_accepted(&env));
    }

    #[test]
    fn recording_acceptance_persists_accepted_version_timestamp() {
        let (_h, env) = temp_env();
        record_eula_acceptance(&env).unwrap();
        assert!(is_eula_accepted(&env));
        assert_eq!(
            read_global_config_setting("eula.version", &env),
            Some(Value::String(EULA_VERSION.to_string()))
        );
        assert!(matches!(
            read_global_config_setting("eula.acceptedAt", &env),
            Some(Value::String(_))
        ));
    }

    #[test]
    fn version_mismatch_treated_as_not_accepted() {
        let (_h, env) = temp_env();
        record_eula_acceptance(&env).unwrap();
        write_config_setting(
            "eula.version",
            "0",
            WriteScope::Global,
            &env,
            Path::new("."),
        )
        .unwrap();
        assert!(!is_eula_accepted(&env));
    }

    #[test]
    fn accepts_when_user_types_i_agree_any_case() {
        let (_h, env) = temp_env();
        let mut printed = String::new();
        let mut prompt = |_q: &str| "  i agree ".to_string();
        let ok = ensure_eula_accepted(EulaGateOptions {
            env: &env,
            interactive: true,
            accept_eula: false,
            print: &mut |s: &str| printed.push_str(s),
            prompt: &mut prompt,
        })
        .unwrap();
        assert!(ok);
        assert!(is_eula_accepted(&env));
        assert!(printed.contains("Brodie Jack Allan"));
    }

    #[test]
    fn rejects_other_input() {
        let (_h, env) = temp_env();
        let mut prompt = |_q: &str| "no".to_string();
        let ok = ensure_eula_accepted(EulaGateOptions {
            env: &env,
            interactive: true,
            accept_eula: false,
            print: &mut |_s: &str| {},
            prompt: &mut prompt,
        })
        .unwrap();
        assert!(!ok);
        assert!(!is_eula_accepted(&env));
    }

    #[test]
    fn skips_prompt_when_already_accepted() {
        let (_h, env) = temp_env();
        let mut prompt = |_q: &str| "i agree".to_string();
        ensure_eula_accepted(EulaGateOptions {
            env: &env,
            interactive: true,
            accept_eula: false,
            print: &mut |_s: &str| {},
            prompt: &mut prompt,
        })
        .unwrap();

        let mut prompted = false;
        let mut prompt2 = |_q: &str| {
            prompted = true;
            "no".to_string()
        };
        let ok = ensure_eula_accepted(EulaGateOptions {
            env: &env,
            interactive: true,
            accept_eula: false,
            print: &mut |_s: &str| {},
            prompt: &mut prompt2,
        })
        .unwrap();
        assert!(ok);
        assert!(!prompted);
    }

    #[test]
    fn non_interactive_accepts_with_flag() {
        let (_h, env) = temp_env();
        let mut prompted = false;
        let mut prompt = |_q: &str| {
            prompted = true;
            String::new()
        };
        let ok = ensure_eula_accepted(EulaGateOptions {
            env: &env,
            interactive: false,
            accept_eula: true,
            print: &mut |_s: &str| {},
            prompt: &mut prompt,
        })
        .unwrap();
        assert!(ok);
        assert!(!prompted);
        assert!(is_eula_accepted(&env));
    }

    #[test]
    fn non_interactive_without_flag_fails() {
        let (_h, env) = temp_env();
        let mut prompt = |_q: &str| String::new();
        let ok = ensure_eula_accepted(EulaGateOptions {
            env: &env,
            interactive: false,
            accept_eula: false,
            print: &mut |_s: &str| {},
            prompt: &mut prompt,
        })
        .unwrap();
        assert!(!ok);
        assert!(!is_eula_accepted(&env));
    }
}

#[cfg(test)]
pub(crate) mod tempdir {
    use std::path::{Path, PathBuf};

    /// A throwaway `$CLIMON_HOME` directory removed on drop.
    pub struct TempHome {
        path: PathBuf,
    }

    impl TempHome {
        pub fn new() -> TempHome {
            let mut buf = [0u8; 8];
            getrandom::getrandom(&mut buf).expect("getrandom for temp dir");
            let suffix: String = buf.iter().map(|b| format!("{b:02x}")).collect();
            let path = std::env::temp_dir().join(format!("climon-install-{suffix}"));
            std::fs::create_dir_all(&path).unwrap();
            TempHome { path }
        }

        pub fn path(&self) -> &Path {
            &self.path
        }

        pub fn path_str(&self) -> &str {
            self.path.to_str().unwrap()
        }
    }

    impl Drop for TempHome {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }
}
