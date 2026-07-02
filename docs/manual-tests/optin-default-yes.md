# Interactive install opt-ins default to Yes

These checks prove that the interactive telemetry and auto-update onboarding
prompts default to **Yes** (pressing Enter opts in), show `[Y/n]`, accept an
explicit `n`/`no` to opt out, and re-prompt on unrecognised input. The
underlying `telemetry.enabled` / `update.auto` config defaults are unchanged
(still `false` for non-interactive/silent installs).

No configuration matrix applies beyond platform coverage. Use a scratch
`$CLIMON_HOME` so the test does not touch your real `~/.climon`.

---

## MT-OPT-01 — Pressing Enter opts in to both

- **ID:** MT-OPT-01
- **Feature / phase:** Interactive install opt-ins default to Yes
- **Preconditions:** A built `climon` binary; a scratch `$CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. With a fresh scratch `$CLIMON_HOME`, run `climon setup` interactively.
2. At the telemetry prompt (`... [Y/n]`), press Enter.
3. At the auto-update prompt (`... [Y/n]`), press Enter.
4. Inspect the resulting global config (e.g. `climon config --global telemetry.enabled`
   and `climon config --global update.auto`).

**Expected result:**
- Both prompts display `[Y/n]`.
- `telemetry.enabled` is `true` and `update.auto` is `true`.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-OPT-02 — Explicit `n` opts out

- **ID:** MT-OPT-02
- **Feature / phase:** Interactive install opt-ins default to Yes
- **Preconditions:** A built `climon` binary; a fresh scratch `$CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. With a fresh scratch `$CLIMON_HOME`, run `climon setup` interactively.
2. At the telemetry prompt, type `n` and press Enter.
3. At the auto-update prompt, type `no` and press Enter.
4. Inspect the resulting global config values.

**Expected result:**
- `telemetry.enabled` is `false` and `update.auto` is `false`.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |

---

## MT-OPT-03 — A typo re-prompts the same question

- **ID:** MT-OPT-03
- **Feature / phase:** Interactive install opt-ins default to Yes
- **Preconditions:** A built `climon` binary; a fresh scratch `$CLIMON_HOME`.
- **Config-matrix cell:** n/a
- **Platforms:** macOS, Linux, Windows

**Steps:**
1. With a fresh scratch `$CLIMON_HOME`, run `climon setup` interactively.
2. At the telemetry prompt, type an unrecognised value such as `huh` and press Enter.
3. Confirm the same telemetry prompt is shown again.
4. Type `n` and press Enter, then answer the auto-update prompt with `y`.
5. Inspect the resulting global config values.

**Expected result:**
- The telemetry prompt is re-issued after the typo and no value is recorded
  from the typo.
- After answering `n` then `y`, `telemetry.enabled` is `false` and
  `update.auto` is `true`.

**Result-tracking row:**

| Date | Tester | Platform | Version | Pass/Fail | Notes |
|---|---|---|---|---|---|
|  |  |  |  |  |  |
