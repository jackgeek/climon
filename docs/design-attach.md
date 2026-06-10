# `climon attach` — Design Feasibility

## Goal

Allow a user to run `climon attach` from within an **already-running** shell
session (PowerShell, cmd, bash/WSL, etc.) and have that command return
immediately, with the session now live and visible in the climon dashboard/server.

This is the inverse of `climon <command>` (which starts a new PTY-owned process).

## The Core Challenge

climon's architecture requires **PTY ownership** — the daemon holds the master
side of a pseudo-terminal, spawns the child process inside it, and relays I/O to
clients and the dashboard. This is what gives it full control over scrollback,
resize, attention detection, and remote viewing.

When a user runs `climon attach` from an existing shell:

1. **The shell already has a controlling terminal** — it is attached to the
   user's terminal emulator (Windows Terminal, iTerm, etc.).
2. **climon does not own that PTY** — the terminal emulator does.
3. **Two readers on one stdin is impossible** — once `climon attach` exits, it
   has no file descriptors to the terminal. Even if it forked a background
   process, that process would compete with the shell for stdin.

## Why This Cannot Work Directly

| Constraint | Why it blocks |
|---|---|
| PTY master ownership | climon needs the master FD to relay I/O; the terminal emulator already owns it |
| Process already running | You cannot retroactively re-parent a process's controlling terminal (except via `ptrace`/`reptyr` on Linux — not portable, not on Windows) |
| Exit semantics | Once `climon attach` exits, the shell reclaims stdin — there is no way to keep relaying |
| Windows | ConPTY does not support "adopting" an existing console session from another process |

## Feasible Alternatives

### Option A: `climon shell` (Recommended)

Instead of attaching to an existing session, start a new shell **through** climon:

```
climon shell          # starts $SHELL (or PowerShell on Windows) in a new climon session
climon powershell     # explicit
climon bash
```

This already works today (`climon powershell` etc.). The user gets a shell that
is climon-managed from the start. The session appears in the dashboard
immediately.

**Gap from the request:** The user has to "start fresh" — they can't retroactively
promote an existing session.

### Option B: `climon wrap` — PTY-in-PTY interposition

`climon attach` (or `climon wrap`) could:

1. Allocate a new PTY pair (master/slave)
2. Start the daemon owning that PTY
3. **Exec** the user's default shell as the PTY child (replacing the current
   process via `exec`)

From the user's perspective, their prompt "restarts" but they're now inside a
climon session. This is essentially `exec climon shell` but packaged as a single
command.

**Pros:** Works cross-platform, fits the architecture perfectly.
**Cons:** Loses the current shell's state (history cursor position, local vars,
running jobs). It's really just `climon $SHELL` with extra steps.

### Option C: `climon inject` — Shell integration hooks (Partial capture)

Install shell hooks (like VS Code's terminal shell integration) that report:
- Working directory changes
- Command starts/completions  
- Exit codes

This wouldn't give full terminal capture (no scrollback, no remote viewing of
live output), but would make the session **visible** in the dashboard with
metadata like "last command: `git pull`", status, etc.

```
# User runs:
eval "$(climon inject)"   # installs PROMPT_COMMAND / precmd hooks
```

**Pros:** Non-invasive, works retroactively, no PTY re-parenting needed.
**Cons:** No live terminal streaming, no scrollback capture, no remote input.
This is more "session tracking" than "session management."

### Option D: `climon record` — Output-only capture (Unix only)

Similar to the `script` command — interposes a PTY between the terminal and the
shell via `exec`:

```bash
exec climon record   # replaces current shell with climon-managed PTY + new shell
```

On Linux/macOS, `exec` replaces the process in-place so the terminal emulator
doesn't notice. The new PTY is owned by climon's daemon, and the shell runs
inside it.

**Pros:** Closest to "retroactive attach" on Unix.
**Cons:** Doesn't work on Windows (no `exec` semantics for console processes).
Still loses shell state.

### Option E: Background relay daemon (Flawed)

`climon attach` could fork a background process that:
- Opens `/dev/tty` (Unix) or the console handle (Windows)
- Mirrors output to the climon server

**Why this fails:**
- Cannot intercept stdin (shell is reading it)
- Output-only capture is unreliable without PTY master access
- On Windows, cannot read another process's console buffer without elevated
  privileges and ConHost internals

## Recommendation

**Option A (`climon shell`) already exists and is the correct solution** for most
use cases. If users want their terminal to "just be" a climon session from the
start, the workflow is:

```
# Add to shell profile (.bashrc, PowerShell $PROFILE, etc.):
if (! $env:CLIMON_SESSION) { exec climon shell }
```

Or for a less invasive approach, Option C (`climon inject`) could provide
dashboard visibility without full PTY control — this would be new feature work.

## Summary

| Approach | Full PTY? | Cross-platform? | Retroactive? | Effort |
|---|---|---|---|---|
| A: `climon shell` | ✅ | ✅ | ❌ | Already exists |
| B: `climon wrap`/exec | ✅ | ✅ | Sort of (exec) | Low |
| C: `climon inject` | ❌ | ✅ | ✅ | Medium |
| D: `climon record` | ✅ | Unix only | Sort of (exec) | Medium |
| E: Background relay | ❌ | ❌ | ✅ | High (and broken) |

The short answer: **true retroactive attach is not possible** due to PTY
ownership semantics. The closest cross-platform solution is `exec climon shell`
(which replaces the current shell with a climon-managed one), or shell
integration hooks for metadata-only tracking.
