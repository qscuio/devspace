$ErrorActionPreference = "Stop"

$devspaceDir = $env:DEVSPACE_AUTOSTART_DIR
if (-not $devspaceDir) {
  $devspaceDir = "C:\Users\86182\Documents\Playground\devspace"
}

$cloudflared = $env:DEVSPACE_AUTOSTART_CLOUDFLARED
if (-not $cloudflared) {
  $cloudflared = "C:\Users\86182\Documents\Playground\bin\cloudflared.exe"
}

$cloudflaredOriginCert = $env:DEVSPACE_AUTOSTART_CLOUDFLARED_ORIGIN_CERT
if (-not $cloudflaredOriginCert) {
  $cloudflaredOriginCert = "C:\Users\86182\.cloudflared\cert.pem"
}

$logDir = $env:DEVSPACE_AUTOSTART_LOG_DIR
if (-not $logDir) {
  $logDir = "C:\Users\86182\Documents\Playground\devspace-service-logs"
}

$node = $env:DEVSPACE_AUTOSTART_NODE
if (-not $node) {
  $node = "C:\Program Files\nodejs\node.exe"
}

$configDir = $env:DEVSPACE_CONFIG_DIR
if (-not $configDir) {
  $env:DEVSPACE_CONFIG_DIR = "C:\Users\86182\.devspace"
}
$env:DEVSPACE_TRUST_PROXY = "1"

$tunnelName = $env:DEVSPACE_AUTOSTART_TUNNEL
if (-not $tunnelName) {
  $tunnelName = "devspace"
}

$originUrl = $env:DEVSPACE_AUTOSTART_ORIGIN_URL
if (-not $originUrl) {
  $originUrl = "http://127.0.0.1:7676"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Test-TcpPort {
  param(
    [string]$HostName,
    [int]$Port
  )

  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $async = $client.BeginConnect($HostName, $Port, $null, $null)
    if (-not $async.AsyncWaitHandle.WaitOne(1000)) {
      $client.Close()
      return $false
    }
    $client.EndConnect($async)
    $client.Close()
    return $true
  } catch {
    return $false
  }
}

function Start-HiddenProcess {
  param(
    [string]$FilePath,
    [string[]]$ArgumentList,
    [string]$WorkingDirectory,
    [string]$OutLog,
    [string]$ErrLog
  )

  $params = @{
    FilePath = $FilePath
    ArgumentList = $ArgumentList
    WindowStyle = "Hidden"
    RedirectStandardOutput = $OutLog
    RedirectStandardError = $ErrLog
    PassThru = $true
  }
  if ($WorkingDirectory) {
    $params.WorkingDirectory = $WorkingDirectory
  }

  return Start-Process @params
}

if (-not (Test-TcpPort -HostName "127.0.0.1" -Port 7676)) {
  Start-HiddenProcess `
    -FilePath $node `
    -ArgumentList @("dist\cli.js", "serve") `
    -WorkingDirectory $devspaceDir `
    -OutLog (Join-Path $logDir "devspace.out.log") `
    -ErrLog (Join-Path $logDir "devspace.err.log") | Out-Null
}

$cloudflaredRunning = Get-Process cloudflared -ErrorAction SilentlyContinue
if (-not $cloudflaredRunning) {
  Start-HiddenProcess `
    -FilePath $cloudflared `
    -ArgumentList @(
      "tunnel",
      "--origincert",
      $cloudflaredOriginCert,
      "run",
      "--url",
      $originUrl,
      $tunnelName
    ) `
    -WorkingDirectory (Split-Path -Parent $cloudflared) `
    -OutLog (Join-Path $logDir "cloudflared.out.log") `
    -ErrLog (Join-Path $logDir "cloudflared.err.log") | Out-Null
}
