//! Pure user-attention acknowledgement helpers. Ports
//! `fingerprintDimensions` / `shouldApplyUserAttentionAcknowledgement` from
//! `src/daemon/daemon.ts`.

/// Extracts the `{cols}x{rows}` dimension header from a fingerprint, or `None`
/// when the fingerprint has no dimension prefix (legacy format). Mirrors
/// `fingerprintDimensions`.
pub fn fingerprint_dimensions(fp: &str) -> Option<&str> {
    let nl = fp.find('\n')?;
    let header = &fp[..nl];
    if header.contains('x') {
        Some(header)
    } else {
        None
    }
}

/// Decides whether a user (browser) attention acknowledgement should clear the
/// current outstanding attention. The acknowledgement is accepted only when it
/// references the current outstanding attention token *and* the screen has not
/// changed since attention was flagged (a differing dimension header means a
/// resize reflowed the screen, so the content comparison is meaningless and the
/// acknowledgement passes through). Mirrors
/// `shouldApplyUserAttentionAcknowledgement`.
pub fn should_apply_user_attention_acknowledgement(
    last_attention_state: Option<bool>,
    current_attention_matched_at: Option<&str>,
    acknowledged_attention_matched_at: Option<&str>,
    attention_fingerprint: Option<&str>,
    current_fingerprint: &str,
) -> bool {
    if last_attention_state != Some(true)
        || current_attention_matched_at.is_none()
        || acknowledged_attention_matched_at != current_attention_matched_at
        || attention_fingerprint.is_none()
    {
        return false;
    }
    let attention_fp = attention_fingerprint.unwrap();
    let att_dims = fingerprint_dimensions(attention_fp);
    let cur_dims = fingerprint_dimensions(current_fingerprint);
    if let (Some(a), Some(c)) = (att_dims, cur_dims) {
        if a != c {
            return true;
        }
    }
    current_fingerprint == attention_fp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_user_acknowledgement_only_for_the_current_outstanding_attention_token() {
        assert!(should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-2"),
            Some("token-2"),
            Some("fingerprint-2"),
            "fingerprint-2"
        ));
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-2"),
            Some("token-1"),
            Some("fingerprint-2"),
            "fingerprint-2"
        ));
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-2"),
            None,
            Some("fingerprint-2"),
            "fingerprint-2"
        ));
        assert!(!should_apply_user_attention_acknowledgement(
            Some(false),
            Some("token-2"),
            Some("token-2"),
            Some("fingerprint-2"),
            "fingerprint-2"
        ));
        assert!(!should_apply_user_attention_acknowledgement(
            None,
            Some("token-2"),
            Some("token-2"),
            Some("fingerprint-2"),
            "fingerprint-2"
        ));
    }

    #[test]
    fn rejects_stale_acknowledgement_when_the_screen_has_changed_since_attention_was_flagged() {
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-2"),
            Some("token-2"),
            Some("fingerprint-2"),
            "fingerprint-3"
        ));
    }

    #[test]
    fn accepts_acknowledgement_when_dimensions_differ_resize_occurred() {
        let att_fp = "80x24\nhello world";
        let cur_fp = "120x30\nhello world reflowed";
        assert!(should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-1"),
            Some("token-1"),
            Some(att_fp),
            cur_fp
        ));
    }

    #[test]
    fn rejects_acknowledgement_when_dimensions_match_but_content_differs() {
        let att_fp = "80x24\nhello world";
        let cur_fp = "80x24\ngoodbye world";
        assert!(!should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-1"),
            Some("token-1"),
            Some(att_fp),
            cur_fp
        ));
    }

    #[test]
    fn accepts_acknowledgement_when_dimensions_and_content_match() {
        let fp = "80x24\nhello world";
        assert!(should_apply_user_attention_acknowledgement(
            Some(true),
            Some("token-1"),
            Some("token-1"),
            Some(fp),
            fp
        ));
    }

    #[test]
    fn browser_input_transitions_needs_attention_to_acknowledged_before_screen_change() {
        let current_token = "2026-06-13T23:34:00.000Z";
        let attention_fp = "80x24\n$ waiting for input";
        assert!(should_apply_user_attention_acknowledgement(
            Some(true),
            Some(current_token),
            Some(current_token),
            Some(attention_fp),
            attention_fp
        ));
    }

    #[test]
    fn fingerprint_dimensions_extracts_header_or_none() {
        assert_eq!(fingerprint_dimensions("80x24\nbody"), Some("80x24"));
        assert_eq!(fingerprint_dimensions("no-dims-here"), None);
        assert_eq!(fingerprint_dimensions("legacybody\nmore"), None);
    }
}
