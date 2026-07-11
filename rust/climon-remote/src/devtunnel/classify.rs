use super::types::{
    DevtunnelErrorCode, DevtunnelFailure, DevtunnelFailureInput, DevtunnelOperation,
    DevtunnelRetryClass,
};

pub fn classify_failure(input: &DevtunnelFailureInput, now: &str) -> DevtunnelFailure {
    let output = format!("{}\n{}", input.stdout, input.stderr)
        .trim()
        .to_string();
    let lower = output.to_lowercase();
    let retry_after_ms = parse_retry_after_ms(&lower);

    let (code, summary, remediation, retry_class, retryable) = if input.spawn_error.as_deref()
        == Some("ENOENT")
        || input.status == 127
    {
        (
            DevtunnelErrorCode::CliMissing,
            "Microsoft Dev Tunnels is not installed.",
            "Install Dev Tunnels using the climon README instructions, then retry.",
            DevtunnelRetryClass::Actionable,
            false,
        )
    } else if input.parse_failed.unwrap_or(false) {
        (
            DevtunnelErrorCode::InvalidOutput,
            "Climon could not understand the Dev Tunnels response.",
            "Update the `devtunnel` CLI and retry.",
            DevtunnelRetryClass::Unknown,
            false,
        )
    } else if contains_space_pattern(&lower, &["not", "logged", "in"])
        || contains_space_pattern(&lower, &["not", "authenticated"])
    {
        (
            DevtunnelErrorCode::NotAuthenticated,
            "Microsoft Dev Tunnels is not signed in.",
            "Run `devtunnel user login`, then retry.",
            DevtunnelRetryClass::Actionable,
            false,
        )
    } else if contains_any(
        &lower,
        &[
            "too many tunnels",
            "maximum number of tunnels",
            "tunnel quota",
        ],
    ) {
        (
            DevtunnelErrorCode::TunnelQuotaExhausted,
            "Climon could not create a dev tunnel because this account already has too many tunnels.",
            "Run `devtunnel list`, delete an unused tunnel manually, then retry.",
            DevtunnelRetryClass::Actionable,
            false,
        )
    } else if has_standalone_number(&lower, "429")
        || contains_any(&lower, &["too many requests", "rate limit"])
    {
        (
            DevtunnelErrorCode::RateLimited,
            "Microsoft Dev Tunnels is temporarily rate limiting requests.",
            "Wait for the retry timer or retry later.",
            DevtunnelRetryClass::Transient,
            true,
        )
    } else if has_standalone_number(&lower, "403")
        || contains_any(
            &lower,
            &["forbidden", "does not have access", "permission denied"],
        )
    {
        (
            DevtunnelErrorCode::PermissionDenied,
            "This identity does not have permission to use the requested dev tunnel.",
            "Sign in with an authorized identity or update the tunnel access list, then retry.",
            DevtunnelRetryClass::Actionable,
            false,
        )
    } else if has_standalone_number(&lower, "404")
        || contains_any(&lower, &["not found", "no tunnel"])
        || contains_space_pattern(&lower, &["does", "not", "exist"])
    {
        (
            DevtunnelErrorCode::TunnelNotFound,
            "The saved dev tunnel no longer exists.",
            "Retry so Climon can recreate or rediscover the tunnel.",
            DevtunnelRetryClass::Permanent,
            false,
        )
    } else if contains_any(&lower, &["conflict"])
        || contains_space_pattern(&lower, &["already", "exists"])
    {
        (
            DevtunnelErrorCode::PortConflict,
            "The dev tunnel port mapping already exists.",
            "Climon will reuse the existing mapping.",
            DevtunnelRetryClass::Permanent,
            false,
        )
    } else if contains_any(
        &lower,
        &[
            "name or service not known",
            "network is unreachable",
            "connection refused",
            "dns",
        ],
    ) {
        (
            DevtunnelErrorCode::NetworkUnavailable,
            "Climon could not reach Microsoft Dev Tunnels.",
            "Check the network connection; Climon will retry automatically.",
            DevtunnelRetryClass::Transient,
            true,
        )
    } else if has_standalone_50x(&lower)
        || contains_any(&lower, &["service unavailable", "temporarily unavailable"])
    {
        (
            DevtunnelErrorCode::ServiceUnavailable,
            "Microsoft Dev Tunnels is temporarily unavailable.",
            "Climon will retry automatically.",
            DevtunnelRetryClass::Transient,
            true,
        )
    } else if matches!(
        input.operation,
        DevtunnelOperation::HostTunnel | DevtunnelOperation::ConnectTunnel
    ) {
        (
            DevtunnelErrorCode::ProcessExited,
            "The dev tunnel process stopped unexpectedly.",
            "Climon will retry automatically.",
            DevtunnelRetryClass::Transient,
            true,
        )
    } else {
        (
            DevtunnelErrorCode::Unknown,
            "Microsoft Dev Tunnels could not complete the operation.",
            "Review the technical details and retry.",
            DevtunnelRetryClass::Unknown,
            false,
        )
    };

    let detail_source = if output.is_empty() {
        format!("exit status {}", input.status)
    } else {
        output
    };

    DevtunnelFailure {
        code,
        operation: input.operation.clone(),
        summary: summary.to_string(),
        remediation: remediation.to_string(),
        technical_detail: sanitize_technical_detail(&detail_source),
        occurred_at: now.to_string(),
        retry_class,
        retryable,
        retry_after_ms,
        status: Some(input.status),
    }
}

