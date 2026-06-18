# Cheat sheet

Quick reference for installing and running climon. For full details see
[`docs/setup.md`](setup.md) and [`docs/usage.md`](usage.md).

## Install

Download the release zip for your platform, unzip it, and run the bundled
`install` binary (`install.exe` on Windows). It self-installs (copies itself to
`climon`, places `climon-server`, updates your PATH) and prints the changelog.

| Platform | Artifact |
| --- | --- |
| macOS (Apple Silicon) | `climon-darwin-arm64.zip` |
| macOS (Intel) | `climon-darwin-x64.zip` |
| Linux x64 | `climon-linux-x64.zip` |
| Linux arm64 | `climon-linux-arm64.zip` |
| Windows x64 | `climon-windows-x64.zip` |

## macOS: unsigned binary and Gatekeeper

The macOS binaries are **not** Apple Developer ID–signed or notarized. What you
hit depends on **how you download and unzip**, because macOS only applies the
`com.apple.quarantine` attribute to files that arrive via a browser or are
unzipped with Finder's Archive Utility.

### Recommended: download and unzip in Terminal (no Gatekeeper prompt)

Files fetched with `curl`/`wget` and unzipped with the `unzip` CLI are **not**
quarantined, so the installer runs without any Gatekeeper warning:

```bash
curl -fsSL -o climon.zip <release-url>/climon-darwin-arm64.zip
unzip climon.zip
./install
```

### If you downloaded via a browser (Gatekeeper blocks `install`)

Running `./install` then fails with *"install cannot be opened because the
developer cannot be verified."* Pick one of:

1. **Strip the quarantine attribute, then run** (works headless / over SSH):

   ```bash
   xattr -dr com.apple.quarantine /path/to/unzipped-folder
   ./install
   ```

2. **System Settings → Privacy & Security → "Open Anyway"** after the first
   blocked attempt, then re-run `./install`.

3. **Finder → right-click `install` → Open**, then confirm in the dialog.

You only need to do this **once**, for the initial `install` run. The
self-installer copies itself to `climon` and places `climon-server` with plain
file copies that do not carry the quarantine attribute forward, so the installed
binaries are clean and `climon --update` replacements won't re-trigger
Gatekeeper.

> Proper Apple Developer ID signing + notarization is a planned improvement; until
> then, the steps above are the supported way in.

## Common commands

```bash
climon server                 # start the dashboard (http://127.0.0.1:3131, localhost only)
climon <command>              # monitor any command (e.g. climon npm test)
climon --update               # download, verify, and apply the latest release
climon setup                  # re-run onboarding
climon config                 # view/edit configuration
```
