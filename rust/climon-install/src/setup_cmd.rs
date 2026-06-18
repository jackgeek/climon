//! `climon setup` command: re-runs onboarding with any provided flags. 1:1 port
//! of `src/setup/setup-cmd.ts`, wired to real stdio for prompts.

use std::io::{BufRead, Write};

use climon_config::config::Env;

use crate::onboarding::{parse_setup_options, run_onboarding, OnboardingIo};

/// Reads a single line from stdin after printing `question`, mirroring the
/// readline prompt used by the TS onboarding flow.
fn stdin_prompt(question: &str) -> String {
    print!("{question}");
    let _ = std::io::stdout().flush();
    let mut line = String::new();
    if std::io::stdin().lock().read_line(&mut line).is_err() {
        return String::new();
    }
    // Strip the trailing newline (and CR) the user entered.
    line.trim_end_matches(['\n', '\r']).to_string()
}

/// `climon setup` entrypoint: re-runs onboarding, returning 0 when the EULA was
/// accepted and 1 otherwise.
pub fn run_setup_command(argv: &[String], env: &Env) -> Result<i32, String> {
    let options = parse_setup_options(argv)?;
    let mut print = |s: &str| {
        print!("{s}");
        let _ = std::io::stdout().flush();
    };
    let mut prompt = |question: &str| stdin_prompt(question);
    let result = run_onboarding(OnboardingIo {
        env,
        options,
        print: &mut print,
        prompt: &mut prompt,
    })?;
    Ok(if result.accepted { 0 } else { 1 })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::eula::tempdir::TempHome;
    use climon_config::config::read_global_config_setting;
    use serde_json::Value;

    #[test]
    fn non_interactive_accept_returns_zero_and_persists_opt_ins() {
        let home = TempHome::new();
        let env = Env::new(Some(home.path_str()), home.path());
        let argv = vec![
            "--apply".to_string(),
            "--accept-eula".to_string(),
            "--telemetry=on".to_string(),
            "--auto-update=off".to_string(),
        ];
        let code = run_setup_command(&argv, &env).unwrap();
        assert_eq!(code, 0);
        assert_eq!(
            read_global_config_setting("telemetry.enabled", &env),
            Some(Value::Bool(true))
        );
        assert_eq!(
            read_global_config_setting("update.auto", &env),
            Some(Value::Bool(false))
        );
    }

    #[test]
    fn non_interactive_without_accept_returns_one() {
        let home = TempHome::new();
        let env = Env::new(Some(home.path_str()), home.path());
        let argv = vec!["--apply".to_string()];
        let code = run_setup_command(&argv, &env).unwrap();
        assert_eq!(code, 1);
    }

    #[test]
    fn invalid_flag_value_errors() {
        let home = TempHome::new();
        let env = Env::new(Some(home.path_str()), home.path());
        let argv = vec!["--telemetry=maybe".to_string()];
        assert!(run_setup_command(&argv, &env).is_err());
    }
}
