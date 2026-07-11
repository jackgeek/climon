# Windows Bootstrap Migration and Installer-Owned Updates

Date: 2026-07-11
Status: Approved for planning
Branch: `fix/windows-bootstrap-migration`

## Goal

Allow every legacy Windows installation to update directly to the new
stub-layout release without depending on an intermediate bridge release.

The transition must remain safe for users who skip any number of releases. It
must also replace the current updater-owned file-layout logic with an
installer-owned update contract so future archive and installation layouts can
change without requiring old clients to understand them.

## Current compatibility problem

Already-released Windows clients interpret `install.exe` as the next standalone
client and copy it to the installed path as `climon.exe`.

The new release currently interprets `install.exe` as a dedicated installer.
If an old updater copies those bytes to `climon.exe`, the installed entrypoint
is no longer a client and cannot load the new `climon.dll` layout.

An adoption-dependent bridge release only reduces this risk. It cannot protect
an offline installation that skips the bridge.

## Single-artifact compatibility contract

Keep one public Windows archive with the existing obvious filename:

`climon-windows-x64.zip`

It contains:

- `install.exe`
- `climon.dll`
- `climon-server.exe`

There are no parallel legacy/stub downloads and no user-facing channel choice.

`install.exe` is the `climon-setup` executable and has two modes determined by
its executable filename:

1. **Installer mode (`install.exe`)** — performs fresh install, update, or
   migration from the already-downloaded archive.
2. **Recovery-bootstrap mode (`climon.exe`)** — means an old updater copied the
   installer over the legacy client. It repairs the installation before
   dispatching any requested climon command.

The filename check is limited to these two explicit basenames. Other names
produce an error rather than guessing a mode.

## Recovery-bootstrap flow

When `climon-setup` starts as `climon.exe` and no valid stub pointer layout is
present:

1. Capture the original command-line arguments.
2. Locate the preserved legacy executable at `climon.exe.old`.
3. Download the latest manifest and the Windows artifact using the normal
   bounded download helpers.
4. Verify the artifact signature with the public key embedded in the bootstrap.
5. Extract the verified archive to a uniquely named staging directory inside
   the installation directory.
6. Confirm that the staged archive contains `install.exe`, `climon.dll`, and
   `climon-server.exe`.
7. Spawn the staged `install.exe` in recovery mode with:
   - the target installation directory;
   - the staging directory;
   - the bootstrap process ID to wait for;
   - the original arguments, used only if child-side migration fails and the
     legacy fallback must run.
8. Exit immediately so Windows releases the `climon.exe` file lock.
9. The child installer waits for the bootstrap PID to exit, installs the stable
   client/server stubs, versioned payloads, and pointer files, removes temporary
   state, then prints a prominent message that a critical update was applied and
   the user must rerun `climon`.

The recovery mode is idempotent. If another process completes migration first,
the child validates the resulting pointer layout and prints the same rerun
message without rewriting it.

## Offline and failure fallback

Recovery must never turn a working legacy installation into an unusable one.

If manifest download, artifact download, signature verification, extraction, or
child launch fails before the bootstrap exits:

1. Print a concise warning that automatic migration could not complete.
2. Execute `climon.exe.old` with the original arguments.
3. Return the legacy process exit code.

If the child installer fails after the bootstrap exits, the child performs the
same fallback before cleaning the staging directory.

The fallback must not invoke `climon.exe.old update` recursively after a failed
bootstrap attempt. For an original `update` command, print a clear retryable
failure and return non-zero without launching the old updater. For every other
command, launch `climon.exe.old` with the original arguments.

If `climon.exe.old` is absent or invalid, preserve the bootstrap executable,
print recovery guidance, and return non-zero. Re-running the current
`install.ps1` remains the final repair path.

## Installer-owned update protocol

After migration, the running client no longer decides which files from an
archive map to which installed paths.

The client updater is responsible only for:

1. checking whether a newer version exists;
2. downloading the selected artifact and detached signature;
3. verifying the signature;
4. extracting the verified archive to a staging directory;
5. invoking staged `install.exe --update` through a stable argument contract.

