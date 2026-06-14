# Setup

## Prerequisites

- **Bun >= 1.3.0.** climon relies on Bun's native PTY (`Bun.Terminal`), which is
  only available in recent Bun releases. Check with `bun --version`.

No other runtime dependencies are required.

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

On first run, climon writes `~/.climon/config.jsonc`:

```jsonc
{
  // Schema version for the persisted config.json format. Always 1 for the current release.
  "version": 1,
  "server": {
    // IP address the dashboard server binds to. Defaults to loopback for local-only access.
    "host": "127.0.0.1",
    // TCP port the dashboard server listens on. Change if 3131 conflicts with another service.
    "port": 3131
  },
  "terminal": {
    // When true (default), a browser viewer cannot grow the shared PTY beyond the host terminal's dimensions to prevent content mangling.
    "clampBrowserToHost": true,
    // Byte value of the detach key prefix (default 0x1c = Ctrl-\). Press prefix then 'd' to detach without stopping the command. Must be an integer in [0, 255].
    "detachPrefix": 28,
    // When true (default), climon sets the attached local terminal's title to the session name and updates it live on rename. Disables the whole title feature when false.
    "setTitle": true
  },
  "attention": {
    // Number of seconds the rendered terminal grid must remain unchanged before the session is flagged as needing attention. Set to 0 or negative to disable static-screen detection.
    "idleSeconds": 10
  },
  "session": {
    // Specifies the default accent color for new sessions. Accepts ANSI color names (red, green, etc.), 'none', or 'auto' for automatic assignment.
    "color": "auto",
    // Default sort priority (0-1000) for new sessions. Lower numbers sort first within each status group.
    "priority": 500
  }
}
```

climon generates these comments automatically from the settings registry. See `climon config --help` or the [configuration reference](./usage.md#climon-config) for all available settings.

- Set `CLIMON_HOME` to use a different state directory (useful for testing).
- `--port N` flag on `climon server` overrides the port at runtime.
- `--no-takeover` flag on `climon server` starts on the next available port
  instead of terminating an existing dashboard server.

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

## Remote clients

The remote-client feature uses Microsoft dev tunnels with identity-based access.
Install the `devtunnel` CLI on the home machine if you want the dashboard to
auto-create and host the tunnel; install it on each devbox so `climon __uplink`
can connect through the tunnel. The devbox must be logged into `devtunnel` with
the same identity that owns the tunnel. See [security.md](./security.md) for the
threat model.

Manual tunnel creation on the home machine:

```bash
devtunnel user login
devtunnel create climon-tunnel
devtunnel port create climon-tunnel -p 8080
```

Paste the tunnel id into **Remotes…**, then run the dialog's generated config
script on the devbox. Ensure the devbox is also logged in (`devtunnel user login`).
