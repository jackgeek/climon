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

function Get-ClimonConfigValue {
  param([string]$Key)
  $result = Invoke-DiagnosticCommand "climon config $Key" "climon" @("config", $Key)
  $value = if ($result.exitCode -eq 0) { $result.output } else { $null }
  if ($Key -eq "remote.tunnelToken") {
    $value = Redact-Secret $value
  }
  [pscustomobject]@{
    key = $Key
    value = $value
    exitCode = $result.exitCode
    error = if ($result.exitCode -eq 0) { $null } else { $result.output }
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
        status = $meta.status
        socketPath = $meta.socketPath
        daemonPid = $meta.daemonPid
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

$uplinkPidPath = Join-Path $ClimonHome "uplink.pid"
$sessionsPath = Join-Path $ClimonHome "sessions"
$climon = Test-CommandAvailable "climon"
$devtunnel = Test-CommandAvailable "devtunnel"

$configKeys = @(
  "remote.enabled",
  "remote.host",
  "remote.tunnelId",
  "remote.tunnelToken",
  "remote.port",
  "remote.clientId",
  "session.color",
  "session.priority"
)
$config = @()
if ($climon.available) {
  foreach ($key in $configKeys) {
    $config += Get-ClimonConfigValue $key
  }
}

$portValue = ($config | Where-Object { $_.key -eq "remote.port" }).value
$port = 3132
if ($portValue) {
  $parsedPort = 0
  if ([int]::TryParse([string]$portValue, [ref]$parsedPort)) {
    $port = $parsedPort
  }
}

$hostValue = ($config | Where-Object { $_.key -eq "remote.host" }).value
$targetHost = if ($hostValue) { [string]$hostValue } else { "127.0.0.1" }

$commands = @()
if ($devtunnel.available) {
  $commands += Invoke-DiagnosticCommand "devtunnel --version" "devtunnel" @("--version")
}

$report = [pscustomobject]@{
  role = "devbox"
  generatedAt = (Get-Date).ToString("o")
  climonHome = $ClimonHome
  commands = @(
    $climon
    Test-CommandAvailable "climon-server"
    $devtunnel
  )
  config = $config
  uplink = [pscustomobject]@{
    pidFile = Get-PidFileStatus $uplinkPidPath
    processes = @(Get-CommandLineMatches "climon.*__uplink|climon.*uplink")
  }
  tunnelForward = [pscustomobject]@{
    expectedLocalEndpoint = "$targetHost`:$port"
    port = Test-TcpPort $targetHost $port
    commands = $commands
    connectProcesses = @(Get-CommandLineMatches "devtunnel.*connect")
  }
  sessions = Get-SessionSummary $sessionsPath
}

if ($Json) {
  $report | ConvertTo-Json -Depth 8
} else {
  Write-Host "climon devbox diagnostics"
  Write-Host "Generated: $($report.generatedAt)"
  Write-Host "CLIMON_HOME: $ClimonHome"
  Write-Host ""
  Write-Host "Command availability:"
  $report.commands | Format-Table -AutoSize | Out-String | Write-Host
  Write-Host "Config:"
  $report.config | Format-Table -AutoSize | Out-String | Write-Host
  Write-Host "Uplink:"
  $report.uplink | ConvertTo-Json -Depth 5
  Write-Host "Tunnel forward:"
  $report.tunnelForward | ConvertTo-Json -Depth 6
  Write-Host "Sessions:"
  $report.sessions | ConvertTo-Json -Depth 5
}
