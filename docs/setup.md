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
    "clampBrowserToHost": true
  }
}
```

climon generates these comments automatically from the settings registry. See `climon config --help` or the [configuration reference](./usage.md#climon-config) for all available settings.

- Set `CLIMON_HOME` to use a different state directory (useful for testing).
- `--port N` flag on `climon server` overrides the port at runtime.

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

The remote-client feature uses Microsoft dev tunnels. Install the `devtunnel`
CLI on the home machine if you want the dashboard to auto-create and host the
tunnel; install it on each devbox so `climon __uplink` can connect through the
tunnel. You can also create the tunnel manually and paste its id/URL plus
connect token into the dashboard's **Remotes…** dialog. See
[security.md](./security.md) for the threat model.

Manual tunnel creation on the home machine:

```bash
devtunnel user login
devtunnel create climon-tunnel
devtunnel port create climon-tunnel -p 8080
devtunnel token climon-tunnel --scopes connect
```

Paste the tunnel id and emitted connect token into **Remotes…**, then run the
dialog's generated config script on the devbox.
