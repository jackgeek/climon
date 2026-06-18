//! Onboarding flow: EULA gate + telemetry/auto-update opt-ins + install id.
//! 1:1 port of `src/setup/onboarding.ts`. Both opt-ins default OFF; a
//! non-interactive re-run without flags never silently revokes a prior opt-in.

use climon_config::config::{write_config_setting, Env, WriteScope};
use std::path::Path;

use crate::eula::{ensure_eula_accepted, EulaGateOptions};
use crate::install_id::ensure_install_id;

// i18n strings (English) mirrored from `src/i18n/messages.en.json`.
const MSG_TELEMETRY_PROMPT: &str =
    "Help improve climon by sending anonymous usage telemetry? [y/N] ";
const MSG_AUTO_UPDATE_PROMPT: &str =
    "Automatically download and apply climon updates in the background? [y/N] ";

/// Parsed `climon setup` / installer options.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SetupOptions {
    /// Run non-interactively (no prompts).
    pub apply: bool,
    /// Accept the EULA without prompting.
    pub accept_eula: bool,
    /// Telemetry opt-in; `None` means "leave at current/default".
    pub telemetry: Option<bool>,
    /// Auto-update opt-in; `None` means "leave at current/default".
    pub auto_update: Option<bool>,
}

fn parse_on_off(flag: &str, value: &str) -> Result<bool, String> {
    match value {
        "on" | "true" => Ok(true),
        "off" | "false" => Ok(false),
        _ => Err(format!(
            "Invalid value for {flag}: {value} (expected on|off)"
        )),
    }
}

/// Parses `climon setup` / installer flags into structured options.
pub fn parse_setup_options(args: &[String]) -> Result<SetupOptions, String> {
    let mut options = SetupOptions::default();
    for arg in args {
        if arg == "--apply" {
            options.apply = true;
        } else if arg == "--accept-eula" {
            options.accept_eula = true;
        } else if let Some(value) = arg.strip_prefix("--telemetry=") {
            options.telemetry = Some(parse_on_off("--telemetry", value)?);
        } else if let Some(value) = arg.strip_prefix("--auto-update=") {
            options.auto_update = Some(parse_on_off("--auto-update", value)?);
        }
    }
    Ok(options)
}

/// Result of running onboarding.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OnboardingResult {
    pub accepted: bool,
}

/// Injectable I/O for [`run_onboarding`].
pub struct OnboardingIo<'a> {
    pub env: &'a Env,
    pub options: SetupOptions,
    pub print: &'a mut dyn FnMut(&str),
    pub prompt: &'a mut dyn FnMut(&str) -> String,
}

/// Reads a yes/no answer; default is NO when the user just presses enter.
fn is_yes(answer: &str) -> bool {
    matches!(answer.trim().to_lowercase().as_str(), "y" | "yes")
}

