#!/bin/sh
# climon installer for Linux and macOS.
#
# Downloads the latest release archive for this platform from GitHub, extracts
# it, and runs the bundled self-installer (which places `climon` and
# `climon-server` on your PATH).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/jackgeek/climon/main/install.sh | sh
#
# climon's release binaries are not code-signed or notarized. Because this
# script fetches them with curl (not a browser), macOS does not apply the
# Gatekeeper quarantine flag; we also strip it defensively before installing so
# the binaries run without "cannot be opened because the developer cannot be
# verified" prompts. Subsequent `climon update` downloads are still verified
# against climon's embedded Ed25519 signing key.

set -eu

REPO="jackgeek/climon"

fail() {
	echo "climon install: $1" >&2
	exit 1
}

need() {
	command -v "$1" >/dev/null 2>&1 || fail "required command '$1' not found on PATH"
}

need curl
need unzip

os="$(uname -s)"
arch="$(uname -m)"

case "$os" in
	Linux) plat_os="linux" ;;
	Darwin) plat_os="darwin" ;;
	*) fail "unsupported operating system: $os (use install.ps1 on Windows)" ;;
esac

case "$arch" in
	x86_64 | amd64) plat_arch="x64" ;;
	arm64 | aarch64) plat_arch="arm64" ;;
	*) fail "unsupported architecture: $arch" ;;
esac

asset="climon-${plat_os}-${plat_arch}.zip"
url="https://github.com/${REPO}/releases/latest/download/${asset}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading ${asset} ..."
curl -fSL "$url" -o "$tmp/climon.zip" || fail "download failed: $url"

echo "Extracting ..."
unzip -q "$tmp/climon.zip" -d "$tmp" || fail "could not extract archive"

# Strip the macOS quarantine flag so the unsigned binaries launch without
# Gatekeeper prompts. Harmless (and skipped) on Linux.
if [ "$plat_os" = "darwin" ]; then
	xattr -dr com.apple.quarantine "$tmp" >/dev/null 2>&1 || true
fi

[ -f "$tmp/install" ] || fail "installer binary 'install' missing from archive"
chmod +x "$tmp/install" "$tmp/climon-server" 2>/dev/null || true

echo "Installing ..."
"$tmp/install"
