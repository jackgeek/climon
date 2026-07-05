//! Observes OSC window-title sequences (`OSC 0;…` icon+title and `OSC 2;…`
//! title) and OSC 9;4 terminal-progress sequences emitted by programs inside
//! the PTY, so climon can surface the current terminal title and progress as
//! per-session metadata. The parser only *reads* the output stream — bytes are
//! always passed through to the terminal unchanged.

use climon_proto::meta::{ProgressState, TerminalProgress};

const MAX_TITLE_LENGTH: usize = 256;
/// Cap on the buffered incomplete-sequence remainder. A never-terminated OSC
/// (e.g. a huge clipboard/image sequence) is discarded past this bound rather
/// than growing unbounded; at worst we miss one title update.
const MAX_REMAINDER: usize = 8192;

const ESC: u8 = 0x1b;
const BEL: u8 = 0x07;

/// Removes control characters (which could carry their own escape sequences) and
/// caps length at 256.
pub fn sanitize_title(name: &str) -> String {
    name.chars()
        .filter(|&c| {
            let code = c as u32;
            !(code <= 0x1f || code == 0x7f)
        })
        .take(MAX_TITLE_LENGTH)
        .collect()
}

/// Scans `chunk` (prefixed by `remainder` from a prior split read) for complete
/// `OSC 0;<text>` / `OSC 2;<text>` title sequences and `OSC 9;4` progress
/// sequences, terminated by BEL (`\x07`) or ST (`\x1b\`). When one or more
/// complete title sequences are found, `title` is updated to the sanitized text
/// of the *last* one (an empty title clears it to `Some(String::new())`). When
/// one or more complete progress sequences are found, `progress` is updated to
/// the *last* one (outer `None` = never observed; `Some(None)` = cleared by
/// state 0; `Some(Some(p))` = active). Returns the new remainder holding a
/// trailing incomplete escape sequence (bounded by `MAX_REMAINDER`; discarded
/// if longer). `OSC 1` (icon only) and all other OSC codes are ignored but
/// still skipped over so they never confuse detection.
pub fn capture_terminal_output(
    title: &mut Option<String>,
    progress: &mut Option<Option<TerminalProgress>>,
    chunk: &[u8],
    remainder: &str,
) -> String {
    let text = String::from_utf8_lossy(chunk);
    let mut input = String::with_capacity(remainder.len() + text.len());
    input.push_str(remainder);
    input.push_str(&text);
    let bytes = input.as_bytes();
    let len = bytes.len();

    let mut i = 0usize;
    while i < len {
        if bytes[i] != ESC {
            i += 1;
            continue;
        }
        // A trailing lone ESC (possibly the start of a split OSC) is buffered.
        if i + 1 >= len {
            return bounded_remainder(&input[i..]);
        }
        if bytes[i + 1] != b']' {
            i += 1;
            continue;
        }
        // Parse the OSC numeric code: ESC ] <digits> ;
        let mut j = i + 2;
        while j < len && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j >= len {
            // "ESC ] <digits>" ran to the end — incomplete, buffer from ESC.
            return bounded_remainder(&input[i..]);
        }
        if bytes[j] != b';' {
            // Not a "code;" OSC opener we understand; skip this ESC.
            i += 1;
            continue;
        }
        let code = &input[i + 2..j];
        // Find the terminator (BEL or ST) starting after the ';'.
        let mut k = j + 1;
        let mut text_end: Option<usize> = None;
        let mut term_end = len;
        while k < len {
            if bytes[k] == BEL {
                text_end = Some(k);
                term_end = k + 1;
                break;
            }
            if bytes[k] == ESC {
                if k + 1 >= len {
                    // ESC with no following byte yet — incomplete ST.
                    break;
                }
                if bytes[k + 1] == b'\\' {
                    text_end = Some(k);
                    term_end = k + 2;
                    break;
                }
            }
            k += 1;
        }
        match text_end {
            Some(end) => {
                let payload = &input[j + 1..end];
                if code == "0" || code == "2" {
                    *title = Some(sanitize_title(payload));
                } else if code == "9" {
                    if let Some(update) = parse_osc9_4_progress(payload) {
                        *progress = Some(update);
                    }
                }
                i = term_end;
            }
            None => {
                // Unterminated OSC — buffer from ESC and wait for more bytes.
                return bounded_remainder(&input[i..]);
            }
        }
    }
    String::new()
}

