# climon installer for Windows (PowerShell).
#
# Downloads the latest release archive from GitHub, extracts it, and runs the
# bundled self-installer (which places climon.exe and climon-server.exe on your
# PATH).
#
# Usage:
#   irm https://raw.githubusercontent.com/jackgeek/climon/main/install.ps1 | iex
#
# climon's release binaries are not Authenticode-signed. This script unblocks
# the downloaded files (clearing the "downloaded from the internet" mark) so
# they run without a SmartScreen "Windows protected your PC" prompt. Piping the
# script through `iex` runs it in-process, so no execution-policy change is
# needed; if you save it to a .ps1 file first, run it with
# `powershell -ExecutionPolicy Bypass -File install.ps1`. Subsequent
# `climon update` downloads are still verified against climon's embedded
# Ed25519 signing key.

$ErrorActionPreference = 'Stop'

$repo = 'jackgeek/climon'
$asset = 'climon-windows-x64.zip'
$url = "https://github.com/$repo/releases/latest/download/$asset"

$tmp = Join-Path $env:TEMP ("climon-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

try {
	$zip = Join-Path $tmp 'climon.zip'
	Write-Host "Downloading $asset ..."
	# TLS 1.2 for older Windows PowerShell hosts.
	[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
	Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing

	Write-Host "Extracting ..."
	Expand-Archive -Path $zip -DestinationPath $tmp -Force

	# Clear the Zone.Identifier mark so the unsigned binaries run without a
	# SmartScreen prompt.
	Get-ChildItem -Path $tmp -Recurse -File | Unblock-File

	$installer = Join-Path $tmp 'install.exe'
	if (-not (Test-Path $installer)) {
		throw "installer binary 'install.exe' missing from archive"
	}

	Write-Host "Installing ..."
	& $installer
}
finally {
	Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
