#!/usr/bin/env bash
# ============================================================
#  One-time LOCAL git setup (for Git Bash / WSL / macOS / Linux).
#  Run:  bash init-git.sh
#  Cleans any partial .git state, then makes the first commit.
# ============================================================
set -e
cd "$(dirname "$0")"

echo "Cleaning any partial git state..."
rm -rf .git 2>/dev/null || true

echo "Initializing git repository..."
git init
git add .
git commit -m "Initial commit: TravelON transfer-phone bot (Playwright + Docker, Railway-ready)"
git branch -M main

cat <<'EOF'

============================================================
 Local repository is ready (branch: main).

 To publish to GitHub:
   1) Create an EMPTY repo at https://github.com/new
      (e.g. name: travelon-transfer-bot; no README/.gitignore)
   2) git remote add origin https://github.com/YOURNAME/travelon-transfer-bot.git
   3) git push -u origin main
============================================================
EOF
