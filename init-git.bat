@echo off
REM ============================================================
REM  One-time LOCAL git setup for the TravelON transfer bot.
REM  Double-click this file (or run it in cmd) on your PC.
REM  It cleans any partial .git state, then makes the first commit.
REM ============================================================
setlocal
cd /d "%~dp0"

echo Cleaning any partial git state...
if exist ".git" powershell -NoProfile -Command "Remove-Item -LiteralPath '.git' -Recurse -Force -ErrorAction SilentlyContinue"

echo Initializing git repository...
git init
if errorlevel 1 (
  echo.
  echo ERROR: git was not found. Install "Git for Windows":
  echo   https://git-scm.com/download/win
  echo Then run this file again.
  pause
  exit /b 1
)

git add .
git commit -m "Initial commit: TravelON transfer-phone bot (Playwright + Docker, Railway-ready)"
git branch -M main

echo.
echo ============================================================
echo  Local repository is ready (branch: main).
echo.
echo  To publish to GitHub:
echo    1^) Create an EMPTY repo at https://github.com/new
echo       ^(e.g. name: travelon-transfer-bot; no README/.gitignore^)
echo    2^) git remote add origin https://github.com/YOURNAME/travelon-transfer-bot.git
echo    3^) git push -u origin main
echo ============================================================
echo.
pause
endlocal
