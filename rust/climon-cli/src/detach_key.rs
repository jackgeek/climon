//! Renders a control-byte detach prefix as a human-readable key name. Port of
//! `src/client/detach-key.ts`.

/// Renders a control-byte detach prefix as a human-readable key name (e.g. 0x1c
/// -> "Ctrl-\\"). Control bytes are ASCII letter/symbol + 0x40. Non-control
/// bytes fall back to a hex code. Mirrors `describeDetachKey`.
pub fn describe_detach_key(byte: u8) -> String {
    if (0x01..=0x1f).contains(&byte) {
        format!("Ctrl-{}", (byte + 0x40) as char)
    } else {
        format!("0x{byte:02x}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ctrl_backslash() {
        assert_eq!(describe_detach_key(0x1c), "Ctrl-\\");
    }

    #[test]
    fn ctrl_a() {
        assert_eq!(describe_detach_key(0x01), "Ctrl-A");
    }

    #[test]
    fn ctrl_right_bracket() {
        assert_eq!(describe_detach_key(0x1d), "Ctrl-]");
    }

    #[test]
    fn printable_byte_renders_hex() {
        assert_eq!(describe_detach_key(0x41), "0x41");
    }
}
