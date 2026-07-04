//! Observes OSC window-title sequences (`OSC 0;…` icon+title and `OSC 2;…`
//! title) emitted by programs inside the PTY, so climon can surface the current
//! terminal title as a per-session subtitle. The parser only *reads* the output
//! stream — bytes are always passed through to the terminal unchanged.

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
/// `OSC 0;<text>` / `OSC 2;<text>` sequences terminated by BEL (`\x07`) or
/// ST (`\x1b\`). When one or more complete title sequences are found, `current`
/// is updated to the sanitized text of the *last* one (an empty title clears it
/// to `Some(String::new())`). Returns the new remainder holding a trailing
/// incomplete escape sequence (bounded by `MAX_REMAINDER`; discarded if longer).
/// `OSC 1` (icon only) and all other OSC codes are ignored but still skipped
/// over so they never confuse title detection.
pub fn capture_terminal_title_from_output(
    current: &mut Option<String>,
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
                if code == "0" || code == "2" {
                    *current = Some(sanitize_title(&input[j + 1..end]));
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

#[cfg(test)]
mod tests {
    use super::*;

    fn capture(chunk: &[u8]) -> (Option<String>, String) {
        let mut cur = None;
        let rem = capture_terminal_title_from_output(&mut cur, chunk, "");
        (cur, rem)
    }

    #[test]
    fn parses_osc0_bel_terminated() {
        let (cur, rem) = capture(b"\x1b]0;my title\x07");
        assert_eq!(cur.as_deref(), Some("my title"));
        assert_eq!(rem, "");
    }

    #[test]
    fn parses_osc2_st_terminated() {
        let (cur, rem) = capture(b"\x1b]2;hello\x1b\\");
        assert_eq!(cur.as_deref(), Some("hello"));
        assert_eq!(rem, "");
    }

    #[test]
    fn ignores_osc1_icon_only() {
        let (cur, _) = capture(b"\x1b]1;iconname\x07");
        assert_eq!(cur, None);
    }

    #[test]
    fn ignores_non_title_osc_but_keeps_scanning() {
        // OSC 4 (palette) then OSC 0 (title) in the same chunk.
        let (cur, _) = capture(b"\x1b]4;1;rgb:00/00/00\x07\x1b]0;the title\x07");
        assert_eq!(cur.as_deref(), Some("the title"));
    }

    #[test]
    fn last_title_wins_within_chunk() {
        let (cur, _) = capture(b"\x1b]0;first\x07\x1b]2;second\x07");
        assert_eq!(cur.as_deref(), Some("second"));
    }

    #[test]
    fn empty_title_clears() {
        let (cur, _) = capture(b"\x1b]0;\x07");
        assert_eq!(cur.as_deref(), Some(""));
    }

    #[test]
    fn strips_control_chars_and_caps_length() {
        let (cur, _) = capture(b"\x1b]0;ab\x01cd\x07");
        assert_eq!(cur.as_deref(), Some("abcd"));
        let mut long = Vec::from(&b"\x1b]0;"[..]);
        long.extend(std::iter::repeat(b'x').take(300));
        long.push(BEL);
        let (cur, _) = capture(&long);
        assert_eq!(cur.unwrap().len(), MAX_TITLE_LENGTH);
    }

    #[test]
    fn buffers_sequence_split_across_chunks() {
        let mut cur = None;
        let rem = capture_terminal_title_from_output(&mut cur, b"\x1b]0;split", "");
        assert_eq!(cur, None);
        assert_eq!(rem, "\x1b]0;split");
        let rem2 = capture_terminal_title_from_output(&mut cur, b"title\x07", &rem);
        assert_eq!(cur.as_deref(), Some("splittitle"));
        assert_eq!(rem2, "");
    }

    #[test]
    fn buffers_lone_trailing_esc() {
        let mut cur = None;
        let rem = capture_terminal_title_from_output(&mut cur, b"data\x1b", "");
        assert_eq!(rem, "\x1b");
        let rem2 = capture_terminal_title_from_output(&mut cur, b"]0;t\x07", &rem);
        assert_eq!(cur.as_deref(), Some("t"));
        assert_eq!(rem2, "");
    }

    #[test]
    fn discards_overlong_unterminated_remainder() {
        let mut cur = None;
        let mut chunk = Vec::from(&b"\x1b]0;"[..]);
        chunk.extend(std::iter::repeat(b'x').take(MAX_REMAINDER + 10));
        let rem = capture_terminal_title_from_output(&mut cur, &chunk, "");
        assert_eq!(cur, None);
        assert_eq!(rem, "");
    }

    #[test]
    fn plain_output_yields_no_title_no_remainder() {
        let (cur, rem) = capture(b"just normal text\r\n");
        assert_eq!(cur, None);
        assert_eq!(rem, "");
    }
}
