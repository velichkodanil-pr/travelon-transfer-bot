# ----------------------------------------------------------------------------
#  Playwright's official image already contains Chromium + all system libs.
#  IMPORTANT: keep this tag's version in sync with the "playwright" version
#  in package.json (currently 1.47.2). If you bump one, bump the other.
# ----------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.47.2-jammy

ENV NODE_ENV=production \
    # Browsers are preinstalled in the image:
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev

# Copy the rest of the source.
COPY . .

# Persisted runtime data (sent-IDs, screenshots). Mount a Railway Volume here
# to keep state across restarts (optional — the in-chat duplicate check still
# prevents double-sends even without it).
RUN mkdir -p /app/data
ENV DATA_DIR=/app/data

# Long-running worker: node-cron keeps it alive and fires every 30 min.
CMD ["node", "src/index.js"]
