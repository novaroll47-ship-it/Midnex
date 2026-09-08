# Запуск на своём ПК с внешним доступом через туннель.
#
#   powershell -ExecutionPolicy Bypass -File deploy\run-local.ps1
#
# Собирает приложение, поднимает его одним процессом, открывает туннель и
# сразу привязывает адрес к кнопке меню бота. Оба процесса — отдельные от
# терминала, закрытие окна их не убивает.
#
# Это временный режим: приложение живёт, только пока включён ПК.
# Постоянный вариант — deploy/README.md.

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Tools = Join-Path $Root '.tools'
$Cloudflared = Join-Path $Tools 'cloudflared.exe'
$TunnelLog = Join-Path $Tools 'tunnel.log'
$ApiLog = Join-Path $Tools 'api.log'

Set-Location $Root

# Токен нужен и серверу (проверка подписи), и для привязки кнопки меню.
$BotToken = $env:TELEGRAM_BOT_TOKEN
if (-not $BotToken -and (Test-Path (Join-Path $Root '.env'))) {
    $line = Select-String -Path (Join-Path $Root '.env') -Pattern '^TELEGRAM_BOT_TOKEN=(.+)$'
    if ($line) { $BotToken = $line.Matches[0].Groups[1].Value.Trim() }
}
if (-not $BotToken) { throw 'Не найден TELEGRAM_BOT_TOKEN — задай его в .env' }

if (-not (Test-Path $Cloudflared)) {
    New-Item -ItemType Directory -Force -Path $Tools | Out-Null
    Write-Host '==> Качаю cloudflared'
    Invoke-WebRequest -Uri 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $Cloudflared
}

Write-Host '==> Останавливаю прошлый запуск'
Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
    Where-Object { $_.CommandLine -like '*apps/api/dist/index.js*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Write-Host '==> Собираю'
npm run build | Out-Null

Write-Host '==> Запускаю приложение'
# NODE_ENV=production включает настоящую проверку подписи Telegram:
# открыть приложение можно будет только из клиента Telegram.
$env:NODE_ENV = 'production'
$env:DEV_FAKE_USER = '0'
$env:PORT = '8787'
Start-Process -FilePath 'node' -ArgumentList 'apps/api/dist/index.js' `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $ApiLog -RedirectStandardError "$ApiLog.err"

Start-Sleep -Seconds 4
$health = Invoke-RestMethod -Uri 'http://localhost:8787/api/health' -TimeoutSec 10
if (-not $health.ok) { throw 'Приложение не поднялось, смотри .tools/api.log' }

Write-Host '==> Открываю туннель'
Remove-Item "$TunnelLog*" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $Cloudflared `
    -ArgumentList 'tunnel', '--url', 'http://localhost:8787', '--no-autoupdate' `
    -WindowStyle Hidden -RedirectStandardOutput $TunnelLog -RedirectStandardError "$TunnelLog.err"

$url = $null
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    $txt = (Get-Content "$TunnelLog.err" -Raw -ErrorAction SilentlyContinue) +
           (Get-Content $TunnelLog -Raw -ErrorAction SilentlyContinue)
    $m = [regex]::Match($txt, 'https://[a-z0-9-]+\.trycloudflare\.com')
    if ($m.Success) { $url = $m.Value; break }
}
if (-not $url) { throw 'Туннель не поднялся, смотри .tools/tunnel.log.err' }

Write-Host "==> Привязываю кнопку бота"
$body = @{
    menu_button = @{
        type    = 'web_app'
        text    = 'MIDNEX'
        web_app = @{ url = $url }
    }
} | ConvertTo-Json -Depth 5

Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot$BotToken/setChatMenuButton" `
    -ContentType 'application/json; charset=utf-8' -Body $body | Out-Null

Write-Host ''
Write-Host "Готово: $url"
Write-Host 'Открывай бота в Telegram и жми кнопку MIDNEX.'
Write-Host ''
Write-Host 'Вне Telegram приложение отдаёт 401 — так и задумано.'
Write-Host 'Логи: .tools\api.log и .tools\tunnel.log.err'
