@echo off
rem Starts Accretion. Double-click it again to add another black hole.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Accretion needs its files installed first. Running "npm install"...
  call npm install || (echo. & echo Could not install. Is Node.js installed? https://nodejs.org & pause & exit /b 1)
)
start "" "node_modules\electron\dist\electron.exe" "%~dp0."
