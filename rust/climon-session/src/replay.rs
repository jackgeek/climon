//! Terminal-replay helpers. Ports `src/terminal-replay.ts`
//! (`sanitizeBrowserTerminalReplay`) and the mouse private-mode replay tracking
//! from `src/daemon/daemon.ts`.

use std::collections::HashMap;

const ALTERNATE_SCREEN_ENTER: &[u8] = b"\x1b[?1049h";

/// Mouse private modes tracked so a replay re-asserts them. Mirrors
/// `TRACKED_MOUSE_PRIVATE_MODES`.
pub const TRACKED_MOUSE_PRIVATE_MODES: &[&str] = &["1000", "1002", "1003", "1005", "1006", "1015"];

const ESC_CSI_PRIVATE_MODE_PREFIX: &[u8] = b"\x1b[?";

/// Sanitizes the scrollback replay sent to a *browser* terminal so a trimmed
/// snapshot that begins inside the alternate screen (its `?1049h`/`?47h`/`?1047h`
/// enter was evicted, leaving an `l` exit first) does not dump alternate-screen
/// content into normal scrollback. Mirrors `sanitizeBrowserTerminalReplay`.
pub fn sanitize_browser_terminal_replay(data: &[u8]) -> Vec<u8> {
    let text = String::from_utf8_lossy(data);
    let first = first_alternate_screen_control(&text);
    if first != Some(b'l') {
        return data.to_vec();
    }
    let mut out = Vec::with_capacity(ALTERNATE_SCREEN_ENTER.len() + data.len());
    out.extend_from_slice(ALTERNATE_SCREEN_ENTER);
    out.extend_from_slice(data);
    out
}

/// Finds the action byte (`h`/`l`) of the first `\x1b[?(47|1047|1049)[hl]`
/// control in `text`, mirroring the JS regex `\x1b\[\?(?:47|1047|1049)([hl])`.
fn first_alternate_screen_control(text: &str) -> Option<u8> {
    let bytes = text.as_bytes();
    let mut i = 0;
    while i + 3 < bytes.len() {
        if &bytes[i..i + 3] == ESC_CSI_PRIVATE_MODE_PREFIX {
            let rest = &bytes[i + 3..];
            for code in ["1049", "1047", "47"] {
                let cb = code.as_bytes();
                if rest.len() > cb.len() && &rest[..cb.len()] == cb {
                    let action = rest[cb.len()];
                    if action == b'h' || action == b'l' {
                        return Some(action);
                    }
                }
            }
        }
        i += 1;
    }
    None
}

/// Updates `mode_state` from the private-mode set/reset controls in `chunk`
/// (prefixed by `remainder` from a prior split chunk), returning the new
/// remainder holding an incomplete trailing control. Mirrors
/// `trackMousePrivateModesFromOutput`.
pub fn track_mouse_private_modes_from_output(
    mode_state: &mut HashMap<String, bool>,
    chunk: &[u8],
    remainder: &str,
    tracked_modes: &[&str],
) -> String {
    let chunk_text = String::from_utf8_lossy(chunk);
    let mut input = String::with_capacity(remainder.len() + chunk_text.len());
    input.push_str(remainder);
    input.push_str(&chunk_text);
    let bytes = input.as_bytes();

    let mut last_complete_match_end = 0usize;
    let mut i = 0usize;
    while i + 3 <= bytes.len() {
        if &bytes[i..i + 3] == ESC_CSI_PRIVATE_MODE_PREFIX {
            let mut j = i + 3;
            while j < bytes.len() && (bytes[j].is_ascii_digit() || bytes[j] == b';') {
                j += 1;
            }
            if j < bytes.len() && (bytes[j] == b'h' || bytes[j] == b'l') {
                let enabled = bytes[j] == b'h';
                let params = &input[i + 3..j];
                for param in params.split(';') {
                    if tracked_modes.contains(&param) {
                        mode_state.insert(param.to_string(), enabled);
                    }
                }
                last_complete_match_end = j + 1;
                i = j + 1;
                continue;
            }
        }
        i += 1;
    }

    if let Some(trailing_prefix) = rfind(bytes, ESC_CSI_PRIVATE_MODE_PREFIX) {
        if trailing_prefix >= last_complete_match_end {
            let trailing = &input[trailing_prefix..];
            if is_incomplete_private_mode_suffix(trailing.as_bytes()) {
                // `.slice(-64)`: keep the last 64 bytes (all ASCII here).
                let start = trailing.len().saturating_sub(64);
                return trailing[start..].to_string();
            }
        }
    }
    String::new()
}

/// Matches the JS `/\x1b\[\?[0-9;]*$/`: `\x1b[?` then only digits/semicolons to
/// end of string.
fn is_incomplete_private_mode_suffix(trailing: &[u8]) -> bool {
    if trailing.len() < 3 || &trailing[..3] != ESC_CSI_PRIVATE_MODE_PREFIX {
        return false;
    }
    trailing[3..]
        .iter()
        .all(|b| b.is_ascii_digit() || *b == b';')
}

