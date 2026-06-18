// One full pass: login -> filter -> per-booking dedup check -> send/log.
import { TravelonClient } from './travelon.js';
import { config } from './config.js';
import { log } from './logger.js';
import { wasSent, markSent } from './store.js';
import { notify, notifyEnabled } from './notify.js';
import { runBulgaria } from './bulgaria.js';

export async function runCycle() {
  const startedAt = new Date();
  const summary = {
    dryRun: config.dryRun,
    matched: [],
    sent: [], // actually sent (live mode)
    wouldSend: [], // dry-run candidates
    skippedAlready: [], // chat already had a transfer request
    skippedStore: [], // we already messaged it on a previous run
    errors: [],
  };
  let bg = null;

  const client = new TravelonClient();
  try {
    await client.init();
    await client.login();
    await client.openRequests();
    await client.clearCheckInDates();
    await client.setStatusFilter();
    await client.applyFilter();

    const bookings = await client.listMatchingBookings();
    summary.matched = bookings.map((b) => `${b.id}/${b.country}`);

    let sends = 0;
    for (const b of bookings) {
      try {
        if (await wasSent(b.id)) {
          summary.skippedStore.push(b.id);
          log.info(`Skip ${b.id}: already messaged on a previous run.`);
          continue;
        }

        await client.openChat(b.id);

        if (await client.chatAlreadyRequested()) {
          summary.skippedAlready.push(b.id);
          log.info(`Skip ${b.id}: transfer-phone request already present in chat.`);
          await client.closeChat(b.id);
          continue;
        }

        if (config.dryRun) {
          summary.wouldSend.push(b.id);
          log.info(`[DRY-RUN] Would send to ${b.id} (${b.country}).`);
          await client.closeChat(b.id);
          continue;
        }

        if (sends >= config.maxSendsPerRun) {
          log.warn(`Reached MAX_SENDS_PER_RUN=${config.maxSendsPerRun}; stopping sends.`);
          await client.closeChat(b.id);
          break;
        }

        await client.sendMessage();
        await markSent(b.id, { country: b.country });
        sends += 1;
        summary.sent.push(b.id);
        log.info(`Sent to ${b.id} (${b.country}).`);
        await client.closeChat(b.id);
      } catch (err) {
        summary.errors.push(`${b.id}: ${err.message}`);
        log.error(`Booking ${b.id} failed:`, err.message);
        await client.screenshot(`booking-${b.id}-error`);
      }
    }

    // Bulgaria + Eline workflow — reuses the same logged-in TravelON session.
    if (config.bulgaria.enabled) {
      bg = await runBulgaria(client);
    }
  } catch (err) {
    summary.errors.push(`cycle: ${err.message}`);
    log.error('Cycle failed:', err.message);
    await client.screenshot('cycle-error');
  } finally {
    await client.close();
  }

  const took = ((Date.now() - startedAt) / 1000).toFixed(1);
  const lines = [
    `TravelON bot cycle ${config.dryRun ? '[DRY-RUN]' : '[LIVE]'} — ${took}s`,
    `Matched: ${summary.matched.length} (${summary.matched.join(', ') || '—'})`,
    config.dryRun
      ? `Would send: ${summary.wouldSend.join(', ') || '—'}`
      : `Sent: ${summary.sent.join(', ') || '—'}`,
    `Skipped (already in chat): ${summary.skippedAlready.join(', ') || '—'}`,
    `Skipped (sent before): ${summary.skippedStore.join(', ') || '—'}`,
    `Errors: ${summary.errors.join(' | ') || '—'}`,
  ];
  let report = lines.join('\n');
  if (bg && bg.report) report += '\n\n' + bg.report;
  log.info('Cycle summary:\n' + report);
  if (notifyEnabled()) await notify(report);

  return { ...summary, bulgaria: bg };
}
