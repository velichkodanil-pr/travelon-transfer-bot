@echo off
REM ============================================================
REM  Publish the TravelON bot to GitHub in one go.
REM  Double-click this file. It will:
REM    - create a clean local git repo + first commit
REM    - ask you to paste your GitHub repo URL
REM    - push everything to GitHub
REM ============================================================
setlocal
cd /d "%~dp0"

echo === TravelON bot: publish to GitHub ===
echo.

REM Always start from a clean git state (avoids stale lock-file problems).
if exist ".git" (
  echo Cleaning previous git state...
  powershell -NoProfile -Command "Remove-Item -LiteralPath '.git' -Recurse -Force -ErrorAction SilentlyContinue"
)

git init
if errorlevel 1 (
  echo.
  echo ERROR: "Git for Windows" is not installed.
  echo Install it from  https://git-scm.com/download/win  then run this file again.
  pause
  exit /b 1
)

git add .
git commit -m "TravelON transfer-phone bot"
git branch -M main

echo.
echo STEP 1 (if not done yet): create an EMPTY repo at  https://github.com/new
echo         name: travelon-transfer-bot   (no README, no .gitignore)
echo.
set /p URL="STEP 2: paste the repo URL here and press Enter: "
if "%URL%"=="" (
  echo.
  echo No URL entered - nothing was pushed. You can re-run this file anytime.
  pause
  exit /b 1
)

git remote remove origin 1>nul 2>nul
git remote add origin "%URL%"

echo.
echo Pushing to %URL% ...
git push -u origin main

echo.
echo ------------------------------------------------------------
echo If a sign-in window opened, finish logging in to GitHub and
echo the upload will complete. (On the password prompt use a GitHub
echo Personal Access Token, not your normal password.)
echo ------------------------------------------------------------
echo.
pause
endlocal
