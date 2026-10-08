// Entry point: validate config, then run on the cron schedule (and once at boot
// only when RUN_ON_STARTUP=true).
import cron from 'node-cron';
import { config, validateConfig } from './config.js';
import { log } from './logger.js';
import { runCycle } from './runCycle.js';
import { requestStop } from './stop.js';

let running = false;
let startedAt = 0;
let stopping = false;

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
  if (stopping) {
    log.info(`Shutting down — ignoring the ${trigger} tick.`);
    return;
  }
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
    if (stopping) {
      log.info('Cycle wound down after the stop request — exiting.');
      process.exit(0);
    }
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
  log.info(` startup   : ${config.runOnce || config.runOnStartup ? 'run a cycle now' : 'wait for the schedule'}`);
  log.info(` countries : ${config.targetCountries.join(', ')}`);
  log.info(` statuses  : ${config.targetStatuses.join(', ')}`);
  log.info(` onlyToday : ${config.onlyToday}`);
  log.info(
    ` bulgaria  : ${config.bulgaria.enabled ? 'ON' : 'off'} (Eline creds ${
      config.eline.email && config.eline.password ? 'set' : 'MISSING'
    })`
  );
  log.info(` shutdown  : graceful, finish current booking (max ${Math.round(config.stopGraceMs / 1000)}s)`);
  log.info('============================================================');

  if (config.runOnce) {
    await safeRun('startup');
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

  // Optional boot cycle (off by default: a deploy/restart must not start an
  // extra cycle mid-hour — the schedule picks everything up).
  if (config.runOnStartup) await safeRun('startup');
}

// Graceful stop (Railway sends SIGTERM on every deploy/restart): when idle, exit
// at once; mid-cycle, let the booking in progress finish (its chat message and
// state write), skip the rest, then exit. A second signal or the grace timeout
// exits immediately.
function onSignal(sig) {
  if (stopping) {
    log.warn(`${sig} received again — exiting now.`);
    process.exit(0);
  }
  stopping = true;
  if (!running) {
    log.info(`${sig} received — idle, shutting down.`);
    process.exit(0);
  }
  log.warn(
    `${sig} received mid-cycle — finishing the current booking, then exiting (max ${Math.round(
      config.stopGraceMs / 1000
    )}s).`
  );
  requestStop(sig);
  setTimeout(() => {
    log.warn('Graceful stop timed out — exiting.');
    process.exit(0);
  }, config.stopGraceMs).unref();
}

process.on('SIGTERM', () => onSignal('SIGTERM'));
process.on('SIGINT', () => onSignal('SIGINT'));
process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection:', reason);
});

main();
