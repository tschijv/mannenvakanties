@echo off
REM Dubbelklik dit bestand om Mannenvakanties lokaal te starten (Windows).
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is niet gevonden.
  echo Installeer eerst Node.js 22 LTS via https://nodejs.org en dubbelklik dit bestand opnieuw.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Pakketten installeren ^(dit gebeurt alleen de eerste keer^)...
  call npm install
  if errorlevel 1 (
    echo Installeren mislukte.
    pause
    exit /b 1
  )
)

REM open de browser zodra de server waarschijnlijk klaar is
start /b "" cmd /c "timeout /t 4 >nul & start "" http://localhost:3000"

echo.
echo Mannenvakanties draait op http://localhost:3000
echo Sluit dit venster of druk Ctrl+C om te stoppen.
echo.
call npm start
pause
