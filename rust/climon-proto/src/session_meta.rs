//! Color/priority constants and parsers. 1:1 port of `src/session-meta.ts`.

use crate::meta::AnsiColor;

/// The 8 standard colors in canonical order.
pub const ANSI_COLORS: [AnsiColor; 8] = AnsiColor::ALL;

/// Auto-assignment priority order (most-distinct first).
pub const AUTO_COLOR_ORDER: [AnsiColor; 8] = [
    AnsiColor::White,
    AnsiColor::Cyan,
    AnsiColor::Magenta,
    AnsiColor::Blue,
    AnsiColor::Yellow,
    AnsiColor::Green,
    AnsiColor::Red,
    AnsiColor::Black,
];

/// Effective priority used for sorting when the field is absent.
pub const DEFAULT_PRIORITY: u16 = 500;

/// A parsed color mode for session creation/defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ColorMode {
    Auto,
    None,
    Color(AnsiColor),
}

fn color_names() -> String {
    AnsiColor::ALL
        .iter()
        .map(|c| c.name())
        .collect::<Vec<_>>()
        .join(", ")
}

/// Parses/validates a priority into an integer in 0..=1000. Mirrors `parsePriority`,
/// which coerces via JS `Number(value.trim())`: an empty/whitespace string becomes
/// `0`, and integer values may be written in decimal or scientific notation (e.g.
/// "1e3"). The value must then be a finite integer in range. (JS's hex/octal/binary
/// literal coercion, e.g. `Number("0x10")`, is intentionally not replicated — a
/// priority is a plain 0–1000 integer.)
pub fn parse_priority(value: &str) -> Result<u16, String> {
    let trimmed = value.trim();
    let n = if trimmed.is_empty() {
        0.0
    } else {
        trimmed.parse::<f64>().map_err(|_| {
            format!("Priority must be an integer between 0 and 1000 (got \"{value}\").")
        })?
    };
    if !n.is_finite() || n.fract() != 0.0 {
        return Err(format!(
            "Priority must be an integer between 0 and 1000 (got \"{value}\")."
        ));
    }
    if !(0.0..=1000.0).contains(&n) {
        return Err(format!(
            "Priority must be between 0 and 1000 (got \"{value}\")."
        ));
    }
    Ok(n as u16)
}

/// Parses a color name; `none`/empty -> `None` (clear). Mirrors `parseColor`.
pub fn parse_color(value: &str) -> Result<Option<AnsiColor>, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized.is_empty() || normalized == "none" {
        return Ok(None);
    }
    AnsiColor::from_name(&normalized).map(Some).ok_or_else(|| {
        format!(
            "Color must be one of: none, {} (got \"{value}\").",
            color_names()
        )
    })
}

/// Parses a color mode (`auto`/`none`/color). Mirrors `parseColorMode`.
pub fn parse_color_mode(value: &str) -> Result<ColorMode, String> {
    let normalized = value.trim().to_ascii_lowercase();
    if normalized == "auto" {
        return Ok(ColorMode::Auto);
    }
    if normalized == "none" {
        return Ok(ColorMode::None);
    }
    AnsiColor::from_name(&normalized)
        .map(ColorMode::Color)
        .ok_or_else(|| {
            format!(
                "Color must be one of: auto, none, {} (got \"{value}\").",
                color_names()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::meta::AnsiColor;

    #[test]
    fn ansi_colors_is_the_8_standard_colors_in_order() {
        assert_eq!(
            ANSI_COLORS,
            [
                AnsiColor::Black,
                AnsiColor::Red,
                AnsiColor::Green,
                AnsiColor::Yellow,
                AnsiColor::Blue,
                AnsiColor::Magenta,
                AnsiColor::Cyan,
                AnsiColor::White,
            ]
        );
    }

    #[test]
    fn auto_color_order_uses_required_priority_order() {
        assert_eq!(
            AUTO_COLOR_ORDER,
            [
                AnsiColor::White,
                AnsiColor::Cyan,
                AnsiColor::Magenta,
                AnsiColor::Blue,
                AnsiColor::Yellow,
                AnsiColor::Green,
                AnsiColor::Red,
                AnsiColor::Black,
            ]
        );
    }

    #[test]
    fn parse_priority_accepts_integers_within_range() {
        assert_eq!(parse_priority("0").unwrap(), 0);
        assert_eq!(parse_priority("500").unwrap(), 500);
        assert_eq!(parse_priority("1000").unwrap(), 1000);
        assert_eq!(parse_priority("750").unwrap(), 750);
    }

    #[test]
    fn parse_priority_rejects_out_of_range_and_non_integers() {
        assert!(parse_priority("-1").unwrap_err().contains("0 and 1000"));
        assert!(parse_priority("1001").unwrap_err().contains("0 and 1000"));
        assert!(parse_priority("12.5").unwrap_err().contains("integer"));
        assert!(parse_priority("abc").unwrap_err().contains("integer"));
    }

    #[test]
    fn parse_priority_matches_js_number_coercion() {
        // Mirror TS `Number(value.trim())`: empty/whitespace coerces to 0, and
        // integer values may be written as decimals or scientific notation.
        assert_eq!(parse_priority("").unwrap(), 0);
        assert_eq!(parse_priority("   ").unwrap(), 0);
        assert_eq!(parse_priority("1.0").unwrap(), 1);
        assert_eq!(parse_priority("500.0").unwrap(), 500);
        assert_eq!(parse_priority("1e3").unwrap(), 1000);
        assert_eq!(parse_priority("1e2").unwrap(), 100);
        // Non-integer and non-finite forms remain rejected.
        assert!(parse_priority("1.5").is_err());
        assert!(parse_priority("Infinity").is_err());
        assert!(parse_priority("NaN").is_err());
    }

    #[test]
    fn parse_color_accepts_names_case_insensitively() {
        assert_eq!(parse_color("red").unwrap(), Some(AnsiColor::Red));
        assert_eq!(parse_color("CYAN").unwrap(), Some(AnsiColor::Cyan));
    }

    #[test]
    fn parse_color_treats_none_and_empty_as_null() {
        assert_eq!(parse_color("none").unwrap(), None);
        assert_eq!(parse_color("").unwrap(), None);
    }

    #[test]
    fn parse_color_rejects_unknown_colors() {
        assert!(parse_color("orange")
            .unwrap_err()
            .contains("must be one of"));
    }

    #[test]
    fn parse_color_mode_accepts_auto_none_and_colors() {
        assert_eq!(parse_color_mode("Auto").unwrap(), ColorMode::Auto);
        assert_eq!(parse_color_mode("none").unwrap(), ColorMode::None);
        assert_eq!(
            parse_color_mode("CYAN").unwrap(),
            ColorMode::Color(AnsiColor::Cyan)
        );
    }

    #[test]
    fn parse_color_mode_rejects_unknown() {
        assert!(parse_color_mode("orange")
            .unwrap_err()
            .contains("must be one of"));
    }
}
