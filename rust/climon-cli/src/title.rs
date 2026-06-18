//! Terminal title control sequences and the [`TitleController`]. Port of
//! `src/client/title.ts`.

use std::io::Write;

const MAX_TITLE_LENGTH: usize = 256;

/// Removes control characters (which could carry their own escape sequences) and
/// caps length at 256. Mirrors `sanitizeTitle`.
pub fn sanitize_title(name: &str) -> String {
    name.chars()
        .filter(|&c| {
            let code = c as u32;
            !(code <= 0x1f || code == 0x7f)
        })
        .take(MAX_TITLE_LENGTH)
        .collect()
}

/// OSC 0 sets both the icon name and the window/tab title. Mirrors
/// `titleSetSequence`.
pub fn title_set_sequence(name: &str) -> String {
    format!("\x1b]0;{}\x07", sanitize_title(name))
}

/// OSC 0 clear sequence. Mirrors `titleClearSequence`.
pub fn title_clear_sequence() -> String {
    "\x1b]0;\x07".to_string()
}

/// Applies session-name changes to a terminal's title. Tracks whether it has
/// set a title so an empty name (or a detach/exit) only clears a title climon
/// set, never one the user's shell owns. All operations are no-ops on a
/// non-TTY. Mirrors the TS `TitleController`.
pub struct TitleController<W: Write> {
    out: W,
    is_tty: bool,
    title_set: bool,
}

impl<W: Write> TitleController<W> {
    pub fn new(out: W, is_tty: bool) -> Self {
        TitleController {
            out,
            is_tty,
            title_set: false,
        }
    }

    pub fn apply(&mut self, name: &str) {
        if !self.is_tty {
            return;
        }
        let clean = sanitize_title(name);
        if !clean.is_empty() {
            let _ = self.out.write_all(title_set_sequence(&clean).as_bytes());
            let _ = self.out.flush();
            self.title_set = true;
        } else if self.title_set {
            let _ = self.out.write_all(title_clear_sequence().as_bytes());
            let _ = self.out.flush();
            self.title_set = false;
        }
    }

    pub fn clear(&mut self) {
        if !self.is_tty {
            return;
        }
        if self.title_set {
            let _ = self.out.write_all(title_clear_sequence().as_bytes());
            let _ = self.out.flush();
            self.title_set = false;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_strips_control_chars_and_caps_length() {
        assert_eq!(sanitize_title("a\x1bb\x07c"), "abc");
        assert_eq!(sanitize_title("hi\x00\x7fthere"), "hithere");
        let long: String = "x".repeat(300);
        assert_eq!(sanitize_title(&long).len(), MAX_TITLE_LENGTH);
    }

    #[test]
    fn set_sequence_wraps_osc0() {
        assert_eq!(title_set_sequence("dev"), "\x1b]0;dev\x07");
    }

    #[test]
    fn controller_sets_then_clears_only_climon_titles() {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut tc = TitleController::new(&mut buf, true);
            tc.apply("dev");
            tc.apply(""); // clears because we set it
            tc.apply(""); // no-op, nothing set
        }
        assert_eq!(String::from_utf8(buf).unwrap(), "\x1b]0;dev\x07\x1b]0;\x07");
    }

    #[test]
    fn controller_is_noop_on_non_tty() {
        let mut buf: Vec<u8> = Vec::new();
        {
            let mut tc = TitleController::new(&mut buf, false);
            tc.apply("dev");
            tc.clear();
        }
        assert!(buf.is_empty());
    }
}
