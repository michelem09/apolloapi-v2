const fs = require('fs');

/**
 * Which kind of Apollo this is, from the one place the rest of the system
 * already looks: BOARD_NAME in /etc/armbian-release. `miner_start.sh` (picks the
 * miner binary), `set_UI_mode.sh` (writes NEXT_PUBLIC_CHASSIS for the UI's
 * `minerFamily`) and `rc.local` all source that same file, so this answers the
 * question exactly as they do.
 *
 *   'apollo-iii'  BOARD_NAME="Apollo 3"   internal apollo-miner-v3
 *   'solo-node'   BOARD_NAME="Solo Node"  no internal miner (USB boards only)
 *   'legacy'      any other BOARD_NAME    Apollo I/II (the scripts' catch-all)
 *   'unknown'     file missing/unreadable, or no BOARD_NAME in it (dev machine,
 *                 CI): callers treat this as "do not restrict anything"
 *
 * Only a definite answer is cached — a board never changes at runtime, but an
 * unreadable file might be readable on the next call.
 */
const RELEASE_FILE = '/etc/armbian-release';

const cache = new Map();

function releasePath(env = process.env) {
  return env.ARMBIAN_RELEASE_FILE || RELEASE_FILE;
}

// `. /etc/armbian-release` semantics for the one key we need: KEY=value, KEY="value" or 'value'.
function parseBoardName(text) {
  let board = null;
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*BOARD_NAME\s*=\s*(.*?)\s*$/);
    if (m) board = m[1].replace(/^(["'])(.*)\1$/, '$2');
  }
  return board || null;
}

function familyOf(board) {
  if (!board) return 'unknown';
  if (board === 'Apollo 3') return 'apollo-iii';
  if (board === 'Solo Node') return 'solo-node';
  return 'legacy';
}

function getDeviceFamily(env = process.env) {
  const file = releasePath(env);
  if (cache.has(file)) return cache.get(file);

  let family = 'unknown';
  try {
    family = familyOf(parseBoardName(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    // Missing or unreadable: unknown, not cached.
  }
  if (family !== 'unknown') cache.set(file, family);
  return family;
}

const resetDeviceFamilyCache = () => cache.clear();

module.exports = { getDeviceFamily, parseBoardName, familyOf, resetDeviceFamilyCache };
