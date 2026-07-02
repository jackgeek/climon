# Security — project-local config global-only settings

These checks prove that an untrusted repository-local `.climon/config.jsonc`
cannot override execution/network/update-sensitive config keys. The expected
behaviour applies to the Rust `climon` client and the Bun config mirror.

No configuration matrix applies beyond platform coverage; run on each platform
where `session.terminalProgram` is supported.

---

## MT-SEC-CFG-01 — Project-local `session.terminalProgram` is ignored

- **ID:** MT-SEC-CFG-01
- **Feature / phase:** WS-2 security — config global-only settings
- **Preconditions:** A built `climon` binary is on `PATH`; use a scratch
  `$CLIMON_HOME` and scratch repository directory under the project workspace so
  the test does not touch your real `~/.climon`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Create a scratch `$CLIMON_HOME` and set a safe global terminal template:
   `climon config --global session.terminalProgram "<known-safe-terminal> {cmd}"`.
2. Create a scratch repository directory containing `.climon/config.jsonc` with:
   `{"session":{"terminalProgram":"./marker-script {cmd}"}}`.
3. In that scratch repository, create `marker-script` so it writes a marker file
   if it is ever executed.
4. From inside the scratch repository, start a visible session from the dashboard
   or via the normal non-headless spawn path.
5. Check that the marker file was not created.
6. Change the global setting with
   `climon config --global session.terminalProgram "<alternate-safe-terminal> {cmd}"`
   and start another visible session.

**Expected result:**
- The project-local `./marker-script {cmd}` is never used and the marker file is
  not created.
- The globally configured terminal template is used for the visible session.
- Updating the global `session.terminalProgram` still changes the terminal used
  by subsequent visible sessions.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-SEC-CFG-02 — Project-local remote/update settings are ignored

- **ID:** MT-SEC-CFG-02
- **Feature / phase:** WS-2 security — config global-only settings
- **Preconditions:** A built `climon` binary is on `PATH`; use a scratch
  `$CLIMON_HOME` and scratch repository directory under the project workspace.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Set known global values for representative sensitive settings, for example:
   `climon config --global remote.port 3131` and
   `climon config --global session.terminalProgram 'safe {cmd}'`.
2. Create a scratch repository containing `.climon/config.jsonc` with conflicting
   values, for example:
   `{"remote":{"port":4444},"session":{"terminalProgram":"./evil.sh {cmd}"}}`.
3. From inside the scratch repository, inspect effective values with the relevant
   config/debug command or by running the config resolver tests.

**Expected result:**
- Effective `remote.*` and `session.terminalProgram` values come from the global
  `$CLIMON_HOME` config, not the project-local `.climon/config.jsonc`.
- An explicit `climon config --local <global-only-key> ...` write prints a
  warning that the local value will not be read and suggests `--global`.
- Non-security settings such as `session.color` still honor project-local config.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
