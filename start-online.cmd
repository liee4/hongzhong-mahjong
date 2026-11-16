@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22 or later is required. & pause & exit /b 1)
node host.mjs --online
set "exit_code=%errorlevel%"
pause
exit /b %exit_code%
