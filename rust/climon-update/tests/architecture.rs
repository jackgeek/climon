#[test]
fn update_cmd_and_cli_delegate_installation_without_layout_ownership() {
    let sources = concat!(
        include_str!("../src/update_cmd.rs"),
        include_str!("../src/update_cli.rs")
    );

    for forbidden in [
        "climon.dll",
        "climon-server.exe",
        "climon.version",
        "climon-server.version",
        "write_pointer",
        "replace_file_atomic",
        "place_windows_layout",
        "install_files_for_platform",
        "std::fs::rename",
        "std::fs::write",
    ] {
        assert!(
            !sources.contains(forbidden),
            "updater source still owns installation detail: {forbidden}"
        );
    }

    assert!(sources.contains("--apply-update-v1"));
    assert!(sources.contains("installer_name"));
}
