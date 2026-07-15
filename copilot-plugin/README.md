# climon-tools (local Copilot CLI plugin)

A repository-local [Copilot CLI plugin](https://docs.github.com/copilot/concepts/agents/copilot-cli/about-cli-plugins)
that bundles climon-specific skills. It is **not** installed globally — it is
loaded per session, only when you want it, while working in this repo.

## Skills

- **`update-changelog`** — examines commits since the last version in
  `CHANGELOG.json` and adds a new entry with user-friendly change descriptions
  for the upcoming release. See [`skills/update-changelog/SKILL.md`](skills/update-changelog/SKILL.md).
- **`merge-dependabot-prs`** — triages open Dependabot PRs: retargets each onto
  `dev`, runs the relevant test suite (`cargo test` for Rust deps, `bun test`
  for JS deps), squash-merges the ones that pass, and reports why any PR could
  not be merged. See [`skills/merge-dependabot-prs/SKILL.md`](skills/merge-dependabot-prs/SKILL.md).

## How to use

Launch Copilot CLI from the repo root with the plugin loaded:

```sh
copilot --plugin-dir copilot-plugin
```

Then, in the session, just describe the task — for example:

```
update the changelog
```

Copilot will invoke the `update-changelog` skill. Skills are run by the agent
in response to a natural-language request; Copilot CLI does not expose them as
typed `/slash` commands. For example, "merge the dependabot PRs" runs the
`merge-dependabot-prs` skill.