fn contains_any(haystack: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| haystack.contains(needle))
}

fn contains_space_pattern(haystack: &str, words: &[&str]) -> bool {
    let mut search_start = 0;
    while let Some(offset) = haystack[search_start..].find(words[0]) {
        let mut index = search_start + offset + words[0].len();
        let mut matched = true;
        for word in &words[1..] {
            let whitespace_start = index;
            while index < haystack.len() && haystack.as_bytes()[index].is_ascii_whitespace() {
                index += 1;
            }
            if index == whitespace_start || !haystack[index..].starts_with(word) {
                matched = false;
                break;
            }
            index += word.len();
        }
        if matched {
            return true;
        }
        search_start += offset + words[0].len();
    }
    false
}

fn has_standalone_50x(input: &str) -> bool {
    ["502", "503", "504"]
        .iter()
        .any(|number| has_standalone_number(input, number))
}

fn has_standalone_number(input: &str, number: &str) -> bool {
    let mut start = 0;
    while let Some(offset) = input[start..].find(number) {
        let index = start + offset;
        let before_is_digit = index > 0 && input.as_bytes()[index - 1].is_ascii_digit();
        let after = index + number.len();
        let after_is_digit = after < input.len() && input.as_bytes()[after].is_ascii_digit();
        if !before_is_digit && !after_is_digit {
            return true;
        }
        start = after;
    }
    false
}

fn parse_retry_after_ms(input: &str) -> Option<u64> {
    let mut start = 0;
    while let Some(offset) = input[start..].find("retry-after") {
        let mut index = start + offset + "retry-after".len();
        let mut seen_separator = false;
        while index < input.len() {
            let byte = input.as_bytes()[index];
            if byte == b':' || byte.is_ascii_whitespace() {
                seen_separator = true;
                index += 1;
            } else {
                break;
            }
        }
        if !seen_separator {
            start = index;
            continue;
        }
        let digit_start = index;
        while index < input.len() && input.as_bytes()[index].is_ascii_digit() {
            index += 1;
        }
        if index > digit_start {
            return input[digit_start..index]
                .parse::<u64>()
                .ok()
                .map(|seconds| seconds.saturating_mul(1000));
        }
        start = index;
    }
    None
}

fn sanitize_technical_detail(input: &str) -> String {
    let sanitized = replace_long_tokens(&replace_ipv4(&replace_uuids(&replace_emails(
        &replace_urls(input),
    ))));
    truncate_diagnostic(&sanitized)
}

