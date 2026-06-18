//! Windows PowerShell / registry helpers for user-PATH editing. Port of
//! `src/install/windows.ts`.
//!
//! The pure helpers (UTF-16 base64, PowerShell argument/script builders) are
//! cross-platform and unit-tested everywhere. The FFI-backed registry/broadcast
//! functions are gated to Windows.

const BASE64_ALPHABET: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(BASE64_ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(BASE64_ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(BASE64_ALPHABET[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(BASE64_ALPHABET[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn base64_decode(value: &str) -> Vec<u8> {
    fn val(c: u8) -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some((c - b'A') as u32),
            b'a'..=b'z' => Some((c - b'a' + 26) as u32),
            b'0'..=b'9' => Some((c - b'0' + 52) as u32),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    }
    let cleaned: Vec<u8> = value.trim().bytes().filter(|&c| c != b'=').collect();
    let mut out = Vec::with_capacity(cleaned.len() * 3 / 4);
    for chunk in cleaned.chunks(4) {
        let mut acc = 0u32;
        let mut bits = 0;
        for &c in chunk {
            if let Some(v) = val(c) {
                acc = (acc << 6) | v;
                bits += 6;
            }
        }
        // Emit the high bytes that were fully filled.
        let mut shift = bits - 8;
        while shift >= 0 {
            out.push(((acc >> shift) & 0xff) as u8);
            shift -= 8;
        }
    }
    out
}

/// Encodes a string as UTF-16LE and then base64, matching
/// `Buffer.from(value, "utf16le").toString("base64")`.
pub fn encode_utf16_base64(value: &str) -> String {
    let mut bytes = Vec::with_capacity(value.len() * 2);
    for unit in value.encode_utf16() {
        bytes.extend_from_slice(&unit.to_le_bytes());
    }
    base64_encode(&bytes)
}

/// Decodes base64 UTF-16LE back to a string, matching
/// `Buffer.from(value, "base64").toString("utf16le")`.
pub fn decode_utf16_base64(value: &str) -> String {
    let bytes = base64_decode(value);
    let units: Vec<u16> = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
        .collect();
    String::from_utf16_lossy(&units)
}

/// Builds the PowerShell argument vector that runs `script` via an encoded
/// command so the script text stays Unicode-safe.
pub fn powershell_args_for_script(script: &str) -> Vec<String> {
    vec![
        "-NoProfile".to_string(),
        "-NonInteractive".to_string(),
        "-ExecutionPolicy".to_string(),
        "Bypass".to_string(),
        "-EncodedCommand".to_string(),
        encode_utf16_base64(script),
    ]
}

/// PowerShell that reads the raw user PATH from the registry without expanding
/// environment names, returned base64-encoded.
pub fn read_user_path_script() -> String {
    [
        "$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')",
        "$value = if ($null -eq $key) { '' } else { $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }",
        "if ($null -eq $value) { $value = '' }",
        "[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($value))",
    ]
    .join("; ")
}

/// PowerShell that writes the user PATH back as `REG_EXPAND_SZ` from a UTF-16
/// base64 payload.
pub fn write_user_path_script(value: &str) -> String {
    [
        "$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')".to_string(),
        format!(
            "$bytes = [Convert]::FromBase64String('{}')",
            encode_utf16_base64(value)
        ),
        "$value = [Text.Encoding]::Unicode.GetString($bytes)".to_string(),
        "$key.SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)"
            .to_string(),
    ]
    .join("; ")
}

/// PowerShell that expands `%VAR%` references in `value` and returns the
/// expanded string base64-encoded (UTF-16). Mirrors the FFI
/// `ExpandEnvironmentStringsW` call the Bun installer uses, but routed through
/// PowerShell so it shares the same encoded-command transport as the rest of
/// the registry helpers (and needs no extra FFI link on Windows).
pub fn expand_environment_string_script(value: &str) -> String {
    [
        format!(
            "$bytes = [Convert]::FromBase64String('{}')",
            encode_utf16_base64(value)
        ),
        "$value = [Text.Encoding]::Unicode.GetString($bytes)".to_string(),
        "[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes([Environment]::ExpandEnvironmentVariables($value)))"
            .to_string(),
    ]
    .join("; ")
}

/// PowerShell that broadcasts a `WM_SETTINGCHANGE` for the `Environment` topic
/// so already-running processes pick up the updated user PATH. Mirrors the Bun
/// installer's `SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, ...)` FFI
/// call; best-effort, errors are ignored by the caller.
pub const BROADCAST_ENVIRONMENT_CHANGE_SCRIPT: &str = concat!(
    "$signature = '[DllImport(\"user32.dll\", SetLastError=true, CharSet=CharSet.Auto)] ",
    "public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, ",
    "System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);'",
    "; ",
    "$type = Add-Type -MemberDefinition $signature -Name ClimonNativeMethods -Namespace Win32 -PassThru",
    "; ",
    "[System.UIntPtr]$result = [System.UIntPtr]::Zero",
    "; ",
    // HWND_BROADCAST = 0xffff, WM_SETTINGCHANGE = 0x1A, SMTO_ABORTIFHUNG = 0x2.
    "[void]$type::SendMessageTimeout([System.IntPtr]0xffff, 0x1A, [System.UIntPtr]::Zero, ",
    "'Environment', 0x2, 5000, [ref]$result)"
);

#[cfg(target_os = "windows")]
mod platform {
    use super::*;
    use std::process::Command;

    /// Reads `LOCALAPPDATA`, erroring if it is unset.
    pub fn get_local_app_data() -> Result<String, String> {
        std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is not set.".to_string())
    }

    fn run_powershell(script: &str, action: &str) -> Result<String, String> {
        let output = Command::new("powershell.exe")
            .args(powershell_args_for_script(script))
            .output()
            .map_err(|e| format!("Failed to {action}: {e}"))?;
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            let message = if !stderr.trim().is_empty() {
                stderr.trim().to_string()
            } else if !stdout.trim().is_empty() {
                stdout.trim().to_string()
            } else {
                "powershell.exe failed".to_string()
            };
            return Err(format!("Failed to {action}: {message}"));
        }
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    }

    /// Reads the raw (unexpanded) user PATH from the registry.
    pub fn read_user_path() -> Result<String, String> {
        let encoded = run_powershell(&read_user_path_script(), "read user PATH")?;
        Ok(if encoded.is_empty() {
            String::new()
        } else {
            decode_utf16_base64(&encoded)
        })
    }

    /// Writes the user PATH back to the registry as `REG_EXPAND_SZ`.
    pub fn write_user_path(value: &str) -> Result<(), String> {
        run_powershell(&write_user_path_script(value), "update user PATH")?;
        Ok(())
    }

    /// Expands `%VAR%` references in `value` via PowerShell. On any failure the
    /// input is returned unchanged so PATH comparison degrades gracefully.
    pub fn expand_environment_string(value: &str) -> String {
        match run_powershell(
            &expand_environment_string_script(value),
            "expand environment strings",
        ) {
            Ok(encoded) if !encoded.is_empty() => decode_utf16_base64(&encoded),
            Ok(_) => String::new(),
            Err(_) => value.to_string(),
        }
    }

    /// Broadcasts `WM_SETTINGCHANGE` so running processes pick up the new PATH.
    /// Best-effort: failures are ignored, matching the Bun installer.
    pub fn broadcast_environment_change() {
        let _ = run_powershell(
            BROADCAST_ENVIRONMENT_CHANGE_SCRIPT,
            "broadcast environment change",
        );
    }
}

#[cfg(target_os = "windows")]
pub use platform::{
    broadcast_environment_change, expand_environment_string, get_local_app_data, read_user_path,
    write_user_path,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_non_ascii_path_values_through_utf16_base64() {
        let value = "C:\\Tools;C:\\Users\\Zoë\\bin;C:\\工具";
        assert_eq!(decode_utf16_base64(&encode_utf16_base64(value)), value);
    }

    #[test]
    fn builds_encoded_powershell_command() {
        let args =
            powershell_args_for_script("[Environment]::GetEnvironmentVariable('Path', 'User')");
        assert_eq!(
            args,
            vec![
                "-NoProfile".to_string(),
                "-NonInteractive".to_string(),
                "-ExecutionPolicy".to_string(),
                "Bypass".to_string(),
                "-EncodedCommand".to_string(),
                encode_utf16_base64("[Environment]::GetEnvironmentVariable('Path', 'User')"),
            ]
        );
    }

    #[test]
    fn reads_raw_user_path_without_expanding() {
        let script = read_user_path_script();
        assert!(
            script.contains("[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')")
        );
        assert!(script.contains(
            "GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)"
        ));
        assert!(script.contains("[Convert]::ToBase64String"));
        assert!(script.contains("[Text.Encoding]::Unicode.GetBytes"));
    }

    #[test]
    fn writes_user_path_as_reg_expand_sz() {
        let value = "C:\\Tools;C:\\Users\\Zoë\\bin;C:\\工具";
        let script = write_user_path_script(value);
        assert!(
            script.contains("[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')")
        );
        assert!(script.contains(&format!(
            "[Convert]::FromBase64String('{}')",
            encode_utf16_base64(value)
        )));
        assert!(script.contains("[Text.Encoding]::Unicode.GetString"));
        assert!(script.contains(
            "SetValue('Path', $value, [Microsoft.Win32.RegistryValueKind]::ExpandString)"
        ));
        assert!(!script.contains(value));
    }

    #[test]
    fn expand_script_round_trips_value_and_calls_expand() {
        let value = "%LOCALAPPDATA%\\Programs\\climon";
        let script = expand_environment_string_script(value);
        assert!(script.contains(&format!(
            "[Convert]::FromBase64String('{}')",
            encode_utf16_base64(value)
        )));
        assert!(script.contains("[Environment]::ExpandEnvironmentVariables($value)"));
        assert!(script.contains("[Convert]::ToBase64String"));
        // The raw (unencoded) value must not leak into the script text.
        assert!(!script.contains(value));
    }

    #[test]
    fn broadcast_script_sends_setting_change() {
        let script = BROADCAST_ENVIRONMENT_CHANGE_SCRIPT;
        assert!(script.contains("SendMessageTimeout"));
        assert!(script.contains("user32.dll"));
        // HWND_BROADCAST + WM_SETTINGCHANGE + SMTO_ABORTIFHUNG.
        assert!(script.contains("0xffff"));
        assert!(script.contains("0x1A"));
        assert!(script.contains("'Environment'"));
    }

    #[test]
    fn base64_matches_known_vectors() {
        // Sanity-check the hand-rolled base64 against standard vectors.
        assert_eq!(base64_encode(b"Man"), "TWFu");
        assert_eq!(base64_encode(b"Ma"), "TWE=");
        assert_eq!(base64_encode(b"M"), "TQ==");
        assert_eq!(base64_decode("TWFu"), b"Man");
        assert_eq!(base64_decode("TWE="), b"Ma");
        assert_eq!(base64_decode("TQ=="), b"M");
    }
}
