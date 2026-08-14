# OZON Image Search - Headless Chrome starter (no window)
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/start-ozon-headless.ps1
# Env vars:
#   OZON_CHROME_PATH  default: C:\Program Files\Google\Chrome\Application\chrome.exe
#   OZON_CDP_PORT     default: 9225
#   OZON_PROFILE_DIR  default: %LOCALAPPDATA%\OzonImageSearchChrome

$ErrorActionPreference = 'Stop'

$chrome = $env:OZON_CHROME_PATH
if (-not $chrome -or -not (Test-Path $chrome)) {
    $chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
}
if (-not (Test-Path $chrome)) {
    $candidates = @(
        'C:\Program Files\Google\Chrome\Application\chrome.exe',
        'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe',
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    )
    foreach ($c in $candidates) { if (Test-Path $c) { $chrome = $c; break } }
}
if (-not (Test-Path $chrome)) {
    Write-Error 'chrome.exe not found, set OZON_CHROME_PATH'
    exit 1
}

$port = if ($env:OZON_CDP_PORT) { [int]$env:OZON_CDP_PORT } else { 9225 }
$profile = if ($env:OZON_PROFILE_DIR) { $env:OZON_PROFILE_DIR } else { Join-Path $env:LOCALAPPDATA 'OzonImageSearchChrome' }
if (-not (Test-Path $profile)) { New-Item -ItemType Directory -Path $profile | Out-Null }

# If something already listens on the CDP port, reuse it instead of relaunching
# (otherwise we would wipe the logged-in user profile that a visible Chrome owns).
$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    try {
        $tabs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json') -TimeoutSec 2
        Write-Host ('[OZON HEADLESS] CDP already up on port ' + $port + ', ' + $tabs.Count + ' tab(s); skipping launch')
        exit 0
    } catch {
        Write-Warning '[OZON HEADLESS] CDP port busy but not reachable; remove stale process manually'
        exit 1
    }
}

$args = @(
    '--headless=new'
    '--disable-gpu'
    '--no-sandbox'
    '--no-first-run'
    '--no-default-browser-check'
    '--disable-dev-shm-usage'
    '--disable-background-networking'
    '--disable-extensions'
    '--disable-default-apps'
    '--disable-popup-blocking'
    "--remote-debugging-address=127.0.0.1"
    "--remote-debugging-port=$port"
    "--user-data-dir=`"$profile`""
    '--window-size=1366,900'
    'about:blank'
)

Write-Host ('[OZON HEADLESS] chrome=' + $chrome)
Write-Host ('[OZON HEADLESS] profile=' + $profile)
Write-Host ('[OZON HEADLESS] cdpPort=' + $port)

$proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru -WindowStyle Hidden
Write-Host ('[OZON HEADLESS] pid=' + $proc.Id)

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    try {
        $tabs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json') -TimeoutSec 2
        if ($tabs -and $tabs.Count -gt 0) {
            Write-Host ('[OZON HEADLESS] CDP up, ' + $tabs.Count + ' tab(s)')
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
Write-Warning ('[OZON HEADLESS] CDP startup timeout, please check chrome.exe and port ' + $port)
exit 1