fn replace_urls(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if let Some(end) = url_end_at(input, index) {
            output.push_str("<url>");
            index = end;
        } else {
            let ch = input[index..].chars().next().expect("valid char");
            output.push(ch);
            index += ch.len_utf8();
        }
        while index < bytes.len() && !input.is_char_boundary(index) {
            index += 1;
        }
    }
    output
}

fn url_end_at(input: &str, start: usize) -> Option<usize> {
    let rest = &input[start..];
    let scheme_end = rest.find("://")?;
    if scheme_end == 0 {
        return None;
    }
    let scheme = &rest[..scheme_end];
    let mut chars = scheme.chars();
    if !chars.next()?.is_ascii_alphabetic()
        || !chars.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
    {
        return None;
    }
    let after_scheme = start + scheme_end + 3;
    if after_scheme >= input.len() {
        return None;
    }
    Some(
        input[after_scheme..]
            .find(char::is_whitespace)
            .map_or(input.len(), |offset| after_scheme + offset),
    )
}

fn replace_emails(input: &str) -> String {
    replace_spans(input, email_end_at, "<email>")
}

fn email_end_at(input: &str, start: usize) -> Option<usize> {
    if start > 0 && is_email_char(input.as_bytes()[start - 1]) {
        return None;
    }
    let bytes = input.as_bytes();
    let mut index = start;
    let local_start = index;
    while index < bytes.len() && is_email_local_char(bytes[index]) {
        index += 1;
    }
    if index == local_start || index >= bytes.len() || bytes[index] != b'@' {
        return None;
    }
    index += 1;
    let domain_start = index;
    let mut has_dot = false;
    while index < bytes.len() && is_email_domain_char(bytes[index]) {
        if bytes[index] == b'.' {
            has_dot = true;
        }
        index += 1;
    }
    if index == domain_start || !has_dot || index - domain_start < 3 {
        return None;
    }
    if index < bytes.len() && is_email_char(bytes[index]) {
        return None;
    }
    Some(index)
}

fn replace_uuids(input: &str) -> String {
    replace_spans(input, uuid_end_at, "<id>")
}

fn uuid_end_at(input: &str, start: usize) -> Option<usize> {
    const GROUPS: [usize; 5] = [8, 4, 4, 4, 12];
    if start > 0 && is_hex(input.as_bytes()[start - 1]) {
        return None;
    }
    let bytes = input.as_bytes();
    let mut index = start;
    for (group_index, group_len) in GROUPS.iter().enumerate() {
        for _ in 0..*group_len {
            if index >= bytes.len() || !is_hex(bytes[index]) {
                return None;
            }
            index += 1;
        }
        if group_index < GROUPS.len() - 1 {
            if index >= bytes.len() || bytes[index] != b'-' {
                return None;
            }
            index += 1;
        }
    }
    if index < bytes.len() && is_hex(bytes[index]) {
        return None;
    }
    Some(index)
}

fn replace_ipv4(input: &str) -> String {
    replace_spans(input, ipv4_end_at, "<ip>")
}

fn ipv4_end_at(input: &str, start: usize) -> Option<usize> {
    if start > 0 && input.as_bytes()[start - 1].is_ascii_digit() {
        return None;
    }
    let bytes = input.as_bytes();
    let mut index = start;
    for segment_index in 0..4 {
        let segment_start = index;
        while index < bytes.len() && bytes[index].is_ascii_digit() && index - segment_start < 3 {
            index += 1;
        }
        if index == segment_start {
            return None;
        }
        let segment: u16 = input[segment_start..index].parse().ok()?;
        if segment > 255 {
            return None;
        }
        if segment_index < 3 {
            if index >= bytes.len() || bytes[index] != b'.' {
                return None;
            }
            index += 1;
        }
    }
    if index < bytes.len() && bytes[index].is_ascii_digit() {
        return None;
    }
    if index < bytes.len() && bytes[index] == b':' {
        let port_start = index + 1;
        index = port_start;
        while index < bytes.len() && bytes[index].is_ascii_digit() {
            index += 1;
        }
        if index == port_start {
            index = port_start - 1;
        }
    }
    Some(index)
}

