//! Pure, deterministic fuzzy extraction of the "last relevant paragraph" from
//! the visible terminal grid, for smart attention notifications. No ML: a small
//! set of heuristics (ignore everything at/below the cursor row so the input
//! composer and its help/status bar are skipped, chrome stripping, per-line
//! content scoring, a bottom-up paragraph scan, tail-trim to the notification
//! budget). See
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

/// Modifier / special-key glyphs used in terminal keybinding and help/status
/// bars (e.g. `⌃T`, `⌘K`, `⇧⏎`, `⎋ back`). These effectively never occur in
/// agent prose, so a line containing one is treated as chrome. This is what
/// distinguishes the Copilot/Claude/Codex bottom hint bar (which renders the
/// control glyph `⌃`, not the literal text `ctrl+`) from an actual answer.
fn has_key_hint_glyph(line: &str) -> bool {
    line.chars().any(|c| {
        matches!(
            c,
            '⌃' | '⌘' | '⌥' | '⇧' | '⎈' | '⎋' | '⏎' | '␛' | '⌫' | '⇥' | '⇪'
        )
    })
}

/// Lines that are terminal status affordances, not answer content.
fn is_status_affordance(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    const NEEDLES: [&str; 11] = [
        "tokens",
        "context left",
        "esc to",
        "ctrl+",
        "cmd+",
        "alt+",
        "shift+",
        "press enter",
        "[y/n]",
        "↑/↓",
        "to cancel",
    ];
    if NEEDLES.iter().any(|n| lower.contains(n)) {
        return true;
    }
    // Keybinding / help bars render modifier glyphs (⌃, ⌘, ⇧, …) rather than
    // literal "ctrl+" text, so catch those too.
    if has_key_hint_glyph(line) {
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
    // No whitespace: use max-1 chars so the ellipsis doesn't push past the budget.
    let trimmed: String = chars[chars.len() - (max - 1)..].iter().collect();
    format!("…{trimmed}")
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
/// `lines` (visible grid rows, top to bottom). `cursor_row` is the 0-based row
/// the terminal cursor sits on, when known: the input composer and any
/// help/status bar render at or below it, while the agent's response sits above
/// it, so everything from the cursor row down is ignored. Passing `None` (or a
/// cursor on the top row) scans the whole screen. Returns `None` when no line
/// clears the relevance threshold.
pub fn extract_snippet(lines: &[String], cursor_row: Option<usize>) -> Option<String> {
    // Restrict the search to rows strictly above the cursor when we know where it
    // is. This is the structural signal that keeps bottom chrome (input box, help
    // bar) from winning the bottom-up scan across copilot/claude/codex-style TUIs.
    let limit = match cursor_row {
        Some(row) if row > 0 => row.min(lines.len()),
        _ => lines.len(),
    };
    let lines = &lines[..limit];

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
        let snippet = extract_snippet(&screen, None).expect("expected a snippet");
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
        assert_eq!(extract_snippet(&screen, None), None);
    }

    #[test]
    fn returns_none_for_a_progress_bar_and_blank_screen() {
        let screen = lines(&["", "  [#####     ]  42%", "", ""]);
        assert_eq!(extract_snippet(&screen, None), None);
    }

    #[test]
    fn returns_none_for_an_empty_screen() {
        assert_eq!(extract_snippet(&lines(&["", "", ""]), None), None);
    }

    #[test]
    fn tail_trims_a_long_paragraph_to_the_budget_with_ellipsis() {
        let long = "First sentence that sets up a lot of context and rambles on for a while. \
Second sentence continues with even more filler words to push us well past the limit. \
Finally, should I deploy the release now?";
        let snippet = extract_snippet(&lines(&[long]), None).expect("expected a snippet");
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
        let snippet = extract_snippet(&screen, None).expect("expected a snippet");
        assert_eq!(snippet, "Deployment finished with no errors.");
    }

    #[test]
    fn skips_a_keybinding_help_bar_below_the_input_box() {
        // Reproduces the Copilot/Claude/Codex-style bottom chrome: the agent's
        // answer sits above the input composer box, and a keybinding/help bar
        // (rendered with ⌃ modifier glyphs) sits below it. The snippet must come
        // from the answer, not the hint bar. The reported bug surfaced the bar
        // ("… ⌃T show reasoning · Claude Opus 4") instead of the response.
        let screen = lines(&[
            "  Done — I've updated the config and all checks pass.",
            "  Want me to open a pull request?",
            "",
            "╭─────────────────────────────────────────────────╮",
            "│ >                                                 │",
            "╰─────────────────────────────────────────────────╯",
            "  / commands   ? help   ⌃T show reasoning · Claude Opus 4",
        ]);
        // No cursor supplied: the glyph-based affordance detection alone must keep
        // the hint bar out of the snippet.
        let snippet = extract_snippet(&screen, None).expect("expected a snippet");
        assert!(
            snippet.contains("Want me to open a pull request?"),
            "got: {snippet:?}"
        );
        assert!(
            !snippet.contains("show reasoning") && !snippet.contains("commands"),
            "help bar leaked into snippet: {snippet:?}"
        );
    }

    #[test]
    fn cursor_row_excludes_the_input_box_and_help_bar_below_it() {
        // The structural fix: the cursor sits inside the input composer, so the
        // extractor ignores every row from the cursor down — even a hint bar that
        // slipped past the affordance heuristics cannot be selected.
        let screen = lines(&[
            "  The deploy succeeded and traffic looks healthy.",
            "",
            "╭───────────────────────────────╮",
            "│ >                             │",
            "╰───────────────────────────────╯",
            "  some hint bar that scores as prose without any glyph markers",
        ]);
        // Cursor on the input row (index 3).
        let snippet = extract_snippet(&screen, Some(3)).expect("expected a snippet");
        assert!(
            snippet.contains("The deploy succeeded and traffic looks healthy."),
            "got: {snippet:?}"
        );
        assert!(!snippet.contains("hint bar"), "chrome leaked: {snippet:?}");
    }

    #[test]
    fn cursor_on_the_top_row_falls_back_to_the_whole_screen() {
        // A cursor at row 0 has nothing above it; the scan must still find prose.
        let screen = lines(&["  All set — the migration ran cleanly."]);
        let snippet = extract_snippet(&screen, Some(0)).expect("expected a snippet");
        assert_eq!(snippet, "All set — the migration ran cleanly.");
    }

    #[test]
    fn treats_modifier_key_glyphs_as_chrome() {
        // A lone keybinding hint bar has no answer to fall back to.
        let screen = lines(&["  ⇧⏎ newline   ⌘K clear   ⌥←/→ jump   ⌃C quit"]);
        assert_eq!(extract_snippet(&screen, None), None);
    }

    #[test]
    fn skips_trailing_affordances_to_reach_the_answer() {
        let screen = lines(&[
            "  Applied 3 edits and the build is green.",
            "  Press enter to continue   esc to cancel",
        ]);
        let snippet = extract_snippet(&screen, None).expect("expected a snippet");
        assert_eq!(snippet, "Applied 3 edits and the build is green.");
    }

    #[test]
    fn trim_tail_no_whitespace_fallback_respects_max_chars() {
        // A ≥160-char no-whitespace token that clears the threshold should produce
        // a snippet whose total length (including the leading ellipsis) is ≤160 chars.
        let long_token = "a".repeat(200);
        let snippet = extract_snippet(&lines(&[&long_token]), None).expect("expected a snippet");
        assert!(
            snippet.chars().count() <= SNIPPET_MAX_CHARS,
            "got {} chars: {snippet:?}",
            snippet.chars().count()
        );
        assert!(
            snippet.starts_with('…'),
            "expected leading ellipsis, got: {snippet:?}"
        );
    }
}
