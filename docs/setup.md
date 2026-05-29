# Setup

## Prerequisites

- **Bun >= 1.3.0.** climon relies on Bun's native PTY (`Bun.Terminal`), which is
  only available in recent Bun releases. Check with `bun --version`.

No other runtime dependencies are required — there is **no tmux and no ttyd**.

### Installing Bun

- **macOS / Linux / WSL:**
  ```bash
  curl -fsSL https://bun.sh/install | bash
  ```
  Ensure `~/.bun/bin` is on your `PATH`.
- **Windows:** PTY mode is POSIX-only at the Bun layer for the terminal feature;
  on Windows, run climon under **WSL** for the interactive PTY experience.

## Install dependencies

```bash
bun install
```

This fetches `@xterm/xterm` and `@xterm/addon-fit` (vendored for the dashboard).

## Making `climon` available on your PATH

The CLI entrypoint is `src/index.ts` (declared as the `climon` bin in
`package.json`). For local development you can run it directly:

```bash
bun src/index.ts <args>
```

To get a real `climon` command, link the package:

```bash
bun link        # in the project root
```

Then `climon ...` is available globally (so you can prefix any command with it).

## Configuration

On first run, climon writes `~/.climon/config.json`:

```json
{
  "version": 1,
  "server": { "host": "127.0.0.1", "port": 3131, "lan": false, "token": "<random>" },
  "terminal": { "clampBrowserToHost": true }
}
```

- Set `CLIMON_HOME` to use a different state directory (useful for testing).
- `--port N` and `--lan` flags on `climon server` override host/port/lan.
- The `token` is required for non-localhost (LAN) access.
- `terminal.clampBrowserToHost` (default `true`) stops a browser viewer from
  growing the shared PTY beyond the local terminal that launched the session.
  The local terminal renders raw PTY output and cannot reflow, so a larger
  browser viewport would otherwise mangle its rendering. With clamping on, both
  views show the same content. Set it to `false` to let the browser drive the
  full PTY size (restart the affected session daemon for the change to apply).

## Verify the install

```bash
bun run typecheck   # tsc --noEmit
bun test tests      # unit tests
```

Then start the server and a session:

```bash
bun src/index.ts server      # terminal 1
bun src/index.ts echo hello  # terminal 2
```

Open http://127.0.0.1:3131 — you should see the session and its output.
