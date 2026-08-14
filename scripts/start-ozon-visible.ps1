# OZON Image Search - Visible Chrome starter (with login window)
# Use this once to log into OZON. Cookies are saved to the shared profile so the
# headless Chrome can reuse them later.
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts/start-ozon-visible.ps1
# Env vars:
#   OZON_CHROME_PATH  default: C:\Program Files\Google\Chrome\Application\chrome.exe
#   OZON_CDP_PORT     default: 9225
#   OZON_PROFILE_DIR  default: %LOCALAPPDATA%\OzonImageSearchChrome

$ErrorActionPreference = 'Stop'

$chrome = $env:OZON_CHROME_PATH
if (-not $chrome -or -not (Test-Path $chrome)) {
    $chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
}
$port = if ($env:OZON_CDP_PORT) { [int]$env:OZON_CDP_PORT } else { 9225 }
$profile = if ($env:OZON_PROFILE_DIR) { $env:OZON_PROFILE_DIR } else { Join-Path $env:LOCALAPPDATA 'OzonImageSearchChrome' }
if (-not (Test-Path $profile)) { New-Item -ItemType Directory -Path $profile | Out-Null }

$existing = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host ('[OZON VISIBLE] CDP already up on port ' + $port)
    exit 0
}

$args = @(
    '--no-sandbox'
    '--no-first-run'
    '--no-default-browser-check'
    '--disable-dev-shm-usage'
    '--disable-background-networking'
    '--disable-extensions'
    '--disable-default-apps'
    "--remote-debugging-address=127.0.0.1"
    "--remote-debugging-port=$port"
    "--user-data-dir=`"$profile`""
    '--window-size=1366,900'
    'https://www.ozon.ru/'
)

Write-Host ('[OZON VISIBLE] chrome=' + $chrome)
Write-Host ('[OZON VISIBLE] profile=' + $profile)
Write-Host ('[OZON VISIBLE] cdpPort=' + $port)

$proc = Start-Process -FilePath $chrome -ArgumentList $args -PassThru
Write-Host ('[OZON VISIBLE] pid=' + $proc.Id)

$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    try {
        $tabs = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $port + '/json') -TimeoutSec 2
        if ($tabs -and $tabs.Count -gt 0) {
            Write-Host ('[OZON VISIBLE] CDP up, ' + $tabs.Count + ' tab(s). Please login OZON in the window.')
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 500
}
Write-Warning '[OZON VISIBLE] CDP startup timeout'
exit 1