/// Runs the full onboarding flow: EULA gate, telemetry opt-in, auto-update
/// opt-in, and install-id assignment. Both opt-ins default OFF. When the EULA is
/// not accepted, no telemetry/update state is written and `accepted=false`.
pub fn run_onboarding(io: OnboardingIo<'_>) -> Result<OnboardingResult, String> {
    let OnboardingIo {
        env,
        options,
        print,
        prompt,
    } = io;

    let interactive = !options.apply;

    let accepted = ensure_eula_accepted(EulaGateOptions {
        env,
        interactive,
        accept_eula: options.accept_eula,
        print: &mut *print,
        prompt: &mut *prompt,
    })?;
    if !accepted {
        return Ok(OnboardingResult { accepted: false });
    }

    // Telemetry opt-in (default OFF). An explicit option or interactive answer
    // is persisted; a non-interactive run without the flag leaves the existing
    // value untouched so re-running setup never silently revokes a prior opt-in.
    let telemetry = if let Some(value) = options.telemetry {
        Some(value)
    } else if interactive {
        Some(is_yes(&prompt(MSG_TELEMETRY_PROMPT)))
    } else {
        None
    };
    if let Some(value) = telemetry {
        write_config_setting(
            "telemetry.enabled",
            &value.to_string(),
            WriteScope::Global,
            env,
            Path::new("."),
        )?;
    }

    // Auto-update opt-in (default OFF). Same leave-at-current semantics.
    let auto_update = if let Some(value) = options.auto_update {
        Some(value)
    } else if interactive {
        Some(is_yes(&prompt(MSG_AUTO_UPDATE_PROMPT)))
    } else {
        None
    };
    if let Some(value) = auto_update {
        write_config_setting(
            "update.auto",
            &value.to_string(),
            WriteScope::Global,
            env,
            Path::new("."),
        )?;
    }

    ensure_install_id(env)?;
    Ok(OnboardingResult { accepted: true })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eula::tempdir::TempHome;
    use climon_config::config::read_global_config_setting;
    use serde_json::Value;
    use std::cell::Cell;

    fn temp_env() -> (TempHome, Env) {
        let home = TempHome::new();
        let env = Env::new(Some(home.path_str()), home.path());
        (home, env)
    }

    fn opts(args: &[&str]) -> Vec<String> {
        args.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn defaults_interactive_no_flags() {
        let o = parse_setup_options(&[]).unwrap();
        assert!(!o.apply);
        assert!(!o.accept_eula);
        assert_eq!(o.telemetry, None);
        assert_eq!(o.auto_update, None);
    }

    #[test]
    fn parses_all_flags() {
        let o = parse_setup_options(&opts(&[
            "--apply",
            "--accept-eula",
            "--telemetry=on",
            "--auto-update=off",
        ]))
        .unwrap();
        assert!(o.apply);
        assert!(o.accept_eula);
        assert_eq!(o.telemetry, Some(true));
        assert_eq!(o.auto_update, Some(false));
    }

    #[test]
    fn telemetry_off_and_unknown() {
        assert_eq!(
            parse_setup_options(&opts(&["--telemetry=off"]))
                .unwrap()
                .telemetry,
            Some(false)
        );
        assert!(parse_setup_options(&opts(&["--telemetry=maybe"])).is_err());
    }

    fn run_with(env: &Env, options: SetupOptions, answers: &[&str]) -> OnboardingResult {
        let idx = Cell::new(0);
        let answers: Vec<String> = answers.iter().map(|s| s.to_string()).collect();
        let mut prompt = |_q: &str| {
            let i = idx.replace(idx.get() + 1);
            answers.get(i).cloned().unwrap_or_default()
        };
        run_onboarding(OnboardingIo {
            env,
            options,
            print: &mut |_s: &str| {},
            prompt: &mut prompt,
        })
        .unwrap()
    }

    #[test]
    fn non_interactive_applies_opt_ins_and_accepts() {
        let (_h, env) = temp_env();
        let result = run_with(
            &env,
            SetupOptions {
                apply: true,
                accept_eula: true,
                telemetry: Some(true),
                auto_update: Some(true),
            },
            &[],
        );
        assert!(result.accepted);
        assert_eq!(
            read_global_config_setting("telemetry.enabled", &env),
            Some(Value::Bool(true))
        );
        assert_eq!(
            read_global_config_setting("update.auto", &env),
            Some(Value::Bool(true))
        );
        assert!(matches!(
            read_global_config_setting("install.id", &env),
            Some(Value::String(_))
        ));
    }

    #[test]
    fn non_interactive_without_accept_returns_not_accepted() {
        let (_h, env) = temp_env();
        let result = run_with(
            &env,
            SetupOptions {
                apply: true,
                accept_eula: false,
                telemetry: None,
                auto_update: None,
            },
            &[],
        );
        assert!(!result.accepted);
        assert_eq!(read_global_config_setting("telemetry.enabled", &env), None);
        assert_eq!(read_global_config_setting("update.auto", &env), None);
        assert_eq!(read_global_config_setting("install.id", &env), None);
    }

    #[test]
    fn non_interactive_rerun_preserves_prior_opt_in() {
        let (_h, env) = temp_env();
        write_config_setting(
            "telemetry.enabled",
            "true",
            WriteScope::Global,
            &env,
            Path::new("."),
        )
        .unwrap();
        write_config_setting(
            "update.auto",
            "true",
            WriteScope::Global,
            &env,
            Path::new("."),
        )
        .unwrap();
        let result = run_with(
            &env,
            SetupOptions {
                apply: true,
                accept_eula: true,
                telemetry: None,
                auto_update: None,
            },
            &[],
        );
        assert!(result.accepted);
        assert_eq!(
            read_global_config_setting("telemetry.enabled", &env),
            Some(Value::Bool(true))
        );
        assert_eq!(
            read_global_config_setting("update.auto", &env),
            Some(Value::Bool(true))
        );
    }

    #[test]
    fn interactive_i_agree_then_yes_enables_both() {
        let (_h, env) = temp_env();
        let result = run_with(&env, SetupOptions::default(), &["i agree", "y", "y"]);
        assert!(result.accepted);
        assert_eq!(
            read_global_config_setting("telemetry.enabled", &env),
            Some(Value::Bool(true))
        );
        assert_eq!(
            read_global_config_setting("update.auto", &env),
            Some(Value::Bool(true))
        );
    }

    #[test]
    fn interactive_blank_answers_leave_opt_ins_off() {
        let (_h, env) = temp_env();
        run_with(&env, SetupOptions::default(), &["i agree", "", ""]);
        assert_eq!(
            read_global_config_setting("telemetry.enabled", &env),
            Some(Value::Bool(false))
        );
        assert_eq!(
            read_global_config_setting("update.auto", &env),
            Some(Value::Bool(false))
        );
    }
}