fn bounded_remainder(tail: &str) -> String {
    if tail.len() > MAX_REMAINDER {
        String::new()
    } else {
        tail.to_string()
    }
}

/// Parses the payload of an `OSC 9` sequence. Recognizes only the ConEmu
/// progress form `4;<state>[;<percent>]`; returns `None` for any other OSC 9
/// payload (e.g. `OSC 9;<text>` notifications) or an unknown state number.
/// `Some(None)` means state 0 (clear); `Some(Some(p))` an active state.
fn parse_osc9_4_progress(payload: &str) -> Option<Option<TerminalProgress>> {
    let mut parts = payload.split(';');
    if parts.next() != Some("4") {
        return None;
    }
    let state = parts.next()?;
    let percent = parts.next().and_then(|s| s.parse::<u16>().ok());
    let value = || percent.map(|p| p.min(100) as u8);
    match state {
        "0" => Some(None),
        "1" => Some(Some(TerminalProgress {
            state: ProgressState::Normal,
            value: value(),
        })),
        "2" => Some(Some(TerminalProgress {
            state: ProgressState::Error,
            value: None,
        })),
        "3" => Some(Some(TerminalProgress {
            state: ProgressState::Indeterminate,
            value: None,
        })),
        "4" => Some(Some(TerminalProgress {
            state: ProgressState::Warning,
            value: None,
        })),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use climon_proto::meta::{ProgressState, TerminalProgress};

    fn capture(chunk: &[u8]) -> (Option<String>, Option<Option<TerminalProgress>>, String) {
        let mut title = None;
        let mut progress = None;
        let rem = capture_terminal_output(&mut title, &mut progress, chunk, "");
        (title, progress, rem)
    }

    #[test]
    fn parses_osc0_bel_terminated() {
        let (cur, _, rem) = capture(b"\x1b]0;my title\x07");
        assert_eq!(cur.as_deref(), Some("my title"));
        assert_eq!(rem, "");
    }

    #[test]
    fn parses_osc2_st_terminated() {
        let (cur, _, rem) = capture(b"\x1b]2;hello\x1b\\");
        assert_eq!(cur.as_deref(), Some("hello"));
        assert_eq!(rem, "");
    }

    #[test]
    fn ignores_osc1_icon_only() {
        let (cur, _, _) = capture(b"\x1b]1;iconname\x07");
        assert_eq!(cur, None);
    }

    #[test]
    fn ignores_non_title_osc_but_keeps_scanning() {
        // OSC 4 (palette) then OSC 0 (title) in the same chunk.
        let (cur, _, _) = capture(b"\x1b]4;1;rgb:00/00/00\x07\x1b]0;the title\x07");
        assert_eq!(cur.as_deref(), Some("the title"));
    }

    #[test]
    fn last_title_wins_within_chunk() {
        let (cur, _, _) = capture(b"\x1b]0;first\x07\x1b]2;second\x07");
        assert_eq!(cur.as_deref(), Some("second"));
    }

    #[test]
    fn empty_title_clears() {
        let (cur, _, _) = capture(b"\x1b]0;\x07");
        assert_eq!(cur.as_deref(), Some(""));
    }

    #[test]
    fn strips_control_chars_and_caps_length() {
        let (cur, _, _) = capture(b"\x1b]0;ab\x01cd\x07");
        assert_eq!(cur.as_deref(), Some("abcd"));
        let mut long = Vec::from(&b"\x1b]0;"[..]);
        long.extend(vec![b'x'; 300]);
        long.push(BEL);
        let (cur, _, _) = capture(&long);
        assert_eq!(cur.unwrap().len(), MAX_TITLE_LENGTH);
    }

    #[test]
    fn buffers_sequence_split_across_chunks() {
        let mut cur = None;
        let mut progress_unused = None;
        let rem = capture_terminal_output(&mut cur, &mut progress_unused, b"\x1b]0;split", "");
        assert_eq!(cur, None);
        assert_eq!(rem, "\x1b]0;split");
        let rem2 = capture_terminal_output(&mut cur, &mut progress_unused, b"title\x07", &rem);
        assert_eq!(cur.as_deref(), Some("splittitle"));
        assert_eq!(rem2, "");
    }

    #[test]
    fn buffers_lone_trailing_esc() {
        let mut cur = None;
        let mut progress_unused = None;
        let rem = capture_terminal_output(&mut cur, &mut progress_unused, b"data\x1b", "");
        assert_eq!(rem, "\x1b");
        let rem2 = capture_terminal_output(&mut cur, &mut progress_unused, b"]0;t\x07", &rem);
        assert_eq!(cur.as_deref(), Some("t"));
        assert_eq!(rem2, "");
    }

    #[test]
    fn discards_overlong_unterminated_remainder() {
        let mut cur = None;
        let mut progress_unused = None;
        let mut chunk = Vec::from(&b"\x1b]0;"[..]);
        chunk.extend(vec![b'x'; MAX_REMAINDER + 10]);
        let rem = capture_terminal_output(&mut cur, &mut progress_unused, &chunk, "");
        assert_eq!(cur, None);
        assert_eq!(rem, "");
    }

    #[test]
    fn plain_output_yields_no_title_no_remainder() {
        let (cur, _, rem) = capture(b"just normal text\r\n");
        assert_eq!(cur, None);
        assert_eq!(rem, "");
    }

    #[test]
    fn parses_progress_normal_with_percent() {
        let (_, prog, _) = capture(b"\x1b]9;4;1;40\x07");
        assert_eq!(
            prog,
            Some(Some(TerminalProgress {
                state: ProgressState::Normal,
                value: Some(40)
            }))
        );
    }

    #[test]
    fn parses_progress_error_indeterminate_warning() {
        assert_eq!(
            capture(b"\x1b]9;4;2\x07").1,
            Some(Some(TerminalProgress {
                state: ProgressState::Error,
                value: None
            }))
        );
        assert_eq!(
            capture(b"\x1b]9;4;3\x1b\\").1,
            Some(Some(TerminalProgress {
                state: ProgressState::Indeterminate,
                value: None
            }))
        );
        assert_eq!(
            capture(b"\x1b]9;4;4\x07").1,
            Some(Some(TerminalProgress {
                state: ProgressState::Warning,
                value: None
            }))
        );
    }

    #[test]
    fn progress_state_zero_clears() {
        let (_, prog, _) = capture(b"\x1b]9;4;0\x07");
        assert_eq!(prog, Some(None));
    }

    #[test]
    fn progress_percent_clamped_to_100() {
        let (_, prog, _) = capture(b"\x1b]9;4;1;250\x07");
        assert_eq!(
            prog,
            Some(Some(TerminalProgress {
                state: ProgressState::Normal,
                value: Some(100)
            }))
        );
    }

    #[test]
    fn progress_unknown_state_is_ignored() {
        let (_, prog, _) = capture(b"\x1b]9;4;9\x07");
        assert_eq!(prog, None);
    }

    #[test]
    fn osc9_non_progress_subcode_ignored() {
        // OSC 9;<text> (notification) with sub != 4 must not set progress.
        let (_, prog, _) = capture(b"\x1b]9;hello\x07");
        assert_eq!(prog, None);
    }

    #[test]
    fn title_and_progress_in_one_chunk() {
        let (title, prog, _) = capture(b"\x1b]9;4;3\x07\x1b]0;my title\x07");
        assert_eq!(title.as_deref(), Some("my title"));
        assert_eq!(
            prog,
            Some(Some(TerminalProgress {
                state: ProgressState::Indeterminate,
                value: None
            }))
        );
    }

    #[test]
    fn progress_buffered_across_chunks() {
        let mut title = None;
        let mut progress = None;
        // Sequence "\x1b]9;4;1;40\x07" split mid-number: first chunk ends at "4".
        let rem = capture_terminal_output(&mut title, &mut progress, b"\x1b]9;4;1;4", "");
        assert_eq!(
            progress, None,
            "incomplete sequence must not set progress yet"
        );
        assert_eq!(rem, "\x1b]9;4;1;4");
        let rem2 = capture_terminal_output(&mut title, &mut progress, b"0\x07", &rem);
        assert_eq!(
            progress,
            Some(Some(TerminalProgress {
                state: ProgressState::Normal,
                value: Some(40)
            }))
        );
        assert_eq!(rem2, "");
    }

    #[test]
    fn progress_only_chunk_leaves_title_untouched() {
        let mut title = Some("existing".to_string());
        let mut progress = None;
        let rem = capture_terminal_output(&mut title, &mut progress, b"\x1b]9;4;3\x07", "");
        assert_eq!(
            title.as_deref(),
            Some("existing"),
            "progress sequence must not alter title"
        );
        assert_eq!(
            progress,
            Some(Some(TerminalProgress {
                state: ProgressState::Indeterminate,
                value: None
            }))
        );
        assert_eq!(rem, "");
    }
}
