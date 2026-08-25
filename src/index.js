// Entry point: validate config, run once at startup, then schedule every N min.
import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { log } from './logger.js';
import { runCycle } from './runCycle.js';

let running = false;
let startedAt = 0;

// Race the cycle against a hard deadline. A hung Playwright call never rejects,
// so we cannot "cancel" it — the only reliable recovery is to exit and let
// Railway restart the container with a fresh browser.
function cycleDeadline(ms) {
  let timer = null;
  const promise = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`CYCLE_TIMEOUT after ${Math.round(ms / 60000)} min`)),
      ms
    );
  });
  // NOTE: deliberately NOT unref()'d — an unref'd timer would let the process
  // exit early during the very first (startup) cycle. We clear it explicitly.
  return { promise, cancel: () => clearTimeout(timer) };
}

async function safeRun(trigger) {
  if (running) {
    const mins = Math.round((Date.now() - startedAt) / 60000);
    log.warn(`Cycle still running (${mins} min) — skipping this ${trigger} tick.`);
    // Belt & braces: if the deadline somehow did not fire, never stay wedged.
    if (Date.now() - startedAt > config.cycleTimeoutMs * 1.5) {
      log.error(`Cycle wedged for ${mins} min — exiting so Railway restarts a clean instance.`);
      process.exit(1);
    }
    return;
  }
  running = true;
  startedAt = Date.now();
  const deadline = cycleDeadline(config.cycleTimeoutMs);
  try {
    await Promise.race([runCycle(), deadline.promise]);
  } catch (err) {
    log.error('Unhandled cycle error:', err && err.message ? err.message : err);
    if (String(err && err.message).startsWith('CYCLE_TIMEOUT')) {
      log.error('Cycle exceeded its deadline (likely a hung browser call) — exiting for a clean restart.');
      process.exit(1);
    }
  } finally {
    deadline.cancel();
    running = false;
  }
}

async function main() {
  const problems = validateConfig();
  if (problems.length) {
    log.error('Configuration problems:\n - ' + problems.join('\n - '));
    log.error('Set the required environment variables and restart.');
    process.exit(1);
  }

  log.info('============================================================');
  log.info(' TravelON transfer-phone bot');
  log.info(` mode      : ${config.dryRun ? 'DRY-RUN (no messages sent)' : 'LIVE (will send)'}`);
  log.info(` schedule  : "${config.checkCron}"  tz=${config.tz}`);
  log.info(` countries : ${config.targetCountries.join(', ')}`);
  log.info(` statuses  : ${config.targetStatuses.join(', ')}`);
  log.info(` onlyToday : ${config.onlyToday}`);
  log.info(
    ` bulgaria  : ${config.bulgaria.enabled ? 'ON' : 'off'} (Eline creds ${
      config.eline.email && config.eline.password ? 'set' : 'MISSING'
    })`
  );
  log.info('============================================================');

  // Run immediately on boot.
  await safeRun('startup');

  if (config.runOnce) {
    log.info('RUN_ONCE=true — exiting after a single cycle.');
    process.exit(0);
  }

  if (!cron.validate(config.checkCron)) {
    log.error(`Invalid CHECK_CRON: "${config.checkCron}"`);
    process.exit(1);
  }

  cron.schedule(config.checkCron, () => safeRun('scheduled'), { timezone: config.tz });
  log.info(
    `Scheduler armed; running 24/7. Cycle watchdog: ${Math.round(
      config.cycleTimeoutMs / 60000
    )} min. Waiting for next tick…`
  );
}

process.on('SIGTERM', () => {
  log.info('SIGTERM received — shutting down.');
  process.exit(0);
});
process.on('SIGINT', () => {
  log.info('SIGINT received — shutting down.');
  process.exit(0);
});
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
});

main();