fn replace_long_tokens(input: &str) -> String {
    replace_spans(input, long_token_end_at, "<id>")
}

fn long_token_end_at(input: &str, start: usize) -> Option<usize> {
    if start > 0 && is_token_char(input.as_bytes()[start - 1]) {
        return None;
    }
    let bytes = input.as_bytes();
    let mut index = start;
    while index < bytes.len() && is_token_char(bytes[index]) {
        index += 1;
    }
    if index - start >= 24 {
        Some(index)
    } else {
        None
    }
}

fn replace_spans(
    input: &str,
    span_end_at: impl Fn(&str, usize) -> Option<usize>,
    replacement: &str,
) -> String {
    let mut output = String::with_capacity(input.len());
    let mut index = 0;
    while index < input.len() {
        if let Some(end) = span_end_at(input, index) {
            output.push_str(replacement);
            index = end;
        } else {
            let ch = input[index..].chars().next().expect("valid char");
            output.push(ch);
            index += ch.len_utf8();
        }
    }
    output
}

fn truncate_diagnostic(input: &str) -> String {
    const MAX_DIAGNOSTIC_LEN: usize = 300;
    if input.chars().count() <= MAX_DIAGNOSTIC_LEN {
        return input.to_string();
    }
    let mut truncated: String = input.chars().take(MAX_DIAGNOSTIC_LEN).collect();
    truncated.push('…');
    truncated
}

fn is_email_char(byte: u8) -> bool {
    is_email_local_char(byte) || byte == b'@'
}

fn is_email_local_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'%' | b'+' | b'-')
}

fn is_email_domain_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-')
}

fn is_hex(byte: u8) -> bool {
    byte.is_ascii_hexdigit()
}

fn is_token_char(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-')
}

#[cfg(test)]
mod tests {
    use super::super::types::{DevtunnelErrorCode, DevtunnelFailureInput, DevtunnelRetryClass};
    use super::{classify_failure, sanitize_technical_detail};

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FailureFixture {
        name: String,
        input: DevtunnelFailureInput,
        expected: Expected,
    }

    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Expected {
        code: DevtunnelErrorCode,
        retry_class: DevtunnelRetryClass,
        retryable: bool,
        #[serde(default)]
        retry_after_ms: Option<u64>,
    }

    #[test]
    fn matches_devtunnel_failure_fixtures() {
        let fixture_path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../fixtures/devtunnel/failures.json"
        );
        let fixtures: Vec<FailureFixture> = serde_json::from_str(
            &std::fs::read_to_string(fixture_path).expect("read devtunnel failure fixture"),
        )
        .expect("parse devtunnel failure fixture");

        for fixture in fixtures {
            let actual = classify_failure(&fixture.input, "2026-07-11T13:00:00.000Z");
            assert_eq!(actual.code, fixture.expected.code, "{} code", fixture.name);
            assert_eq!(
                actual.retry_class, fixture.expected.retry_class,
                "{} retry_class",
                fixture.name
            );
            assert_eq!(
                actual.retryable, fixture.expected.retryable,
                "{} retryable",
                fixture.name
            );
            assert_eq!(
                actual.retry_after_ms, fixture.expected.retry_after_ms,
                "{} retry_after_ms",
                fixture.name
            );
        }
    }

    #[test]
    fn sanitizer_scrubs_sensitive_details_and_truncates() {
        let long_tail = "x ".repeat(180);
        let sanitized = sanitize_technical_detail(&format!(
            "contact user@example.com at https://example.com/path?token=abc {long_tail}"
        ));

        assert!(sanitized.contains("<email>"));
        assert!(sanitized.contains("<url>"));
        assert!(!sanitized.contains("user@example.com"));
        assert!(!sanitized.contains("https://example.com"));
        assert!(sanitized.ends_with('…'));
        assert_eq!(sanitized.chars().count(), 301);
    }
}
