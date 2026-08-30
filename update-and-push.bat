@echo off
REM ============================================================
REM  Commit local changes and push to GitHub.
REM  Railway auto-redeploys from GitHub on every push to main.
REM  Double-click this whenever the bot code was changed.
REM ============================================================
setlocal
cd /d "%~dp0"

REM --- Syntax gate: never push code that cannot even parse -----------------
set "NODE=node"
where node >nul 2>&1 || set "NODE=%ProgramFiles%\nodejs\node.exe"
if not exist "%NODE%" if /i not "%NODE%"=="node" set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
echo Syntax check %DATE% %TIME% using "%NODE%"> syntax-check.txt
set "SYNTAX_FAILED="
for %%F in (src\*.js) do (
  "%NODE%" --check "%%F" >> syntax-check.txt 2>&1 || set "SYNTAX_FAILED=1"
)
if defined SYNTAX_FAILED (
  echo.
  echo *** SYNTAX ERROR - NOTHING WAS PUSHED. See syntax-check.txt ***
  echo SYNTAX FAILED>> syntax-check.txt
  echo.
  pause
  endlocal
  exit /b 1
)
echo SYNTAX OK>> syntax-check.txt
echo Syntax OK - pushing...

git add .
git commit -m "Generic 4-country flow: scan by CHECK-IN date with pagination instead of only the first page of newest bookings, so a booking missed during downtime (e.g. 67734) is picked up later; GENERIC_CREATED_FROM keeps the old backlog out of scope"
git push

echo.
echo ------------------------------------------------------------
echo Pushed to GitHub. Railway will rebuild and redeploy in ~1-3 min.
echo (If "nothing to commit" appeared, there were no new changes.)
echo ------------------------------------------------------------
echo.
pause
endlocal
