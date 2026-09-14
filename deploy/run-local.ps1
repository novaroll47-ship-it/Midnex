# Запуск на своём ПК с внешним доступом через туннель.
#
#   powershell -ExecutionPolicy Bypass -File deploy\run-local.ps1
#
# Собирает приложение, открывает туннель и запускает всё одним процессом,
# передав ему публичный адрес: приложение само привяжет кнопку меню бота.
# Процессы отвязаны от терминала — закрытие окна их не убивает.
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

# Токен читает само приложение из .env; здесь проверяем, что он вообще есть,
# иначе бот молча не запустится и это выяснится только в Telegram.
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

# http2 (TCP) вместо quic (UDP): домашние провайдеры и VPN часто режут UDP,
# и туннель тогда молча отваливается от Cloudflare с ошибкой 530.
Write-Host '==> Открываю туннель'
Remove-Item "$TunnelLog*" -Force -ErrorAction SilentlyContinue
Start-Process -FilePath $Cloudflared `
    -ArgumentList 'tunnel', '--url', 'http://localhost:8787', '--no-autoupdate', '--protocol', 'http2' `
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

# Постоянный адрес: edge-функция Supabase (deploy/supabase/functions/app)
# перенаправляет на тот туннель, что записан в app_config.public_url.
# Бот и кнопка меню привязаны к постоянному адресу, поэтому старые кнопки
# в чате не умирают при каждом перезапуске. Запись — через Management API,
# токен берём из .claude/settings.local.json (в git он не попадает).
$StableUrl = 'https://bilivlcjttmoelqeuwxz.supabase.co/functions/v1/app'
Write-Host '==> Обновляю постоянный адрес'
$settingsPath = Join-Path $Root '.claude\settings.local.json'
$pat = $null
if (Test-Path $settingsPath) {
    $m = [regex]::Match((Get-Content $settingsPath -Raw), '"SUPABASE_ACCESS_TOKEN"\s*:\s*"([^"]+)"')
    if ($m.Success) { $pat = $m.Groups[1].Value }
}
if ($pat) {
    $sql = "insert into app_config (key, value) values ('public_url', '$url') " +
           "on conflict (key) do update set value = excluded.value, updated_at = now()"
    $body = @{ query = $sql } | ConvertTo-Json -Compress
    try {
        Invoke-RestMethod -Method Post -TimeoutSec 20 `
            -Uri 'https://api.supabase.com/v1/projects/bilivlcjttmoelqeuwxz/database/query' `
            -Headers @{ Authorization = "Bearer $pat" } -ContentType 'application/json' `
            -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) | Out-Null
        Write-Host "    $StableUrl -> $url"
    } catch {
        Write-Warning "Постоянный адрес не обновился: $_. Бот получит временный адрес."
        $StableUrl = $url
    }
} else {
    Write-Warning 'Нет токена Supabase в .claude/settings.local.json — бот получит временный адрес.'
    $StableUrl = $url
}

Write-Host '==> Запускаю приложение и бота'
# NODE_ENV=production включает настоящую проверку подписи Telegram:
# открыть приложение можно будет только из клиента Telegram.
# PUBLIC_URL нужен боту, чтобы показать кнопку и привязать меню чата;
# WEB_ORIGIN — откуда реально приходят запросы к API (для CORS).
$env:NODE_ENV = 'production'
$env:DEV_FAKE_USER = '0'
$env:PORT = '8787'
$env:PUBLIC_URL = $StableUrl
$env:WEB_ORIGIN = $url
# Потолок кучи: процесс с восемью биржами тяжёлый, и лучше явный предел
# с понятной ошибкой в api.log.err, чем тихая смерть.
Start-Process -FilePath 'node' -ArgumentList '--max-old-space-size=1024', 'apps/api/dist/index.js' `
    -WorkingDirectory $Root -WindowStyle Hidden `
    -RedirectStandardOutput $ApiLog -RedirectStandardError "$ApiLog.err"

# С базой старт длится дольше (проверка соединения с Postgres), поэтому ждём
# до минуты, а не фиксированные пять секунд.
$health = $null
foreach ($i in 1..30) {
    Start-Sleep -Seconds 2
    try { $health = Invoke-RestMethod -Uri 'http://localhost:8787/api/health' -TimeoutSec 5 } catch { }
    if ($health -and $health.ok) { break }
}
if (-not ($health -and $health.ok)) { throw 'Приложение не поднялось, смотри .tools/api.log' }
Write-Host "    хранилище: $($health.storage)"

Write-Host ''
Write-Host "Готово: $StableUrl"
Write-Host "Туннель: $url"
Write-Host 'Кнопка меню бота и /start ведут на постоянный адрес.'
Write-Host ''
Write-Host 'Вне Telegram приложение отдаёт 401 — так и задумано.'
Write-Host 'Логи: .tools\api.log и .tools\tunnel.log.err'
