@echo off
cd /d "%~dp0"
echo ==^> Останавливаю сторож, приложение, туннель и VictoriaMetrics
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-CimInstance Win32_Process -Filter \"Name = 'powershell.exe'\" | Where-Object { $_.CommandLine -like '*watchdog.ps1*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object { $_.CommandLine -like '*apps/api/dist/index.js*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; Get-Process cloudflared -ErrorAction SilentlyContinue | Stop-Process -Force; Get-Process victoria-metrics -ErrorAction SilentlyContinue | Stop-Process -Force"
echo Готово.
pause
