@echo off
REM ============================================================
REM  Commit local changes and push to GitHub.
REM  Railway auto-redeploys from GitHub on every push to main.
REM  Double-click this whenever the bot code was changed.
REM ============================================================
setlocal
cd /d "%~dp0"

git add .
git commit -m "Eline: skip booking if phone already in portal (no rewrite, no re-ask)"
git push

echo.
echo ------------------------------------------------------------
echo Pushed to GitHub. Railway will rebuild and redeploy in ~1-3 min.
echo (If "nothing to commit" appeared, there were no new changes.)
echo ------------------------------------------------------------
echo.
pause
endlocal
