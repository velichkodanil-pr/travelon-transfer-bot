@echo off
REM ============================================================
REM  Commit local changes and push to GitHub.
REM  Railway auto-redeploys from GitHub on every push to main.
REM  Double-click this whenever the bot code was changed.
REM ============================================================
setlocal
cd /d "%~dp0"

REM --- Clear a stale git lock. An interrupted "git add" leaves .git\index.lock
REM     behind; every later commit then fails SILENTLY and the clone quietly
REM     stops tracking your work (this bit us on 30.08).
if exist ".git\index.lock" (
  echo Removing stale .git\index.lock ...
  del /f /q ".git\index.lock"
)

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

REM Commit local work FIRST (a dirty tree makes rebase refuse), then rebase on
REM top of GitHub — some fixes are committed straight to GitHub via the API, so
REM this clone can be behind and a blind push would revert them.
git add .
git commit -m "Contact flows: stop dropping every booking when the list omits the status label (site change ~28.08) - enforce the label only when present, trust the server-side status filter. Also: clear stale .git/index.lock and rebase on origin before pushing"

git pull --rebase origin main
if errorlevel 1 (
  echo.
  echo *** GIT PULL/REBASE FAILED - resolve it first, nothing was pushed ***
  echo.
  pause
  endlocal
  exit /b 1
)

git push

echo.
echo ------------------------------------------------------------
echo Pushed to GitHub. Railway will rebuild and redeploy in ~1-3 min.
echo (If "nothing to commit" appeared, there were no new changes.)
echo ------------------------------------------------------------
echo.
pause
endlocal
