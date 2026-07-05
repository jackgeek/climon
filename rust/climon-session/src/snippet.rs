//! Pure, deterministic fuzzy extraction of the "last relevant paragraph" from
//! the visible terminal grid, for smart attention notifications. No ML: a small
//! set of heuristics (chrome stripping, per-line content scoring, a bottom-up
//! paragraph scan, tail-trim to the notification budget). See
//! `docs/superpowers/specs/2026-07-05-smart-notifications-design.md`.

/// Max characters in the emitted snippet — the Apple Watch long-look safe zone.
pub const SNIPPET_MAX_CHARS: usize = 160;

/// Minimum content score for a cleaned line to count as prose (0.0–1.0).
const RELEVANCE_THRESHOLD: f32 = 0.45;

/// Box-drawing / block glyphs that form terminal UI chrome.
fn is_box_char(c: char) -> bool {
    matches!(
        c,
        '│' | '┃'
            | '║'
            | '╎'
            | '┆'
            | '┊'
            | '─'
            | '━'
            | '═'
            | '╌'
            | '┄'
            | '╭'
            | '╮'
            | '╰'
            | '╯'
            | '┌'
            | '┐'
            | '└'
            | '┘'
            | '├'
            | '┤'
            | '┬'
            | '┴'
            | '┼'
            | '▌'
            | '▐'
            | '█'
            | '▁'
            | '▔'
            | '░'
            | '▒'
            | '▓'
    )
}

/// Leading prompt sigils to drop from a line's start.
const SIGILS: [char; 8] = ['>', '❯', '$', '#', '?', '●', '•', '➜'];

fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Removes box chars, a leading prompt sigil, and collapses whitespace.
fn clean_line(line: &str) -> String {
    let replaced: String = line
        .chars()
        .map(|c| if is_box_char(c) { ' ' } else { c })
        .collect();
    let mut s = collapse_ws(replaced.trim());
    // Drop a single leading sigil if it stands alone or precedes a space.
    if let Some(first) = s.chars().next() {
        if SIGILS.contains(&first) {
            let rest: String = s.chars().skip(1).collect();
            if rest.is_empty() || rest.starts_with(' ') {
                s = rest.trim_start().to_string();
            }
        }
    }
    s
}

/// Lines that are terminal status affordances, not answer content.
fn is_status_affordance(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    const NEEDLES: [&str; 8] = [
        "tokens",
        "context left",
        "esc to",
        "ctrl+",
        "press enter",
        "[y/n]",
        "↑/↓",
        "to cancel",
    ];
    if NEEDLES.iter().any(|n| lower.contains(n)) {
        return true;
    }
    // A line that is only a bracketed progress bar / percentage.
    let trimmed = line.trim();
    if trimmed.ends_with('%') && trimmed.chars().filter(|c| c.is_alphabetic()).count() == 0 {
        return true;
    }
    false
}

/// Scores a cleaned line 0.0–1.0 for how much it looks like prose content.
fn content_score(line: &str) -> f32 {
    if line.is_empty() || is_status_affordance(line) {
        return 0.0;
    }
    let total = line.chars().count() as f32;
    let alnum = line.chars().filter(|c| c.is_alphanumeric()).count() as f32;
    let density = alnum / total;
    let words = line
        .split_whitespace()
        .filter(|w| w.chars().any(|c| c.is_alphabetic()))
        .count();
    let mut score = density * 0.6;
    if words >= 3 {
        score += 0.3;
    } else if words == 2 {
        score += 0.15;
    }
    if line.ends_with(['.', '!', '?', ':']) {
        score += 0.15;
    }
    score.min(1.0)
}

/// Keeps the last `max` chars, snapping to a sentence then word boundary and
/// prefixing an ellipsis when truncated.
fn trim_tail(text: &str, max: usize) -> String {
    let chars: Vec<char> = text.chars().collect();
    if chars.len() <= max {
        return text.to_string();
    }
    let window: String = chars[chars.len() - max..].iter().collect();
    // Sentence boundary: first ". " / "! " / "? " inside the window.
    let mut sentence_start: Option<usize> = None;
    let bytes = window.as_bytes();
    for i in 0..bytes.len().saturating_sub(1) {
        if matches!(bytes[i], b'.' | b'!' | b'?') && bytes[i + 1] == b' ' {
            sentence_start = Some(i + 2);
            break;
        }
    }
    if let Some(pos) = sentence_start {
        let rest = window[pos..].trim_start();
        if rest.chars().count() >= 20 {
            return format!("…{rest}");
        }
    }
    // Word boundary: first space in the window.
    if let Some(pos) = window.find(' ') {
        return format!("…{}", window[pos..].trim_start());
    }
    format!("…{window}")
}

