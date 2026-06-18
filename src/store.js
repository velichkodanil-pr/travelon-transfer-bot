// Persistent record of bookings we have already messaged.
// This is a SECONDARY safeguard against duplicates — the primary guard is the
// in-chat scan (chatAlreadyRequested). If DATA_DIR is ephemeral (no volume),
// the store simply resets on restart and the in-chat scan still prevents
// double-sends.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { log } from './logger.js';

const FILE = path.join(config.dataDir, 'sent.json');

async function ensureDir() {
  await fs.mkdir(config.dataDir, { recursive: true });
}

export async function loadSent() {
  try {
    const raw = await fs.readFile(FILE, 'utf8');
    const data = JSON.parse(raw);
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

export async function markSent(bookingId, meta = {}) {
  try {
    await ensureDir();
    const sent = await loadSent();
    sent.set(String(bookingId), { at: new Date().toISOString(), ...meta });
    const obj = Object.fromEntries(sent);
    await fs.writeFile(FILE, JSON.stringify(obj, null, 2), 'utf8');
  } catch (err) {
    log.warn('Could not persist sent-store (continuing):', err.message);
  }
}

export async function wasSent(bookingId) {
  const sent = await loadSent();
  return sent.has(String(bookingId));
}
