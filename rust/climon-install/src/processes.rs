//! Running-process detection/termination during install. 1:1 port of
//! `src/install/processes.ts`. The PowerShell script string is platform-agnostic
//! (and unit-tested everywhere); the executor is gated to Windows.

/// PowerShell script that force-stops any running `climon`/`climon-server`.
pub const KILL_RUNNING_CLIMON_PROCESSES_SCRIPT: &str = concat!(
    "$ProgressPreference = 'SilentlyContinue'",
    "; ",
    "$processes = Get-Process -Name 'climon','climon-server' -ErrorAction SilentlyContinue",
    "; ",
    "if ($null -ne $processes) { $processes | Stop-Process -Force -ErrorAction Stop }"
);

/// Strips PowerShell CLIXML progress/verbose noise from stderr output.
#[cfg(target_os = "windows")]
fn clean_power_shell_stderr(stderr: &str) -> String {
    // PowerShell emits XML-encoded progress records to stderr even on success;
    // these are not actionable errors. Drop the `#< CLIXML ... </Objs>` block.
    let mut cleaned = stderr.to_string();
    if let Some(start) = cleaned.find("#< CLIXML") {
        if let Some(end_rel) = cleaned[start..].find("</Objs>") {
            let end = start + end_rel + "</Objs>".len();
            cleaned.replace_range(start..end, "");
        }
    }
    cleaned.trim().to_string()
}

/// Terminates running climon processes via PowerShell. Windows only.
#[cfg(target_os = "windows")]
pub fn kill_running_climon_processes() -> Result<(), String> {
    use crate::windows::powershell_args_for_script;
    use std::process::Command;

    let output = Command::new("powershell.exe")
        .args(powershell_args_for_script(
            KILL_RUNNING_CLIMON_PROCESSES_SCRIPT,
        ))
        .output()
        .map_err(|e| format!("Failed to stop running climon processes: {e}"))?;

    if !output.status.success() {
        let stderr = clean_power_shell_stderr(&String::from_utf8_lossy(&output.stderr));
        let stdout = String::from_utf8_lossy(&output.stdout);
        let message = if !stderr.is_empty() {
            stderr
        } else if !stdout.trim().is_empty() {
            stdout.trim().to_string()
        } else {
            "powershell.exe failed".to_string()
        };
        return Err(format!(
            "Failed to stop running climon processes: {message}"
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stops_climon_processes_if_running() {
        assert!(KILL_RUNNING_CLIMON_PROCESSES_SCRIPT
            .contains("Get-Process -Name 'climon','climon-server'"));
        assert!(KILL_RUNNING_CLIMON_PROCESSES_SCRIPT.contains("Stop-Process -Force"));
        assert!(KILL_RUNNING_CLIMON_PROCESSES_SCRIPT.contains("-ErrorAction SilentlyContinue"));
        assert!(KILL_RUNNING_CLIMON_PROCESSES_SCRIPT
            .contains("$ProgressPreference = 'SilentlyContinue'"));
    }
}