/// Strips control characters and forces a single trimmed line.
fn sanitize(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .filter(|&c| {
            let code = c as u32;
            !((code <= 0x1f && c != ' ') || code == 0x7f)
        })
        .collect();
    collapse_ws(cleaned.trim())
}

/// Extracts a ≤`SNIPPET_MAX_CHARS` snippet of the last relevant paragraph from
/// `lines` (visible grid rows, top to bottom). Returns `None` when no line
/// clears the relevance threshold.
pub fn extract_snippet(lines: &[String]) -> Option<String> {
    let cleaned: Vec<String> = lines.iter().map(|l| clean_line(l)).collect();
    let scores: Vec<f32> = cleaned.iter().map(|l| content_score(l)).collect();

    let end = (0..cleaned.len())
        .rev()
        .find(|&i| scores[i] >= RELEVANCE_THRESHOLD)?;
    let mut start = end;
    while start > 0 && scores[start - 1] >= RELEVANCE_THRESHOLD {
        start -= 1;
    }
    let paragraph = collapse_ws(&cleaned[start..=end].join(" "));
    let snippet = sanitize(&trim_tail(&paragraph, SNIPPET_MAX_CHARS));
    if snippet.is_empty() {
        None
    } else {
        Some(snippet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lines(rows: &[&str]) -> Vec<String> {
        rows.iter().map(|r| r.to_string()).collect()
    }

    #[test]
    fn extracts_last_prose_paragraph_from_a_copilot_style_screen() {
        let screen = lines(&[
            "  I've refactored the auth module and all 12 tests pass.",
            "  Want me to also update the integration tests?",
            "",
            "╭─────────────────────────────────────────╮",
            "│ >                                         │",
            "╰─────────────────────────────────────────╯",
            "  ⏎ send   ⌃C quit   1.2k tokens",
        ]);
        let snippet = extract_snippet(&screen).expect("expected a snippet");
        assert!(
            snippet.contains("Want me to also update the integration tests?"),
            "got: {snippet:?}"
        );
        assert!(snippet.contains("all 12 tests pass"), "got: {snippet:?}");
        assert!(snippet.chars().count() <= SNIPPET_MAX_CHARS);
    }

    #[test]
    fn returns_none_for_a_spinner_only_screen() {
        let screen = lines(&["", "  ⠹ Thinking… 3.1k tokens", ""]);
        assert_eq!(extract_snippet(&screen), None);
    }

    #[test]
    fn returns_none_for_a_progress_bar_and_blank_screen() {
        let screen = lines(&["", "  [#####     ]  42%", "", ""]);
        assert_eq!(extract_snippet(&screen), None);
    }

    #[test]
    fn returns_none_for_an_empty_screen() {
        assert_eq!(extract_snippet(&lines(&["", "", ""])), None);
    }

    #[test]
    fn tail_trims_a_long_paragraph_to_the_budget_with_ellipsis() {
        let long = "First sentence that sets up a lot of context and rambles on for a while. \
Second sentence continues with even more filler words to push us well past the limit. \
Finally, should I deploy the release now?";
        let snippet = extract_snippet(&lines(&[long])).expect("expected a snippet");
        assert!(snippet.chars().count() <= SNIPPET_MAX_CHARS);
        assert!(
            snippet.starts_with('…'),
            "expected leading ellipsis, got: {snippet:?}"
        );
        assert!(
            snippet.ends_with("should I deploy the release now?"),
            "got: {snippet:?}"
        );
    }

    #[test]
    fn strips_box_borders_and_prompt_sigils() {
        let screen = lines(&["│ Deployment finished with no errors. │", "> "]);
        let snippet = extract_snippet(&screen).expect("expected a snippet");
        assert_eq!(snippet, "Deployment finished with no errors.");
    }

    #[test]
    fn skips_trailing_affordances_to_reach_the_answer() {
        let screen = lines(&[
            "  Applied 3 edits and the build is green.",
            "  Press enter to continue   esc to cancel",
        ]);
        let snippet = extract_snippet(&screen).expect("expected a snippet");
        assert_eq!(snippet, "Applied 3 edits and the build is green.");
    }
}
