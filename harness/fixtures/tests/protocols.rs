use climon_harness_fixture::run;

const APPROVED_COMMANDS: &str = "Expected one of: streaming, interactive-tui, mode-probe -- <executable> [args...], control-probe, metadata-probe, lifecycle-probe <fast-success|failed-exit|flood|signal-hold|engine-echo>";

#[test]
fn usage_lists_the_exact_public_commands() {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    let result = run(
        vec!["fixture".to_string()],
        &b""[..],
        &mut stdout,
        &mut stderr,
    );

    assert_eq!(
        result,
        Err(climon_harness_fixture::cli::CliError::Usage(
            APPROVED_COMMANDS.to_string()
        ))
    );
    assert!(stdout.is_empty());
    assert!(stderr.is_empty());
}

#[test]
fn control_probe_accepts_scripted_tokens_and_resize_sequences() {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    let result = run(
        vec!["fixture".to_string(), "control-probe".to_string()],
        &b"surface-alpha\r\x1b[8;30;100tbrowser-token\rq"[..],
        &mut stdout,
        &mut stderr,
    );

    assert_eq!(result, Ok(0));
    let text = String::from_utf8(stdout).unwrap();
    assert!(text.contains("DAR_CONTROL_READY 80 24"));
    assert!(text.contains("DAR_CONTROL_INPUT surface-alpha"));
    assert!(text.contains("DAR_CONTROL_RESIZE 1 100 30"));
    assert!(text.contains("DAR_CONTROL_INPUT browser-token"));
    assert!(text.contains("last=browser-token"));
    assert!(text.contains("resizes=1"));
    assert_eq!(String::from_utf8(stderr).unwrap(), "");
}

#[test]
fn metadata_probe_emits_markers_and_raw_osc_sequences_in_order() {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();

    let result = run(
        vec!["fixture".to_string(), "metadata-probe".to_string()],
        &b"STATIC\nCHANGE token-alpha\nTITLE0 title-zero\nTITLE2 title-two\nPROGRESS 1 42\nCLEAR_PROGRESS\nEXIT\n"[..],
        &mut stdout,
        &mut stderr,
    );

    assert_eq!(result, Ok(0));
    assert_eq!(
        String::from_utf8(stdout).unwrap(),
        concat!(
            "DAR_METADATA_STATIC\n",
            "DAR_METADATA_STATIC\n",
            "DAR_METADATA_BODY_CHANGED token-alpha\n",
            "\x1b]0;title-zero\x07DAR_METADATA_OSC_EMITTED TITLE0\n",
            "\x1b]2;title-two\x07DAR_METADATA_OSC_EMITTED TITLE2\n",
            "\x1b]9;4;1;42\x07DAR_METADATA_OSC_EMITTED PROGRESS 1 42\n",
            "\x1b]9;4;0;0\x07DAR_METADATA_OSC_EMITTED CLEAR_PROGRESS\n",
        )
    );
    assert_eq!(String::from_utf8(stderr).unwrap(), "");
}

#[test]
fn lifecycle_probe_supports_early_exit_modes_and_flood_gating() {
    for (mode, expected_code, expected_stdout) in [
        ("fast-success", 0, "DAR_LIFECYCLE_EARLY success\n"),
        ("failed-exit", 7, "DAR_LIFECYCLE_EARLY failure\n"),
        ("engine-echo", 0, "DAR_ENGINE_ECHO\n"),
    ] {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let result = run(
            vec![
                "fixture".to_string(),
                "lifecycle-probe".to_string(),
                mode.to_string(),
            ],
            &b""[..],
            &mut stdout,
            &mut stderr,
        );

        assert_eq!(result, Ok(expected_code));
        assert_eq!(String::from_utf8(stdout).unwrap(), expected_stdout);
        assert_eq!(String::from_utf8(stderr).unwrap(), "");
    }

    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let result = run(
        vec![
            "fixture".to_string(),
            "lifecycle-probe".to_string(),
            "flood".to_string(),
            "6".to_string(),
            "gate-token".to_string(),
        ],
        &b"CONTINUE gate-token\n"[..],
        &mut stdout,
        &mut stderr,
    );

    assert_eq!(result, Ok(0));
    assert_eq!(
        String::from_utf8(stdout).unwrap(),
        concat!(
            "DAR_LIFECYCLE_FLOOD 000001\n",
            "DAR_LIFECYCLE_FLOOD 000002\n",
            "DAR_LIFECYCLE_FLOOD 000003\n",
            "DAR_LIFECYCLE_FLOOD 000004\n",
            "DAR_LIFECYCLE_FLOOD 000005\n",
            "DAR_LIFECYCLE_FLOOD 000006\n",
        )
    );
    assert_eq!(String::from_utf8(stderr).unwrap(), "");
}

#[test]
fn lifecycle_probe_rejects_missing_or_invalid_modes() {
    for args in [
        vec!["fixture".to_string(), "lifecycle-probe".to_string()],
        vec![
            "fixture".to_string(),
            "lifecycle-probe".to_string(),
            "bogus".to_string(),
        ],
        vec![
            "fixture".to_string(),
            "lifecycle-probe".to_string(),
            "flood".to_string(),
        ],
    ] {
        let mut stdout = Vec::new();
        let mut stderr = Vec::new();

        let result = run(args, &b""[..], &mut stdout, &mut stderr);

        assert!(matches!(
            result,
            Err(climon_harness_fixture::cli::CliError::Usage(message))
                if message.starts_with("lifecycle-probe requires:")
        ));
        assert!(stdout.is_empty());
        assert!(stderr.is_empty());
    }
}