The installer owns:

- archive validation;
- fresh installation;
- legacy-to-stub migration;
- versioned payload placement;
- atomic pointer updates;
- stub installation or repair;
- obsolete payload cleanup policy;
- future layout migrations.

The stable installer arguments include the target install directory, source
staging directory, requested version, and operation mode. New optional
arguments may be added, but existing argument meanings must not change.

Installer errors propagate to the client. The client must not print a
successful update result until the installer returns success.

## Packaging and build changes

The Windows release still publishes one archive. `install.exe` remains the
dedicated `climon-setup` binary with embedded client/server stubs. The release
also carries `climon.dll` and the server payload.

No standalone `climon-cli` binary is added to the archive and the DLL payload is
not duplicated inside the installer.

`climon-setup` gains only the networking, signature-verification, and bootstrap
orchestration required to repair the old-updater rename case. Shared download,
manifest, verification, and staging logic should be reused from
`climon-update` rather than duplicated.

## Security requirements

- The bootstrap verifies the detached artifact signature before executing any
  downloaded installer.
- Downloads retain the existing manifest, signature, and artifact size bounds.
- ZIP entries are validated against traversal and absolute-path extraction.
- Staging directories are created inside the installation directory with
  unique names and are removed after success or recoverable failure.
- Recovery arguments are passed as process arguments, never interpolated into a
  shell command.
- The bootstrap accepts only the canonical release manifest endpoint in
  production builds. Existing compiled-out test endpoint support may be reused
  by the Windows harness.
- `climon.exe.old` is executed only from the resolved installation directory.

## Testing

### Unit and integration coverage

- executable-name mode selection;
- valid and invalid bootstrap archive layouts;
- signature rejection leaves the install unchanged;
- bounded download failures invoke legacy fallback;
- child installer arguments preserve the original arguments for failure
  fallback only;
- successful recovery does not relaunch or resume the original command;
- successful recovery prints the critical-update rerun message;
- recovery waits for the bootstrap PID before replacing `climon.exe`;
- concurrent/idempotent recovery;
- missing `climon.exe.old` error handling;
- installer-owned update success and failure propagation;
- new updater contains no archive-to-install-path mapping.

### Windows end-to-end scenarios

1. Install a real legacy release.
2. Update it directly to the first stub release with no bridge.
3. Run `climon --version`; verify bootstrap migration completes, the command is
   not resumed, and the critical-update rerun message is shown.
4. Rerun `climon --version`, then verify the final stub, versioned DLL/server
   payloads, and pointer files.
5. Repeat with network disabled after the old updater places the bootstrap;
   verify `climon.exe.old` runs and normal legacy commands remain available.
6. Restore network and retry; verify migration succeeds.
7. Update stub release C to C+1 and verify the client delegates placement to the
   staged installer.
8. Verify fresh `install.ps1` installation still uses the same public archive.

These checks replace the bridge-adoption manual tests and must be reflected in
`docs/manual-tests/windows-binary-lifecycle.md`.

## Documentation changes

- Remove claims that users must receive a bridge release before the stub
  release.
- Document automatic bootstrap recovery for legacy updaters.
- Update architecture and security documentation to state that the verified
  installer owns layout changes.
- Update the feature catalogue description without changing its existing ID.
- Replace bridge rollout manual checks with direct legacy-to-stub and offline
  fallback checks.
- Update the 3.2.0 changelog entry to describe direct, skip-safe migration.

## Release gate

Do not release the stub layout until:

1. all local Rust/Bun checks pass;
2. CI passes on Windows, macOS, Linux, and attribution checks;
3. the direct legacy-to-stub Windows scenario passes;
4. the offline `climon.exe.old` fallback passes;
5. the C-to-C+1 installer-owned update passes;
6. archive contents and production test-hook inertness are verified.

No separate bridge release is required after these gates pass.

## Non-goals

- Multiple public Windows artifacts or update channels.
- Duplicating the standalone client and DLL in one archive.
- Depending on users to install releases in sequence.
- Preserving updater-owned file-layout mappings for the stub generation.
