@echo off
REM Aurora Dashboard launcher.
REM Double-click this file. It starts the local server and opens the dashboard.

setlocal

where python >nul 2>nul
if errorlevel 1 (
  echo.
  echo Python is not installed.
  echo.
  echo Please install Python 3 from:
  echo   https://www.python.org/downloads/
  echo.
  echo During install, tick the box that says "Add Python to PATH".
  echo Then double-click this file again.
  echo.
  pause
  exit /b 1
)

cd /d "%~dp0"

echo Starting the aurora dashboard...
echo A browser window will open in a moment.
echo Leave this window open while you use the dashboard.
echo Close this window when you are done.
echo.

python aurora_fi.py --serve --open /hifi

endlocal
