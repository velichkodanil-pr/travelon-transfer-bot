// Persistent record of bookings we have already messaged.
// This is a SECONDARY safeguard against duplicates — the primary guard is the
// in-chat scan (chatAlreadyRequested). If DATA_DIR is ephemeral (no volume),
// the store simply resets on restart and the in-chat scan still prevents
// double-sends.
//
// Every write is ATOMIC (write a temp file, then rename over the old one): a
// container killed mid-write used to leave half a JSON file, which the loaders
// below read as "empty" — the next write then replaced the whole history with
// a single entry.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const FILE = path.join(config.dataDir, 'sent.json');

async function ensureDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

let tmpSeq = 0;
async function writeJsonAtomic(file, obj) {
  await ensureDir();
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

// Missing file -> fallback. Unreadable file -> keep a copy (once per process) and
// say so in the log instead of silently starting from an empty state.
const backedUp = new Set();
async function readJson(file, fallback) {
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    if (!backedUp.has(file)) {
      backedUp.add(file);
      log.warn(`State file ${path.basename(file)} is unreadable (${err.message}) — saved a copy, continuing with an empty state.`);
      await fs.copyFile(file, `${file}.corrupt-${Date.now()}`).catch(() => {});
    }
    return fallback;
  }
}

export async function loadSent() {
  const data = await readJson(FILE, {});
  return new Map(Object.entries(data && typeof data === 'object' ? data : {}));
}

export async function markSent(bookingId, meta = {}) {
  try {
    const sent = await loadSent();
    sent.set(String(bookingId), { at: new Date().toISOString(), ...meta });
    await writeJsonAtomic(FILE, Object.fromEntries(sent));
  } catch (err) {
    log.warn('Could not persist sent-store (continuing):', err.message);
  }
}

export async function wasSent(bookingId) {
  const sent = await loadSent();
  return sent.has(String(bookingId));
}

// The stored record for a booking ({ at, country, source? }) or null.
export async function getSent(bookingId) {
  const sent = await loadSent();
  return sent.get(String(bookingId)) || null;
}

// --- Bulgaria/Eline per-booking watch state -------------------------------
// Stored in data/bulgaria.json: { [bookingId]: { askedAt, remindedAt, doneAt, ... } }
// Persist across restarts by attaching a Railway Volume at DATA_DIR (optional;
// the in-chat scan still prevents duplicate asks if the file is lost).
const WATCH_FILE = path.join(config.dataDir, 'bulgaria.json');

export async function loadWatch() {
  return readJson(WATCH_FILE, {});
}

export async function getWatch(bookingId) {
  const w = await loadWatch();
  return w[String(bookingId)] || null;
}

export async function setWatch(bookingId, patch) {
  try {
    const w = await loadWatch();
    const key = String(bookingId);
    w[key] = { ...(w[key] || {}), ...patch };
    await writeJsonAtomic(WATCH_FILE, w);
  } catch (err) {
    log.warn('Could not persist watch-store (continuing):', err.message);
  }
}

// --- Bus-warning per-booking state (data/busWarn.json): { [id]: { warnedAt } } ---
const BUSWARN_FILE = path.join(config.dataDir, 'busWarn.json');

export async function loadBusWarn() {
  return readJson(BUSWARN_FILE, {});
}

export async function getBusWarn(bookingId) {
  const w = await loadBusWarn();
  return w[String(bookingId)] || null;
}

export async function setBusWarn(bookingId, patch) {
  try {
    const w = await loadBusWarn();
    const key = String(bookingId);
    w[key] = { ...(w[key] || {}), ...patch };
    await writeJsonAtomic(BUSWARN_FILE, w);
  } catch (err) {
    log.warn('Could not persist busWarn-store (continuing):', err.message);
  }
}

// --- Insurance/RU-BY doc-request state (data/insDoc.json): { [id]: { checkedAt, sentAt, ruby } } ---
const INSDOC_FILE = path.join(config.dataDir, 'insDoc.json');

export async function loadInsDoc() {
  return readJson(INSDOC_FILE, {});
}

export async function getInsDoc(bookingId) {
  const w = await loadInsDoc();
  return w[String(bookingId)] || null;
}

export async function setInsDoc(bookingId, patch) {
  try {
    const w = await loadInsDoc();
    const key = String(bookingId);
    w[key] = { ...(w[key] || {}), ...patch };
    await writeJsonAtomic(INSDOC_FILE, w);
  } catch (err) {
    log.warn('Could not persist insDoc-store (continuing):', err.message);
  }
}
