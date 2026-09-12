# Сторож для запуска на ПК.
#
#   powershell -ExecutionPolicy Bypass -WindowStyle Hidden -File deploy\watchdog.ps1
#
# Раз в минуту проверяет, что приложение отвечает локально и что туннель
# доступен снаружи. Два провала подряд — полный перезапуск через run-local.ps1
# (он сам поднимет и туннель, и приложение, и перепривяжет кнопку бота).
# Регистрируется в Планировщике задач на вход пользователя — тогда после
# перезагрузки ПК всё поднимается без участия человека.

$ErrorActionPreference = 'Continue'

$Root = Split-Path -Parent $PSScriptRoot
$RunLocal = Join-Path $PSScriptRoot 'run-local.ps1'
$TunnelLog = Join-Path $Root '.tools\tunnel.log.err'
$Log = Join-Path $Root '.tools\watchdog.log'

function Write-Log([string]$msg) {
    $line = "{0:yyyy-MM-dd HH:mm:ss} {1}" -f (Get-Date), $msg
    Add-Content -Path $Log -Value $line -Encoding UTF8
}

function Test-Local {
    try {
        $h = Invoke-RestMethod -Uri 'http://localhost:8787/api/health' -TimeoutSec 5
        return [bool]$h.ok
    } catch { return $false }
}

function Test-Tunnel {
    $txt = Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue
    if (-not $txt) { return $false }
    $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if (-not $m.Success) { return $false }
    try {
        $r = Invoke-WebRequest -Uri "$($m.Value)/api/health" -TimeoutSec 15 -UseBasicParsing
        return ($r.StatusCode -eq 200)
    } catch { return $false }
}

function Restart-All([string]$why) {
    Write-Log "перезапуск: $why"
    try {
        & powershell -NoProfile -ExecutionPolicy Bypass -File $RunLocal 2>&1 |
            ForEach-Object { Write-Log "  run-local: $_" }
    } catch {
        Write-Log "  run-local упал: $_"
    }
}

Write-Log 'сторож запущен'
if (-not (Test-Local)) { Restart-All 'приложение не запущено' }

$localFails = 0
$tunnelFails = 0
while ($true) {
    Start-Sleep -Seconds 60

    if (Test-Local) { $localFails = 0 } else { $localFails++ }
    if ($localFails -ge 2) {
        Restart-All 'приложение не отвечает две минуты'
        $localFails = 0; $tunnelFails = 0
        continue
    }

    if (Test-Tunnel) { $tunnelFails = 0 } else { $tunnelFails++ }
    # Туннелю даём больше времени: Cloudflare бывает недоступен минуту-две сам.
    if ($tunnelFails -ge 3) {
        Restart-All 'туннель не отвечает три минуты'
        $localFails = 0; $tunnelFails = 0
    }
}
