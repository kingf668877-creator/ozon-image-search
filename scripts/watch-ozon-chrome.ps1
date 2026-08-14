# OZON Chrome watchdog: auto restart headless Chrome when CDP is down.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/watch-ozon-chrome.ps1
# Set this as a Windows Task Scheduler "on logon" task to keep Chrome alive.

$ErrorActionPreference = 'Continue'
$port = if ($env:OZON_CDP_PORT) { [int]$env:OZON_CDP_PORT } else { 9225 }
$startScript = Join-Path $PSScriptRoot 'start-ozon-headless.ps1'
$checkIntervalSec = 10

function Test-Cdp {
    try {
        $resp = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json') -TimeoutSec 3
        return $resp -and $resp.Count -gt 0
    } catch {
        return $false
    }
}

function Test-OzonTab {
    try {
        $tabs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json') -TimeoutSec 3
        return (@($tabs | Where-Object { $_.url -like '*ozon.ru*' }).Count) -gt 0
    } catch {
        return $false
    }
}

function Start-Chrome {
    Write-Host ('[WATCH] ' + (Get-Date -Format 'HH:mm:ss') + ' CDP unavailable, restarting headless Chrome')
    try {
        & $startScript
    } catch {
        Write-Warning ('[WATCH] start failed: ' + $_.Exception.Message)
    }
}

function Open-OzonTab {
    Write-Host ('[WATCH] ' + (Get-Date -Format 'HH:mm:ss') + ' CDP ok but no OZON tab, opening https://www.ozon.ru/')
    try {
        Add-Type -AssemblyName System.Net.WebSockets -ErrorAction SilentlyContinue
        $tabs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json') -TimeoutSec 3
        $target = @($tabs | Where-Object { $_.type -eq 'page' })[0]
        if (-not $target) { return }
        $ws = New-Object System.Net.WebSockets.ClientWebSocket
        $uri = [Uri]$target.webSocketDebuggerUrl
        $cts = New-Object System.Threading.CancellationTokenSource
        $ws.ConnectAsync($uri, $cts.Token).GetAwaiter().GetResult() | Out-Null
        $msg = '{"id":1,"method":"Page.navigate","params":{"url":"https://www.ozon.ru/"}}'
        $buf = [System.Text.Encoding]::UTF8.GetBytes($msg)
        $segment = New-Object System.ArraySegment[byte] $buf
        $ws.SendAsync($segment, [System.Net.WebSockets.WebSocketMessageType]::Text, $true, $cts.Token).GetAwaiter().GetResult() | Out-Null
        Start-Sleep -Seconds 2
        try { $ws.CloseAsync().GetAwaiter().GetResult() | Out-Null } catch {}
    } catch {
        Write-Warning ('[WATCH] open ozon tab failed: ' + $_.Exception.Message)
    }
}

Write-Host ('[WATCH] ozon chrome watchdog started, cdp port=' + $port)
while ($true) {
    if (-not (Test-Cdp)) {
        Start-Chrome
    } elseif (-not (Test-OzonTab)) {
        Open-OzonTab
    }
    Start-Sleep -Seconds $checkIntervalSec
}
