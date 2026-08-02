# Manual result records

Create `results/<version>.md` for each release candidate and copy in the
result-tracking rows from the manual cases you actually ran. Record the date,
tester, platform, version, pass/fail result, and useful notes.

The E2E harness artifacts provide repeatable automated evidence for `DAR-01`
through `DAR-10`. Link the relevant CI run or downloaded artifact in the notes,
but do not mark a manual row passed unless a tester completed that case against
the release candidate on the stated platform.
