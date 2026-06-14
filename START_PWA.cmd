@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required to run Burble Dashboard.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)
start "" /b powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep 2; Start-Process 'http://localhost:4174/'"
node server.js
if errorlevel 1 pause
