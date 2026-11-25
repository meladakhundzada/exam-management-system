@echo off
REM ============================================================
REM  Exam Management System - one-click start (Windows, no Docker)
REM  Double-click this file. It asks ONCE for your PostgreSQL
REM  password, sets up backend\.env, creates the database,
REM  runs the schema migration, and starts backend + frontend.
REM  Then it opens http://localhost:5173 in your browser.
REM  Full Pashto guide: SIMPLE_START.md
REM  No passwords are stored in this file. Never share backend\.env.
REM ============================================================
cd /d "%~dp0"

echo Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is NOT installed.
  echo Please install Node.js 20 LTS from https://nodejs.org/
  echo then double-click run.bat again.
  pause
  exit /b 1
)
where npm >nul 2>&1
if errorlevel 1 (
  echo npm was not found. Reinstall Node.js 20 LTS from https://nodejs.org/
  pause
  exit /b 1
)

echo Checking PostgreSQL (psql)...
where psql >nul 2>&1
if errorlevel 1 (
  echo psql was not found. PostgreSQL is not installed, or its
  echo bin folder is not in PATH.
  echo Install PostgreSQL 15 from https://www.postgresql.org/download/windows/
  echo and add its bin folder to PATH, usually:
  echo   C:\Program Files\PostgreSQL\15\bin
  echo then double-click run.bat again.
  pause
  exit /b 1
)

echo.
echo Type the password you set for the PostgreSQL user "postgres"
echo when you installed PostgreSQL. It is asked only once here.
echo NOTE: avoid @ # %% ^& and spaces in the password, or the
echo database address below will not work.
set /p PGPASS=PostgreSQL password for postgres:
if "%PGPASS%"=="" (
  echo No password typed. Run run.bat again and type the password.
  pause
  exit /b 1
)

set "DATABASE_URL=postgres://postgres:%PGPASS%@localhost:5432/exam_management"

echo Checking PostgreSQL is running...
psql "postgres://postgres:%PGPASS%@localhost:5432/postgres" -c "SELECT 1" >nul 2>&1
if errorlevel 1 (
  echo.
  echo Could not reach PostgreSQL. Check that:
  echo   1. PostgreSQL is installed, and
  echo   2. the PostgreSQL service is started (Windows Services -^> postgresql-x64-15 -^> Start), and
  echo   3. the password you typed is correct.
  echo Then double-click run.bat again.
  pause
  exit /b 1
)

if not exist "%~dp0backend\.env" (
  echo Creating backend\.env ...
  (
    echo NODE_ENV=development
    echo PORT=5000
    echo DATABASE_URL=postgres://postgres:%PGPASS%@localhost:5432/exam_management
    echo JWT_SECRET=change-me-to-a-long-random-secret
    echo JWT_EXPIRES_IN=8h
    echo CORS_ORIGIN=http://localhost:5173
  ) > "%~dp0backend\.env"
  echo backend\.env created. Keep it private - never share it or send it in chat.
) else (
  echo backend\.env already exists - keeping it as it is.
)

echo Creating the database if it does not exist yet...
psql "postgres://postgres:%PGPASS%@localhost:5432/postgres" -c "CREATE DATABASE exam_management" >nul 2>&1

echo Running the database migration (schema only, no sample accounts)...
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\001_init.sql"
if errorlevel 1 (
  echo.
  echo Migration failed. If it says "relation already exists", the tables
  echo are already there - you can ignore that and start the system by
  echo double-clicking run.bat again. Otherwise read the error above.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\003_fees.sql"
if errorlevel 1 (
  echo.
  echo Fees migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\004_departments.sql"
if errorlevel 1 (
  echo.
  echo Departments migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\005_reference_data.sql"
if errorlevel 1 (
  echo.
  echo Reference data migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\006_finance_modules.sql"
if errorlevel 1 (
  echo.
  echo Finance modules migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\007_profile_photos.sql"
if errorlevel 1 (
  echo.
  echo Profile photos migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\008_exam_management.sql"
if errorlevel 1 (
  echo.
  echo Exam management migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\009_online_payments.sql"
if errorlevel 1 (
  echo.
  echo Online payments migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\010_marks_history.sql"
if errorlevel 1 (
  echo.
  echo Marks history migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\011_refresh_tokens.sql"
if errorlevel 1 (
  echo.
  echo Refresh tokens migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)
psql "%DATABASE_URL%" -v ON_ERROR_STOP=1 -f "%~dp0database\migrations\012_student_id_simple.sql"
if errorlevel 1 (
  echo.
  echo Student ID migration failed. Read the error above, then double-click
  echo run.bat again.
  pause
  exit /b 1
)

if not exist "%~dp0backend\node_modules" (
  echo Installing backend packages (first time only, needs internet)...
  pushd "%~dp0backend"
  call npm install
  if errorlevel 1 (
    popd
    echo Backend install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  popd
)

if not exist "%~dp0frontend\node_modules" (
  echo Installing frontend packages (first time only, needs internet)...
  pushd "%~dp0frontend"
  call npm install
  if errorlevel 1 (
    popd
    echo Frontend install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
  popd
)

echo Starting the backend in a new window...
start "Exam Backend" /D "%~dp0backend" cmd /k npm start

echo Starting the frontend in a new window...
start "Exam Frontend" /D "%~dp0frontend" cmd /k npm run dev

echo.
echo The system is starting. Opening http://localhost:5173 in your browser...
echo If the page does not load yet, wait 30 seconds and refresh.
timeout /t 10 /nobreak >nul
start "" "http://localhost:5173"
echo Backend API: http://localhost:5000
echo To stop the system later, close the two black windows (or press Ctrl+C in each).
pause
