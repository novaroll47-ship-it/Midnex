@echo off
cd /d "%~dp0"
title MidNex

echo ==^> Запуск MidNex: сборка, туннель, приложение, бот
powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\run-local.ps1"
if errorlevel 1 (
  echo.
  echo Не поднялось. Логи: .tools\api.log, .tools\api.log.err, .tools\tunnel.log.err
  pause
  exit /b 1
)

echo ==^> Запускаю сторож: перезапустит всё сам, если туннель или приложение упадут
rem Старый сторож, если остался от прошлого запуска, останавливаем: два сторожа мешают друг другу.
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name = 'powershell.exe'\" | Where-Object { $_.CommandLine -like '*watchdog.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"
start "" /min powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "deploy\watchdog.ps1"

echo.
echo Готово. Это окно можно закрыть - приложение и сторож работают в фоне.
echo Остановить всё: stop.bat
pause
