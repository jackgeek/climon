# Installer-Owned Updates and Universal Legacy Bootstrap

Date: 2026-07-11
Status: Approved for planning
Branch: `fix/windows-bootstrap-migration`

## Goal

Make updates forward-compatible on Windows, macOS, and Linux:

- the installed client may discover, download, and verify a newer release;
- the installer shipped in that newer release exclusively decides how to
  install it;
- the old client never maps archive files to installed paths or writes the new
  client/server layout itself.

The transition must also repair every already-installed legacy client that
still uses the old updater behavior, without requiring an intermediate bridge
release or sequential release adoption.

## Problem

Already-released clients hard-code the old archive contract:

- they read `install[.exe]` from the new archive;
- they write those bytes to the installed `climon[.exe]` path;
- they copy `climon-server[.exe]` themselves.

That makes the old client responsible for understanding future layouts. The
new dedicated installer changed the meaning of `install[.exe]`, exposing the
fundamental compatibility flaw.

Waiting for users to receive a bridge release is not sufficient. Offline or
infrequently used installations can skip it and encounter the incompatible
archive later.

## Permanent update protocol

Every release archive keeps one permanent, stable entrypoint:

- Windows: `install.exe`
- macOS/Linux: `install`

After the migration described below, the installed client performs only:

1. fetch the release manifest;
2. select the current platform artifact;
3. download the artifact and detached signature with existing size bounds;
4. verify the Ed25519 signature;
5. safely extract the verified archive to a staging directory;
6. invoke the staged installer through the versioned protocol:

```text
install[.exe] --apply-update-v1
  --dir <installed-climon-directory>
  --source <verified-staging-directory>
  --version <manifest-version>
```

The client waits for the installer and reports success only when it exits
successfully.

The installer owns:

- archive content validation;
- fresh installation;
- legacy-to-current migration;
- client and server placement;
- Windows stubs, versioned payloads, and pointer updates;
- Unix rename-over replacement;
- obsolete-file cleanup;
- future layout migrations.

`--apply-update-v1` is a stable protocol. Its existing argument meanings never
change. A future incompatible installer contract uses a new versioned operation,
while installers may continue supporting older operations as needed.

The stable archive entrypoint and versioned installer command are the only
layout knowledge retained by the client.

## Universal legacy bootstrap

Already-released clients cannot use the new protocol. They will copy the new
installer over `climon[.exe]`.

This first hop remains authenticated. Already-released clients download the
detached signature and verify the Ed25519 signature over the complete release
ZIP before extracting or copying `install[.exe]`. The new archive must preserve
that exact signed-artifact contract, so an old client never installs or executes
an unauthenticated bootstrap.

The dedicated installer therefore selects its mode from its executable basename:

- `install` or `install.exe`: normal installer mode;
- `climon` or `climon.exe`: legacy recovery-bootstrap mode;
- any other name: fail explicitly.

Recovery-bootstrap mode:

1. captures the original arguments;
2. fetches the canonical release manifest;
3. downloads the current artifact and its detached signature;
4. independently verifies the Ed25519 signature over the complete artifact
   using the embedded update public key;
5. refuses to extract or execute any downloaded content if verification fails;
6. safely stages the verified artifact;
7. validates that its installer and required platform payloads exist;
8. invokes the staged installer through a recovery operation.

This bootstrap redownload is intentional. The old updater discarded or ignored
files it did not understand, so the renamed installer cannot rely on the
original extraction directory.

The two verifications protect separate downloads:

1. the old client authenticates the archive containing the bootstrap before it
   replaces `climon[.exe]`;
2. the bootstrap authenticates the newly downloaded canonical archive before it
   executes the staged installer.

There is no unsigned installer execution path in either phase.

Production bootstrap builds use only the canonical manifest endpoint. The
existing compiled-out test endpoint feature may be forwarded to the installer
for the upgrade harness.

## Windows recovery

The old Windows updater displaces the prior client to `climon.exe.old` before
placing the new installer bytes at `climon.exe`.

The bootstrap:

1. verifies and stages the current artifact;
2. spawns staged `install.exe --recover-bootstrap-v1` with the install
   directory, staging directory, release version, bootstrap PID,
   `climon.exe.old`, and original arguments for failure fallback;
3. exits immediately so Windows releases the `climon.exe` file lock.

The child installer waits for the bootstrap PID to exit, installs the stub
layout, and prints:

```text
A critical climon update was applied successfully.
Please rerun your climon command.
```

It does not resume the original command after successful migration.

If download, verification, staging, child launch, waiting, or installation
fails:

- for an original `update` command, return a clear retryable error without
  invoking the old updater recursively;
- for other commands, run the install-directory `climon.exe.old` with the
  original arguments and return its exit code.

If `.old` is unavailable, retain the bootstrap, print `install.ps1` recovery
guidance, and return non-zero.

