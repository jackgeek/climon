# MIT license transition

These checks prove the one-time behaviours that ship with the open-source
relicense: the new `climon license` command, the single license-change notice
shown to installs that upgraded from a pre-open-source (EULA-gated) build, and
the absence of any notice on fresh installs. Auto-update itself is covered by
[phase10-update.md](phase10-update.md); here we only verify the transition
surface.

Legacy installs are detected by a leftover `eula.*` key in the global config
(pre-open-source builds wrote one on acceptance). Simulate that by seeding a
scratch `$CLIMON_HOME` config, so the test never touches your real `~/.climon`.

---

## MT-LIC-01 — Upgraders see the license-change notice exactly once

- **ID:** MT-LIC-01
- **Feature / phase:** MIT license transition
- **Preconditions:** A built `climon` binary; a scratch `$CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Create a scratch `$CLIMON_HOME` and write a `config.jsonc` there simulating a
   pre-open-source install, e.g. `{"eula":{"version":"1"}}`.
2. Start an interactive session (`climon` with no subcommand, or `climon run --`
   a short command) and watch stderr as it launches.
3. Exit the session, then start another interactive session the same way.
4. Inspect the global config (`climon config --global license.noticeShown`).

**Expected result:**
- The first launch prints, once, to stderr: `climon is now open source under the
  MIT License — run 'climon license' for details.`
- The second launch prints no such notice.
- `license.noticeShown` is `true` after the first launch.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-LIC-02 — `climon license` prints the MIT License and third-party notices

- **ID:** MT-LIC-02
- **Feature / phase:** MIT license transition
- **Preconditions:** A built `climon` binary.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Run `climon license`.

**Expected result:**
- The output begins with the MIT License text for climon (copyright line +
  permission notice).
- The bundled third-party attributions follow (the same content as
  `THIRD-PARTY-LICENSES.md`).
- The command exits 0.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-LIC-03 — Fresh installs never see the notice

- **ID:** MT-LIC-03
- **Feature / phase:** MIT license transition
- **Preconditions:** A built `climon` binary; a fresh scratch `$CLIMON_HOME`
  with no `eula.*` key.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. Create a fresh scratch `$CLIMON_HOME` (empty or without any `eula.*` key).
2. Start an interactive session and watch stderr as it launches.
3. Inspect the global config (`climon config --global license.noticeShown`).

**Expected result:**
- No license-change notice is printed.
- `license.noticeShown` remains unset (fresh installs are never flagged).

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
