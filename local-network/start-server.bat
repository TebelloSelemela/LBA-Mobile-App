@echo off
setlocal
cd /d "%~dp0.."
echo.
echo ==============================================
echo     LESBAD LAN SERVER - DESKTOP 1
echo ==============================================
where py >nul 2>nul
if errorlevel 1 (
  echo Python Launcher not found. Install Python 3.12 or 3.13 from python.org.
  pause
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo Creating isolated Python environment...
  py -3 -m venv .venv
  if errorlevel 1 (pause & exit /b 1)
  ".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r backend\requirements.txt -r local-network\requirements.txt
  if errorlevel 1 (pause & exit /b 1)
)
if not exist "local-data\config.json" (
  ".venv\Scripts\python.exe" local-network\configure.py
  if errorlevel 1 (pause & exit /b 1)
)
echo.
echo Starting LESBAD. Keep this window open.
echo.
".venv\Scripts\python.exe" local-network\server.py
echo.
echo Server stopped. Press a key to close.
pause >nul
