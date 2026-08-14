# Install OZON headless Chrome as a logon-time task so it survives PowerShell sessions.
# Run this once with admin PowerShell:
#   powershell -ExecutionPolicy Bypass -File scripts/install-ozon-chrome-autostart.ps1
$ErrorActionPreference = 'Stop'
$taskName = 'OZONHeadlessChromeAutoStart'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) {
    Write-Error 'Chrome not found at C:\Program Files\Google\Chrome\Application\chrome.exe'
    exit 1
}
$arg = '--headless=new --disable-gpu --no-sandbox --no-zygote --no-first-run --disable-dev-shm-usage --disable-features=Translate,BackForwardCache,AcceptCHFrame --remote-debugging-address=127.0.0.1 --remote-debugging-port=9225 --user-data-dir="C:\Users\Administrator\AppData\Local\OzonImageSearchChrome" --window-size=1366,900 about:blank'
$tr = '"' + $chrome + '" ' + $arg

$existing = schtasks /Query /TN $taskName 2>$null
if ($LASTEXITCODE -eq 0) {
    schtasks /Delete /TN $taskName /F | Out-Null
}

# /SC ONLOGON starts it when the user logs in, so Chrome is up before you open the page.
# /RL HIGHEST runs it with admin privileges (needed for CDP on some setups).
schtasks /Create /TN $taskName /TR $tr /SC ONLOGON /RL HIGHEST /F | Out-Null
Write-Host ('[OZON] Installed task ' + $taskName)
Write-Host '[OZON] Trigger: on logon (HIGHEST privilege)'
Write-Host ('[OZON] To verify: schtasks /Query /TN ' + $taskName)
Write-Host ('[OZON] To start now without re-login: schtasks /Run /TN ' + $taskName)