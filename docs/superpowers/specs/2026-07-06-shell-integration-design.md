# Shell Integration — Monitor All Terminals by Default

Date: 2026-07-06
Status: Design (approved for planning)
Branch: `shell-integration`

## Summary

Add a safe, reversible way to make new terminals launch `climon shell`
automatically, so PTY sessions are monitored by default without the user
manually running `climon` each time. The user selects which detected terminals
to integrate with (or removes integration from) via an interactive multi-select,
and every change is backed up and one-command reversible.

Targets in v1:

- **macOS:** Terminal.app, iTerm2
- **Windows:** Windows Terminal
- **Linux:** GNOME Terminal, Konsole
- **Cross-platform:** VS Code integrated terminal
- **WSL:** every installed distro (catches bare `wsl.exe` and all interactive
  entries into the distro)

## Goals

- New terminals launch `climon shell` automatically once integrated.
- The user chooses exactly which terminals/distros to integrate or un-integrate.
- Every mechanism is safe: it can never leave a terminal unusable, and it is
  fully reversible with a single command.
- Cross-platform from day one (macOS, Windows, Linux, WSL).

## Non-goals (rejected for safety, documented)

- **PATH/alias shims** of `bash`/`pwsh`/`zsh` (Approach A). A `bash` shim on PATH
  intercepts non-interactive calls (shebangs, `bash script.sh`, `sh -c`, build
  tools, CI), which is too easy to get subtly wrong and break scripts silently.
- **True login-shell replacement** via `chsh` / Windows registry (Approach C).
  A broken login shell locks the user out of terminals and needs single-user /
  recovery mode to fix. Universally discouraged.

The WSL in-distro rc hook (below) is a *scoped* variant of interactive shell
interception, guarded four ways and limited to interactive shells in one distro;
it is deliberately not a general PATH shim or login-shell replacement.

## Core safety invariants

The design is built around these; every adapter must uphold them:

1. **Never break a terminal.** Integrations launch a *fallback wrapper*, not
   `climon` directly. If climon is missing or errors, the wrapper `exec`s the
   user's real shell and prints one warning line that monitoring is off.
2. **Always reversible.** Before editing any terminal config, back up the
   original; `uninstall`/restore restores it. File-based configs restore
   byte-for-byte from the backup.
3. **Idempotent.** Re-running install detects existing integration and makes no
   harmful change.
4. **Opt-in.** Nothing changes without an explicit command or an onboarding
   confirmation.
5. **Per-adapter isolation.** One terminal failing to integrate never aborts the
   others; results are reported per terminal.

## Command surface

`climon shell-integration <subcommand>`:

- `status` — detect terminals/distros present on this machine and report each
  one's state (not integrated / integrated / integrated + default).
- `install [--terminal <id>...] [--all] [--set-default]`
  - With **no target flags on a tty**: shows an **interactive multi-select
    checklist** of detected terminals, each row showing name + current state
    (e.g. `iTerm2 — integrated (default)`, `GNOME Terminal — not integrated`,
    `WSL: Ubuntu — not integrated`). The user toggles the set to install, then
    confirms.
  - `--terminal <id>...` targets specific adapters by id; `--all` selects every
    detected adapter. Non-interactive use requires one of these flags.
  - `--set-default` makes the climon profile the default for each selected
    terminal, saving the prior default first. (No effect for WSL adapters.)
  - If stdin is not a tty and no target flag is given: error with guidance
    (never make surprise bulk changes).
- `uninstall [--terminal <id>...] [--all]`
  - Same interactive multi-select (defaulted to currently-integrated terminals)
    when run on a tty with no target flags; restores each selected terminal from
    its backup and removes the climon profile/hook.

**Onboarding integration:** `climon setup` gains a yes/no prompt —
*"Install shell integration?"*. If accepted, it invokes the
`shell-integration install` command, which presents the interactive
multi-select (pre-checked to "all detected") so the user can choose which
terminals/distros to install on before confirming. Declining skips it and
changes nothing.

### Adapter ids

- `apple-terminal`, `iterm2`, `windows-terminal`, `vscode`, `gnome-terminal`,
  `konsole`
- `wsl:<distro>` (one per installed distro, e.g. `wsl:Ubuntu`)

## Architecture

