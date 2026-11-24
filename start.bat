@echo off
REM ============================================================
REM  Exam Management System - one-click start (Windows)
REM  Double-click this file. It starts the system with Docker
REM  if Docker is installed, and opens it in your browser.
REM  Full Pashto guide: SIMPLE_START.md
REM  No passwords are stored in this file.
REM ============================================================
cd /d "%~dp0"

echo Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is NOT installed.
  echo Please install Node.js 20 from https://nodejs.org/ and try again.
  echo See SIMPLE_START.md for the manual steps.
  pause
  exit /b 1
)

echo Checking Docker...
where docker >nul 2>&1
if errorlevel 1 (
  echo.
  echo Docker is NOT installed on this computer.
  echo Easy option: install Docker Desktop from https://www.docker.com/products/docker-desktop/
  echo then double-click start.bat again.
  echo.
  echo Other option (no Docker): install PostgreSQL 15, then follow the
  echo manual steps in SIMPLE_START.md / docs/OFFLINE_GUIDE.md
  echo   1. cd backend ^&^& npm install ^&^& npm run migrate:schema ^&^& npm start
  echo   2. cd frontend ^&^& npm install ^&^& npm run dev
  echo   3. Open http://localhost:5173
  pause
  exit /b 0
)

echo Starting the system with Docker (this can take a few minutes the first time)...
docker compose up -d --build
if errorlevel 1 (
  echo Docker failed to start. Make sure Docker Desktop is running, then try again.
  pause
  exit /b 1
)

echo.
echo The system is starting. Opening http://localhost:8080 in your browser...
timeout /t 5 /nobreak >nul
start "" "http://localhost:8080"
echo If the page does not load yet, wait 30 seconds and refresh.
echo To stop the system later, run: docker compose down
pause
