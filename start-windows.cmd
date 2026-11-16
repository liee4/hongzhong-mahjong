@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js 22 or later is required. & pause & exit /b 1)
echo Open http://127.0.0.1:3000 in your browser.
node server.mjs
pause
