// One full pass: login -> filter -> per-booking dedup check -> send/log.
import { TravelonClient } from './travelon.js';
import { config, ALREADY_SENT_PATTERNS } from './config.js';
import { log } from './logger.js';
import { getSent, markSent } from './store.js';
import { stopRequested, stopReason } from './stop.js';
import { notify, notifyEnabled } from './notify.js';
import { runBulgaria } from './bulgaria.js';
import { runBusWarn } from './busWarn.js';
import { runInsuranceDoc } from './insuranceRuby.js';
import { reportEnabled, upsertRows, upsertBusWarnRows, writeBotStatus } from './report.js';

const RECHECK_MS = 1500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// deps are injectable for tests (fake browser client); production uses the defaults.
export async function runCycle({ makeClient = () => new TravelonClient(), bgDeps } = {}) {
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
  let bw = null;
  let ins = null;
  let bookings = []; // hoisted so the report step (after the cycle) can see it

  const client = makeClient();
  try {
    await client.init();
    await client.login();
    await client.openRequests();

    // Scan by CHECK-IN date with pagination (not "first page of newest bookings"),
    // so a booking missed while the bot was down is still picked up afterwards.
    bookings = await client.listUpcomingMatching({
      statusIds: config.generic.statusIds,
      checkinFromDays: config.generic.checkinFromDays,
      maxPages: config.generic.maxListPages,
      createdFromISO: config.generic.createdFromISO,
    });
    summary.matched = bookings.map((b) => `${b.id}/${b.country}`);

    let sends = 0;
    for (const [idx, b] of bookings.entries()) {
      if (stopRequested()) {
        log.warn(`Stop requested — ${bookings.length - idx} booking(s) left for the next cycle.`);
        break;
      }
      try {
        const prev = await getSent(b.id);
        // Read the chat feed once (~0.3 s, no navigation); null = unreadable.
        let feed;
        const readFeed = async () => {
          if (feed === undefined) feed = client.readChatTextFast ? await client.readChatTextFast(b.id) : null;
          return feed;
        };
        if (prev) {
          // GHOST_RECHECK: our earlier "send" may never have reached the chat.
          let ghost = false;
          if (config.ghostRecheck && !config.dryRun && prev.source !== 'chat-existing') {
            const f = await readFeed();
            ghost = f !== null && !ALREADY_SENT_PATTERNS.some((re) => re.test(f));
          }
          if (!ghost) {
            if (prev.source === 'chat-existing') {
              summary.skippedAlready.push(b.id);
              log.info(`Skip ${b.id}: request already in chat (remembered).`);
            } else {
              summary.skippedStore.push(b.id);
              log.info(`Skip ${b.id}: already messaged on a previous run.`);
            }
            continue;
          }
          log.info(`${b.id}: recorded as sent, but the request is not in the chat — sending again.`);
        }

        // Fast path: decide from the chat feed, open the drawer only to send.
        if ((await readFeed()) !== null) {
          if (ALREADY_SENT_PATTERNS.some((re) => re.test(feed))) {
            summary.skippedAlready.push(b.id);
            log.info(`Skip ${b.id}: transfer-phone request already present in chat.`);
            if (!config.dryRun) await markSent(b.id, { country: b.country, source: 'chat-existing' });
            continue;
          }
          if (config.dryRun) {
            summary.wouldSend.push(b.id);
            log.info(`[DRY-RUN] Would send to ${b.id} (${b.country}).`);
            continue;
          }
          if (sends >= config.maxSendsPerRun) {
            log.warn(`Reached MAX_SENDS_PER_RUN=${config.maxSendsPerRun}; stopping sends.`);
            break;
          }
          await client.openChat(b.id);
          if (!(await client.chatPanelVisible())) {
            summary.errors.push(`${b.id}: chat did not open — retry next cycle`);
            log.warn(`Skip ${b.id}: chat drawer did not open (site slow?) — retry next cycle.`);
            await client.closeChat(b.id).catch(() => {});
            continue;
          }
          await client.sendMessage();
          await markSent(b.id, { country: b.country });
          sends += 1;
          summary.sent.push(b.id);
          log.info(`Sent to ${b.id} (${b.country}).`);
          await client.closeChat(b.id);
          continue;
        }

        // Fallback (feed unreadable): the drawer, exactly as before.
        await client.openChat(b.id);

        // No chat drawer -> we cannot see the history, so we must not decide
        // "not requested yet" (the check would fall back to the page body).
        if (!(await client.chatPanelVisible())) {
          summary.errors.push(`${b.id}: chat did not open — retry next cycle`);
          log.warn(`Skip ${b.id}: chat drawer did not open (site slow?) — retry next cycle.`);
          await client.closeChat(b.id).catch(() => {});
          continue;
        }

        // The history loads asynchronously: look twice before deciding it is empty.
        const requested = async () => {
          if (await client.chatAlreadyRequested()) return true;
          await sleep(RECHECK_MS);
          return client.chatAlreadyRequested();
        };

        if (await requested()) {
          summary.skippedAlready.push(b.id);
          log.info(`Skip ${b.id}: transfer-phone request already present in chat.`);
          // Remember it, so the chat is not reopened every hour. Only when the
          // request is in the chat PANEL itself (chatAlreadyRequested may fall back
          // to the whole page, and a fluke match there must not become permanent).
          if (!config.dryRun) {
            const panel = await client.readChatPanelText().catch(() => '');
            if (ALREADY_SENT_PATTERNS.some((re) => re.test(panel))) {
              await markSent(b.id, { country: b.country, source: 'chat-existing' });
            }
          }
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
    if (config.bulgaria.enabled && !stopRequested()) {
      bg = await runBulgaria(client, bgDeps);
    }

    // Bus-seating warning — reuses the same logged-in TravelON session.
    if (config.busWarn.enabled && !stopRequested()) {
      bw = await runBusWarn(client);
    }

    // Insurance + RU/BY-citizen document request — reuses the logged-in session.
    if (config.insuranceRuby.enabled && !stopRequested()) {
      ins = await runInsuranceDoc(client);
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
  const interrupted = stopRequested() ? stopReason() : '';
  if (interrupted) lines.push(`Interrupted: ${interrupted} — the rest is picked up by the next cycle`);
  let report = lines.join('\n');
  if (bg && bg.report) report += '\n\n' + bg.report;
  if (bw && bw.report) report += '\n\n' + bw.report;
  if (ins && ins.report) report += '\n\n' + ins.report;
  log.info('Cycle summary:\n' + report);
  // An interrupted cycle (graceful stop on redeploy) skips notify + Sheet: its
  // buckets are partial, and unprocessed bookings would be reported as handled.
  if (interrupted) return { ...summary, bulgaria: bg, interrupted };
  if (notifyEnabled()) await notify(report);

  // --- Google Sheet tracker (best-effort; never breaks the cycle) ----------
  if (reportEnabled()) {
    await writeBotStatus(); // пульс + бейдж «БОТ АКТИВНИЙ» — щоциклу, незалежно від рядків
    try {
      // Generic-flow rows (Greece/Albania/Croatia/Spain): id, country, creation
      // date + the outcome derived from the summary buckets. These countries
      // only get an agent request — phone reading/writing is Bulgaria-only.
      const genericRows = bookings.map((b) => {
        let asked = '';
        let status = 'Оброблено';
        if (summary.sent.includes(b.id)) {
          asked = 'так';
          status = 'Запит надіслано';
        } else if (summary.wouldSend.includes(b.id)) {
          asked = config.dryRun ? 'ні (відписав би)' : 'так';
          status = 'DRY-RUN: відписав би';
        } else if (summary.skippedAlready.includes(b.id)) {
          asked = 'так';
          status = 'Вже є запит у чаті';
        } else if (summary.skippedStore.includes(b.id)) {
          asked = 'так';
          status = 'Запит надіслано раніше';
        }
        return {
          bookingId: b.id,
          elineRef: '',
          country: b.country,
          bookingDate: b.dateISO || '',
          checkinDate: '',
          phonePresent: '',
          asked,
          agentNumber: '',
          writtenInBooking: '',
          writtenInEline: '',
          status,
          note: config.dryRun ? 'DRY-RUN' : '',
        };
      });

      const bgRows = bg && bg.rows ? bg.rows : [];
      const res = await upsertRows([...genericRows, ...bgRows]);
      log.info(`Report: Google Sheet — ${res.updated} оновлено, ${res.appended} додано.`);
      report += `\nReport: Sheet +${res.appended} нових / ${res.updated} оновлено`;

      if (bw && bw.rows && bw.rows.length) {
        const bwRes = await upsertBusWarnRows(bw.rows);
        log.info(`Report: BusWarn tab — ${bwRes.updated} оновлено, ${bwRes.appended} додано.`);
        report += `\nBusWarn tab: +${bwRes.appended} / ${bwRes.updated}`;
      }
    } catch (e) {
      log.warn('Report update failed (continuing): ' + e.message);
    }
  }

  return { ...summary, bulgaria: bg };
}