New client-side crate **`climon-shellint`** (sibling to `climon-install`),
wired into `climon-cli`. Isolates terminal-config parsing/editing so each
terminal's logic is independently testable.

### `TerminalAdapter` trait

```rust
trait TerminalAdapter {
    fn id(&self) -> &str;
    fn display_name(&self) -> &str;
    fn detect(&self, env: &Env) -> Option<Detected>;   // present on this machine?
    fn status(&self, env: &Env) -> IntegrationState;   // NotInstalled | Installed { is_default }
    fn install(&self, opts: &InstallOpts, io: &mut Io) -> Result<Change>;
    fn uninstall(&self, env: &Env, io: &mut Io) -> Result<()>;
}
```

A **registry** enumerates the adapters available for the current OS (plus one
`wsl:<distro>` adapter per detected distro on Windows). The multi-select UI is a
thin layer over the registry: it enumerates `detect()`/`status()` results and
drives `install`/`uninstall` on the chosen subset. It does not change the
architecture.

### Fallback wrapper (shim script)

A generated shim per platform lives in
`$CLIMON_HOME/shell-integration/`:

- Unix (`climon-shell.sh`):
  `exec climon shell || { echo "climon unavailable — monitoring off" >&2; exec "$SHELL" -l; }`
- Windows (`climon-shell.cmd` / `climon-shell.ps1`): equivalent, falling back to
  `%ComSpec%` / the configured shell.

Adapters point their profile command at this shim. Centralising fallback logic
keeps per-app config trivial and satisfies invariant #1 even when the `climon`
binary itself is missing (a `climon shell`-only approach cannot, since there is
nothing to fall back to when the binary is gone).

### Backup manifest

`$CLIMON_HOME/shell-integration/manifest.json` records, per adapter:

- config file path,
- a timestamped backup copy,
- what was added (profile id/GUID, rc-hook block markers),
- prior-default value (for `--set-default` restore).

`uninstall` and `status` read this manifest. Distro-side edits (rc files, shim)
are recorded with backups kept inside that distro's `$CLIMON_HOME`.

## Per-terminal mechanisms

Each adapter adds a **"climon" profile** pointing at the fallback shim.
`--set-default` saves the prior default before switching.

### macOS

- **Terminal.app** (`apple-terminal`): edit the `com.apple.Terminal` plist — add
  a settings set named "climon" whose command runs the shim (run command, not
  inside a shell). `--set-default` sets `Default Window Settings` /
  `Startup Window Settings`, saving prior values. Back up the plist first.
  Requires a Terminal restart (surfaced to the user).
- **iTerm2** (`iterm2`): edit `com.googlecode.iterm2.plist` — add a Profile with
  a generated GUID and `Custom Command` = shim. `--set-default` sets
  `Default Bookmark Guid`, saving prior. Back up the plist.

### Windows

- **Windows Terminal** (`windows-terminal`): JSONC edit of
  `…/LocalState/settings.json` (packaged, unpackaged, and Portable paths). Add a
  profile with a fixed climon GUID whose `commandline` = shim (`.cmd`/`.ps1`).
  `--set-default` sets `defaultProfile`, saving prior GUID. Comment/format
  preserving.

### Linux

- **GNOME Terminal** (`gnome-terminal`): via `gsettings`/`dconf` under
  `org.gnome.Terminal.ProfilesList` — create a profile UUID with
  `use-custom-command=true`, `custom-command` = shim. `--set-default` sets the
  `default` UUID, snapshotting prior values.
- **Konsole** (`konsole`): write `~/.local/share/konsole/climon.profile`
  (`Command=<shim>`) and, for `--set-default`, set `DefaultProfile` in
  `~/.config/konsolerc`, saving prior.

### VS Code (all OSes)

- (`vscode`): JSONC edit of user `settings.json` — add
  `terminal.integrated.profiles.<os>."climon"` → `{ "path": <shim/shell>,
  "args": [...] }`; `--set-default` sets
  `terminal.integrated.defaultProfile.<os>`, saving prior. Comment preserving.

## WSL

A WSL shell runs *inside* the distro, so monitoring requires the **Linux
`climon` inside the distro**. The Windows `climon.exe` cannot monitor a Linux
PTY directly.