## macOS and Linux recovery

Already-released Unix updaters atomically rename the installer bytes over
`climon`; they do not preserve a pathname to the old client. The running old
update process remains valid through its open inode, but later invocations have
no offline fallback executable.

The renamed installer therefore:

1. redownloads and verifies the current artifact;
2. invokes staged `install --recover-bootstrap-v1`;
3. lets the installer apply the current Unix layout through rename-over;
4. launches the newly installed `climon` with the original arguments;
5. returns the new client process exit code.

This one-time migration requires network access. If unavailable, print a clear
message that the critical migration needs connectivity and that rerunning the
current `install.sh` is the manual recovery path. Do not partially mutate the
installation before verification and staging complete.

Unlike Windows, successful Unix recovery resumes the original command because
Unix permits replacing the pathname while the bootstrap process continues from
its old inode.

## Shared verified-artifact staging

Download, signature verification, ZIP validation, and staging are implemented
once in `climon-update` and reused by:

- normal client updates;
- Windows recovery bootstrap;
- macOS/Linux recovery bootstrap.

Security requirements:

- preserve the already-shipped client's first-hop verification contract: one
  detached Ed25519 signature authenticates the complete release ZIP, including
  `install[.exe]`;
- independently verify the bootstrap's redownload with the embedded public key;
- preserve manifest, signature, and artifact byte caps;
- reject absolute paths, parent traversal, platform prefixes, and unsafe ZIP
  entries;
- create unique staging directories;
- execute no downloaded file before signature verification;
- pass arguments directly to `Command`, never through a shell;
- clean staging after synchronous operations and hand ownership explicitly to
  asynchronous Windows recovery;
- use only the resolved install-directory `.old` fallback on Windows.

## Architecture enforcement

The updater application layer must not contain installation layout policy.

Remove the updater-owned installation manifest and direct placement code. In
particular, normal update application must not:

- reference `climon.dll`, versioned payload names, server payload names, pointer
  files, or stub filenames;
- call pointer writers, versioned-file writers, or binary replacement helpers;
- choose destination filenames for archive entries.

Add an architecture test that reads the updater application source and fails if
these forbidden payload names or direct-placement APIs return. This supplements
the structural boundary: the updater stages one verified artifact and invokes
one stable installer entrypoint.

Installer tests are the source of truth for on-disk layouts. Updater tests
assert command delegation, signature rejection, staging safety, installer
failure propagation, and absence of direct placement.

## Packaging

Continue publishing one obvious archive per platform.

Windows:

```text
install.exe
climon.dll
climon-server.exe
```

macOS/Linux:

```text
install
climon
climon-server
```

No parallel legacy channel is exposed. No standalone Windows client is
duplicated beside the DLL payload. On Unix the client payload remains a normal
archive entry used by the installer.

## End-to-end verification

### Windows

1. Install a real legacy release.
2. Update directly to the new release with no bridge.
3. Invoke `climon --version`.
4. Verify the critical-update rerun message and no automatic command resume.
5. Rerun and verify the stub layout/version.
6. Repeat with bootstrap networking unavailable; verify `.old` handles a normal
   command and `update` does not recurse.
7. Verify current-layout C-to-C+1 update delegates to the installer.

### macOS and Linux

1. Install a real legacy release.
2. Update directly to the new release with no bridge.
3. Invoke `climon --version`.
4. Verify bootstrap migration and automatic command resume through the newly
   installed client.
5. Verify the installed client/server layout and version.
6. Verify offline first-run behavior reports the one-time network requirement
   without further installation mutation.
7. Verify current-layout C-to-C+1 update delegates to the installer.

### All platforms

- fresh installation still succeeds from the same public archive;
- a real legacy client rejects a tampered first-hop archive before replacing
  `climon[.exe]`;
- the recovery bootstrap rejects a tampered redownload before extraction or
  installer execution;
- signature failure leaves the installation untouched;
- installer non-zero exits propagate as update failures;
- test endpoint hooks remain absent from production workflow configuration;
- full Rust, Bun, typecheck, lint, attribution, and CI matrices pass.

## Documentation changes

- Remove bridge-release ordering and adoption requirements.
- Document the universal bootstrap and platform-specific recovery behavior.
- State that new-release installers own all layout changes.
- Update security documentation for signed bootstrap staging.
- Replace bridge manual tests with direct legacy-to-current cases on Windows,
  macOS, and Linux.
- Update the existing feature catalogue entry and 3.2.0 changelog wording.

## Release gate

Do not release until direct legacy-to-current migration passes on Windows,
macOS, and Linux, including Windows fallback and Unix offline messaging.

No bridge release is required.

## Non-goals

- Multiple public artifacts for legacy and current clients.
- Requiring users to receive releases in order.
- Allowing the updater to regain file-layout knowledge.
- Providing an offline Unix fallback executable that already-released updaters
  did not preserve.
