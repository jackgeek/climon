param(
  [switch]$Json,
  [string]$ClimonHome = $env:CLIMON_HOME
)

$ErrorActionPreference = "Continue"

if ([string]::IsNullOrWhiteSpace($ClimonHome)) {
  $ClimonHome = Join-Path $HOME ".climon"
}

function Redact-Secret {
  param([AllowNull()]$Value)
  if ($null -eq $Value) { return $null }
  $text = [string]$Value
  if ($text.Length -eq 0) { return "" }
  return "<redacted>"
}

function Invoke-DiagnosticCommand {
  param(
    [string]$Name,
    [string]$FilePath,
    [string[]]$Arguments = @()
  )
  try {
    $output = & $FilePath @Arguments 2>&1 | Out-String
    [pscustomobject]@{
      name = $Name
      command = "$FilePath $($Arguments -join ' ')".Trim()
      exitCode = $LASTEXITCODE
      output = $output.Trim()
    }
  } catch {
    [pscustomobject]@{
      name = $Name
      command = "$FilePath $($Arguments -join ' ')".Trim()
      exitCode = $null
      output = $_.Exception.Message
    }
  }
}

function Test-CommandAvailable {
  param([string]$Command)
  $cmd = Get-Command $Command -ErrorAction SilentlyContinue
  [pscustomobject]@{
    command = $Command
    available = $null -ne $cmd
    path = if ($cmd) { $cmd.Source } else { $null }
  }
}

function Test-TcpPort {
  param(
    [string]$TargetHost,
    [int]$Port,
    [int]$TimeoutMs = 1500
  )
  $client = [System.Net.Sockets.TcpClient]::new()
  try {
    $async = $client.BeginConnect($TargetHost, $Port, $null, $null)
    $ok = $async.AsyncWaitHandle.WaitOne($TimeoutMs)
    if ($ok) {
      $client.EndConnect($async)
    }
    [pscustomobject]@{
      host = $TargetHost
      port = $Port
      reachable = [bool]($ok -and $client.Connected)
    }
  } catch {
    [pscustomobject]@{
      host = $TargetHost
      port = $Port
      reachable = $false
      error = $_.Exception.Message
    }
  } finally {
    $client.Close()
  }
}

function Read-JsonObject {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ exists = $false; path = $Path }
  }
  try {
    $raw = Get-Content -LiteralPath $Path -Raw
    $data = $raw | ConvertFrom-Json
    [pscustomobject]@{ exists = $true; path = $Path; data = $data }
  } catch {
    [pscustomobject]@{ exists = $true; path = $Path; error = $_.Exception.Message }
  }
}

function Get-PidFileStatus {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) {
    return [pscustomobject]@{ exists = $false; path = $Path }
  }
  $text = (Get-Content -LiteralPath $Path -Raw).Trim()
  $pidValue = 0
  $parsed = [int]::TryParse($text, [ref]$pidValue)
  $process = if ($parsed -and $pidValue -gt 0) { Get-Process -Id $pidValue -ErrorAction SilentlyContinue } else { $null }
  [pscustomobject]@{
    exists = $true
    path = $Path
    pid = if ($parsed) { $pidValue } else { $null }
    alive = $null -ne $process
    processName = if ($process) { $process.ProcessName } else { $null }
  }
}

function Get-SessionSummary {
  param([string]$SessionsPath)
  if (-not (Test-Path -LiteralPath $SessionsPath)) {
    return [pscustomobject]@{ path = $SessionsPath; exists = $false; count = 0; sessions = @() }
  }
  $items = @()
  foreach ($file in Get-ChildItem -LiteralPath $SessionsPath -Filter "*.json" -File -ErrorAction SilentlyContinue) {
    try {
      $meta = Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json
      $items += [pscustomobject]@{
        id = $meta.id
        origin = $meta.origin
        clientLabel = $meta.clientLabel
        status = $meta.status
        socketPath = $meta.socketPath
        updatedAt = $meta.updatedAt
      }
    } catch {
      $items += [pscustomobject]@{ id = $file.BaseName; error = $_.Exception.Message }
    }
  }
  [pscustomobject]@{ path = $SessionsPath; exists = $true; count = $items.Count; sessions = $items }
}

function Get-CommandLineMatches {
  param([string]$Pattern)
  try {
    Get-CimInstance Win32_Process |
      Where-Object { $_.CommandLine -match $Pattern } |
      Select-Object ProcessId, Name, CommandLine
  } catch {
    @()
  }
}

$remoteHostPath = Join-Path $ClimonHome "remote-host.json"
$ingestPidPath = Join-Path $ClimonHome "ingest.pid"
$sessionsPath = Join-Path $ClimonHome "sessions"
$remoteHost = Read-JsonObject $remoteHostPath
$remoteHostData = $remoteHost.data
$ingestPort = if ($remoteHostData -and $remoteHostData.ingestPort) { [int]$remoteHostData.ingestPort } else { 3132 }
$ingestHost = if ($remoteHostData -and $remoteHostData.ingestHost) { [string]$remoteHostData.ingestHost } else { "127.0.0.1" }

$redactedRemoteHost = $null
if ($remoteHostData) {
  $redactedRemoteHost = [pscustomobject]@{
    tunnelId = $remoteHostData.tunnelId
    ingestPort = $remoteHostData.ingestPort
    ingestHost = $remoteHostData.ingestHost
    canHost = $remoteHostData.canHost
  }
}

$devtunnel = Test-CommandAvailable "devtunnel"
$commands = @()
if ($devtunnel.available) {
  $commands += Invoke-DiagnosticCommand "devtunnel --version" "devtunnel" @("--version")
  $commands += Invoke-DiagnosticCommand "devtunnel list" "devtunnel" @("list")
  if ($remoteHostData -and $remoteHostData.tunnelId) {
    $commands += Invoke-DiagnosticCommand "devtunnel port list" "devtunnel" @("port", "list", $remoteHostData.tunnelId)
  }
}

$report = [pscustomobject]@{
  role = "home"
  generatedAt = (Get-Date).ToString("o")
  climonHome = $ClimonHome
  commands = @(
    Test-CommandAvailable "climon"
    Test-CommandAvailable "climon-server"
    $devtunnel
  )
  remoteHost = [pscustomobject]@{
    exists = $remoteHost.exists
    path = $remoteHost.path
    data = $redactedRemoteHost
    error = $remoteHost.error
  }
  ingest = [pscustomobject]@{
    pidFile = Get-PidFileStatus $ingestPidPath
    port = Test-TcpPort $ingestHost $ingestPort
  }
  devtunnel = [pscustomobject]@{
    commands = $commands
    hostProcesses = @(Get-CommandLineMatches "devtunnel.*host")
  }
  sessions = Get-SessionSummary $sessionsPath
}

if ($Json) {
  $report | ConvertTo-Json -Depth 8
} else {
  Write-Host "climon home diagnostics"
  Write-Host "Generated: $($report.generatedAt)"
  Write-Host "CLIMON_HOME: $ClimonHome"
  Write-Host ""
  Write-Host "Command availability:"
  $report.commands | Format-Table -AutoSize | Out-String | Write-Host
  Write-Host "Remote host state:"
  $report.remoteHost | ConvertTo-Json -Depth 5
  Write-Host "Ingest:"
  $report.ingest | ConvertTo-Json -Depth 5
  Write-Host "Devtunnel:"
  $report.devtunnel | ConvertTo-Json -Depth 6
  Write-Host "Sessions:"
  $report.sessions | ConvertTo-Json -Depth 5
}