To catch **bare `wsl.exe`** (and `wsl -d X`, Run-dialog launches, and Windows
Terminal WSL profiles alike), the integration lives in the distro's **login
shell startup**, not in any Windows terminal profile.

**Detection:** on Windows, enumerate distros via `wsl.exe -l -q`; each becomes a
`wsl:<distro>` adapter.

**Per-distro install:**

1. **Ensure Linux climon in the distro** and drop the Linux fallback shim in the
   distro's `$CLIMON_HOME/shell-integration/`. If `wsl.exe -d <distro> -- climon
   --version` fails, offer to install it (reuse `climon-install`'s Linux path,
   invoked via `wsl.exe -d <distro> -- <installer>`).
2. **Inject a guarded rc hook** — a clearly-marked, idempotent block
   (`# >>> climon shell-integration >>>` … `# <<<`) appended to `~/.bashrc`,
   `~/.zshrc`, and `~/.profile` in the distro user's home. The files are backed
   up first; uninstall removes the block. The hook runs **only when all** guards
   hold:
   - interactive shell (`[[ $- == *i* ]]`),
   - stdin is a tty,
   - **not already inside climon** (`[ -z "$CLIMON_SESSION_ID" ]`) — recursion
     guard using the env marker climon exports into child shells
     (`climon-session/src/host.rs:767`),
   - climon is runnable (`command -v climon`), else fall through untouched.

   When all hold: `exec` the fallback shim (`exec climon shell` → on failure the
   shim `exec`s `$SHELL` and warns). Because climon's spawned shell inherits
   `CLIMON_SESSION_ID`, its rc re-run hits the guard and does nothing → no
   recursion.

`--set-default` does not apply to WSL adapters. There is no Windows Terminal
WSL-profile edit: the rc hook already covers WSL launches through that profile,
so editing it would be purely cosmetic (dropped, YAGNI).

**Safety:** the rc hook is interactive-shell interception scoped to one distro,
guarded four ways, reversible, and fallback-protected. Non-interactive
`bash script.sh` inside the distro is never touched.

**Reuse:** `is_wsl` detection and the WSL networking bridge already exist in
`climon-remote`. `climon-shellint` needs distro enumeration + cross-boundary
invoke helpers, shared with `climon-remote`'s WSL helpers rather than
duplicated.

**Phase-2 note:** the same guarded-rc-hook mechanism could later be offered for
native Linux/macOS to catch bare tty / SSH logins. Not in v1.

## Config and parity

- Add a `shellIntegration` feature flag in **both**
  `rust/climon-config/src/features.rs` and `src/features.ts`, then run
  `bun scripts/gen-config-fixtures.ts` (Rust + Bun parity tests enforce it).
- Any new config settings go in both config-settings registries and
  `src/config-settings.ts`, regenerated via `bun run docs:config`, kept
  backward compatible.
- No secrets in config.

## Error handling

- Detect-before-touch, back-up-before-write.
- Comment/format-preserving JSONC edits; plist edits via `defaults` / plist libs.
- Idempotent install.
- Best-effort per adapter: one terminal failing does not abort `--all`; report
  per-terminal results.
- Clear "restart this terminal to take effect" messaging where needed.

## Testing

- **Unit tests per adapter** against fixture config files (plist, JSONC,
  dconf dumps, konsolerc, rc files): install → assert exact diff; uninstall →
  assert byte-for-byte restore; install-twice → idempotent.
- **Pure-function tests** for the rc-hook guard string and the JSONC/plist
  editors.
- **Integration-only** live OS walkers (plist `defaults`, `gsettings`,
  `wsl.exe -l`), mirroring how `detect_shell` / `path` are tested.
- **Manual checks** (repo convention): a `docs/manual-tests/<feature>.md` with a
  config-matrix cell and numbered steps per platform, including WSL and the
  fallback-when-climon-missing case.

## Documentation

- `README.md` — user workflow for enabling/disabling shell integration.
- `docs/architecture.md` — new `climon-shellint` crate + data flow.
- `docs/features.md` — feature catalogue entry.
- `docs/security.md` — rc-hook safety model + WSL cross-boundary trust.
- `docs/setup.md` / `docs/usage.md` — command and onboarding changes.

## Open questions

None outstanding. Approaches A and C are explicitly rejected above.
