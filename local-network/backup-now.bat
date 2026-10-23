@echo off
setlocal
cd /d "%~dp0.."
if not exist ".venv\Scripts\python.exe" (
  echo Start LESBAD once with local-network\start-server.bat.
  pause
  exit /b 1
)
".venv\Scripts\python.exe" local-network\local_network_backup.py
pause