fn rfind(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() || haystack.len() < needle.len() {
        return None;
    }
    (0..=haystack.len() - needle.len())
        .rev()
        .find(|&i| &haystack[i..i + needle.len()] == needle)
}

/// Builds the deterministic `\x1b[?<mode>h` suffix re-asserting every enabled
/// tracked mouse mode, in `tracked_modes` order. Mirrors
/// `buildMousePrivateModeReplaySuffix`.
pub fn build_mouse_private_mode_replay_suffix(
    mode_state: &HashMap<String, bool>,
    tracked_modes: &[&str],
) -> Vec<u8> {
    let mut suffix = Vec::new();
    for mode in tracked_modes {
        if mode_state.get(*mode) == Some(&true) {
            suffix.extend_from_slice(ESC_CSI_PRIVATE_MODE_PREFIX);
            suffix.extend_from_slice(mode.as_bytes());
            suffix.push(b'h');
        }
    }
    suffix
}

/// Builds a local-terminal mode synchronization sequence. Clear every tracked
/// mouse mode first because the physical terminal may have missed disables
/// while its output was suppressed, then re-enable the modes active on the PTY.
pub fn build_mouse_private_mode_restore_suffix(
    mode_state: &HashMap<String, bool>,
    tracked_modes: &[&str],
) -> Vec<u8> {
    let mut suffix = Vec::new();
    for mode in tracked_modes {
        suffix.extend_from_slice(ESC_CSI_PRIVATE_MODE_PREFIX);
        suffix.extend_from_slice(mode.as_bytes());
        suffix.push(b'l');
    }
    suffix.extend_from_slice(&build_mouse_private_mode_replay_suffix(
        mode_state,
        tracked_modes,
    ));
    suffix
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_prepends_alt_enter_when_first_control_is_exit() {
        // A trimmed snapshot whose first alternate-screen control is an exit.
        let input = b"alt1\r\nalt2\r\n\x1b[?1049l";
        let out = sanitize_browser_terminal_replay(input);
        assert!(out.starts_with(ALTERNATE_SCREEN_ENTER));
        assert!(out.ends_with(input));
    }

    #[test]
    fn sanitize_leaves_replay_untouched_when_first_control_is_enter() {
        let input = b"\x1b[?1049hcontent\x1b[?1049l";
        assert_eq!(sanitize_browser_terminal_replay(input), input.to_vec());
    }

    #[test]
    fn sanitize_leaves_replay_with_no_alternate_controls_untouched() {
        let input = b"plain output";
        assert_eq!(sanitize_browser_terminal_replay(input), input.to_vec());
    }

    #[test]
    fn tracks_private_mouse_modes_across_split_output_chunks() {
        let mut state = HashMap::new();
        let remainder = track_mouse_private_modes_from_output(
            &mut state,
            b"\x1b[?10",
            "",
            TRACKED_MOUSE_PRIVATE_MODES,
        );
        assert_eq!(remainder, "\x1b[?10");
        let next = track_mouse_private_modes_from_output(
            &mut state,
            b"00h",
            &remainder,
            TRACKED_MOUSE_PRIVATE_MODES,
        );
        assert_eq!(next, "");
        assert_eq!(state.get("1000"), Some(&true));
    }

    #[test]
    fn tracks_mixed_enable_disable_controls_and_keeps_the_latest_state() {
        let mut state = HashMap::new();
        let remainder = track_mouse_private_modes_from_output(
            &mut state,
            b"\x1b[?1000;1006h\x1b[?1000l",
            "",
            TRACKED_MOUSE_PRIVATE_MODES,
        );
        assert_eq!(remainder, "");
        assert_eq!(state.get("1000"), Some(&false));
        assert_eq!(state.get("1006"), Some(&true));
    }

    #[test]
    fn builds_a_deterministic_replay_suffix_for_enabled_mouse_modes() {
        let mut state = HashMap::new();
        state.insert("1000".to_string(), true);
        state.insert("1006".to_string(), true);
        state.insert("1002".to_string(), false);
        let suffix = build_mouse_private_mode_replay_suffix(&state, TRACKED_MOUSE_PRIVATE_MODES);
        assert_eq!(suffix, b"\x1b[?1000h\x1b[?1006h");
    }

    #[test]
    fn builds_a_local_restore_suffix_that_clears_stale_mouse_modes() {
        let mut state = HashMap::new();
        state.insert("1006".to_string(), true);
        let suffix = build_mouse_private_mode_restore_suffix(&state, TRACKED_MOUSE_PRIVATE_MODES);
        assert_eq!(
            suffix,
            b"\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l\x1b[?1006h"
        );
    }
}
