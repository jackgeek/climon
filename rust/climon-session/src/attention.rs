//! Pure user-attention acknowledgement helpers.

/// Decides whether a user (browser) attention acknowledgement should clear the
/// current outstanding attention. The acknowledgement is accepted only when
/// attention is currently outstanding, the acknowledgement references the
/// current outstanding attention token (a non-`None` match), and the PTY
/// output generation has not advanced since attention was flagged — new PTY
/// output since flagging means the screen has moved on, so a stale
/// acknowledgement must not clear it.
pub fn should_apply_user_attention_acknowledgement(
    last_attention_state: Option<bool>,
    current_attention_matched_at: Option<&str>,
    acknowledged_attention_matched_at: Option<&str>,
    attention_output_generation: Option<u64>,
    current_output_generation: u64,
) -> bool {
    if last_attention_state != Some(true) {
        return false;
    }
    if current_attention_matched_at.is_none() {
        return false;
    }
    if acknowledged_attention_matched_at != current_attention_matched_at {
        return false;
    }
    match attention_output_generation {
        Some(generation) => generation == current_output_generation,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_current_outstanding_attention_token_with_no_new_output() {
        assert!(should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-2"),
            Some("token-2"),
            Some(5),
            5,
        ));
    }

    #[test]
    fn rejects_a_stale_acknowledgement_token() {
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-2"),
            Some("token-1"),
            Some(5),
            5,
        ));
    }

    #[test]
    fn rejects_when_new_output_arrived_since_attention_was_flagged() {
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-2"),
            Some("token-2"),
            Some(5),
            6,
        ));
    }

    #[test]
    fn rejects_when_attention_is_not_outstanding() {
        assert!(!should_apply_user_attention_acknowledgement(
            Some(false),
            Some("token-2"),
            Some("token-2"),
            Some(5),
            5,
        ));
        assert!(!should_apply_user_attention_acknowledgement(
            None,
            Some("token-2"),
            Some("token-2"),
            Some(5),
            5,
        ));
    }
}
