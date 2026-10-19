// Helpers for the usb-miner journey: simulating an unplug without touching the
// cable, and putting it back.
//
// An unplug is simulated by writing 0 to the `authorized` attribute of the USB
// DEVICE. Getting the device wrong is not a failed test, it is damage:
// `readlink -f /sys/class/tty/ttyACMn/device` is the INTERFACE directory
// (…/3-1.1/3-1.1:1.0); the device is its parent (…/3-1.1); one level further up
// is the HUB (idVendor 1a40), and deauthorizing it drops everything else on it
// (Bluetooth, the Home Assistant sticks). That happened once, by hand. So the
// path is derived by a strict rule, the vendor/product is read and checked
// before anything is written, and the shell command that writes checks them
// again itself.
//
// Everything here is pure or takes its collaborators (`ssh`, `fs`), so the rules
// are tested with fixture paths (test/journeys-usb.test.js).

const fs = require('fs');
const path = require('path');

const BOARD = { vendor: '0483', product: '5740' };
// The state file the spec writes BEFORE it deauthorizes and the parent reads when
// it puts the device back (the spec runs in its own process: a file is the only
// shared state). It lives in the run's output directory.
const MARKER = 'usb.deauthorized';

const SYS = '/sys/devices/';
// A USB device directory: bus-port[.port…], no ':config.interface' suffix. The root
// hubs are `usbN`, which this does not match either.
const DEVICE_RE = /^\d+-\d+(?:\.\d+)*$/;
const INTERFACE_RE = /^(\d+-\d+(?:\.\d+)*):\d+\.\d+$/;
const SAFE_PATH_RE = /^[A-Za-z0-9_./:@-]+$/;

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// "/dev/ttyACM0" or "ttyACM0" -> "ttyACM0"; anything else -> null.
const ttyOf = (port) => /\b(ttyACM\d+)$/.exec(String(port || '').trim())?.[1] ?? null;

// The USB device directory behind the INTERFACE directory that readlink gave.
// Only the exact shape `<device>/<device>:<cfg>.<if>` is accepted, with the
// interface's own device name equal to its parent's: a path that is already a
// device, a hub, a root hub or anything else comes back null, never "one level up".
const usbDeviceDirOf = (realpath) => {
  const p = String(realpath || '').trim();
  if (!p.startsWith(SYS) || !SAFE_PATH_RE.test(p) || p.includes('..')) return null;
  const parts = p.split('/');
  const iface = INTERFACE_RE.exec(parts[parts.length - 1]);
  if (!iface) return null;
  const parent = parts[parts.length - 2];
  if (parent !== iface[1] || !DEVICE_RE.test(parent)) return null;
  return parts.slice(0, -1).join('/');
};

// Is this directory, as a string, one we would write `authorized` into?
const isDeviceDir = (dir) => {
  const p = String(dir || '');
  return p.startsWith(SYS) && SAFE_PATH_RE.test(p) && !p.includes('..') && DEVICE_RE.test(p.split('/').pop());
};

const parseIds = (text) => {
  const [vendor = '', product = ''] = String(text || '').split('\n').map((l) => l.trim().toLowerCase());
  return { vendor, product };
};
const isApolloBoard = ({ vendor, product } = {}) =>
  String(vendor || '').trim().toLowerCase() === BOARD.vendor && String(product || '').trim().toLowerCase() === BOARD.product;

// The write. Disabling (value 0) re-checks vendor and product in the shell, at the
// moment of the write, and does nothing otherwise. Enabling (value 1) does not: it
// is never destructive, and a deauthorized device must be re-enabled even if its
// descriptor can no longer be read.
const authorizeCommand = (dir, value) => {
  if (!isDeviceDir(dir)) throw new Error(`refusing to write: ${dir} is not a USB device directory`);
  if (value !== 0 && value !== 1) throw new Error('authorized is 0 or 1');
  const d = shq(dir);
  const check = value === 0
    ? `[ "$(cat "$d/idVendor")" = ${BOARD.vendor} ] && [ "$(cat "$d/idProduct")" = ${BOARD.product} ] && `
    : '';
  return `d=${d}; ${check}echo ${value} | sudo -n tee "$d/authorized" >/dev/null && cat "$d/authorized"`;
};

// ------------------------------------------------------------------ rig

const readMarker = (fsImpl, markerPath) => {
  try {
    const m = JSON.parse(fsImpl.readFileSync(markerPath, 'utf8'));
    return m && typeof m.dir === 'string' ? m : null;
  } catch {
    return null;
  }
};

// Put back what the marker says was deauthorized. Used by the journey's own
// `finally` and by the round's restore.
const replugFromMarker = async ({ ssh, markerPath, fsImpl = fs, waitUntil = null, tty = null }) => {
  const m = readMarker(fsImpl, markerPath);
  if (!m) return { restored: false, notes: [], errors: [] };
  const notes = [];
  const errors = [];
  if (!isDeviceDir(m.dir)) {
    errors.push(`usb: the marker names ${m.dir}, which is not a USB device directory: not touched`);
    return { restored: false, notes, errors };
  }
  try {
    const out = await ssh(authorizeCommand(m.dir, 1));
    if (String(out).trim() !== '1') throw new Error(`authorized reads "${String(out).trim()}" after the write`);
    fsImpl.rmSync(markerPath, { force: true });
    notes.push(`usb: ${m.dir} authorized again`);
  } catch (err) {
    errors.push(`usb: could not re-authorize ${m.dir}: ${err.message} — do it by hand: echo 1 | sudo tee ${m.dir}/authorized`);
    return { restored: false, notes, errors };
  }
  const port = tty || m.tty;
  if (waitUntil && port) {
    const back = await waitUntil(async () => {
      try { return (await ssh(`test -e /dev/${port} && echo yes || true`)).trim() === 'yes'; } catch { return false; }
    }, { timeoutMs: 60000, everyMs: 3000 });
    if (!back.ok) errors.push(`usb: /dev/${port} did not come back within 60 s of the re-authorize`);
  }
  return { restored: true, notes, errors };
};

const createUsbRig = ({ ssh, markerPath, fsImpl = fs, waitUntil = null }) => {
  // Where the board really is, and proof that it is the board. Throws, writes nothing.
  const inspect = async (tty) => {
    if (!/^ttyACM\d+$/.test(tty)) throw new Error(`"${tty}" is not a ttyACM port`);
    const iface = (await ssh(`readlink -f /sys/class/tty/${tty}/device`)).trim();
    const dir = usbDeviceDirOf(iface);
    if (!dir) throw new Error(`refusing: /sys/class/tty/${tty}/device resolves to ${iface || '(nothing)'}, which is not a USB interface directory — nothing written`);
    const ids = parseIds(await ssh(`cat ${shq(`${dir}/idVendor`)} ${shq(`${dir}/idProduct`)}`));
    if (!isApolloBoard(ids)) {
      throw new Error(`refusing: ${dir} is ${ids.vendor || '?'}:${ids.product || '?'}, not a ${BOARD.vendor}:${BOARD.product} board — nothing written`);
    }
    return { dir, iface, ids };
  };

  const unplug = async (tty) => {
    const { dir } = await inspect(tty);
    // Before the write: a crash right after it must still leave the way back.
    fsImpl.writeFileSync(markerPath, JSON.stringify({ dir, tty, at: new Date().toISOString() }), { mode: 0o600 });
    const out = await ssh(authorizeCommand(dir, 0));
    if (String(out).trim() !== '0') throw new Error(`authorized reads "${String(out).trim()}" after the write`);
    return dir;
  };

  const replug = () => replugFromMarker({ ssh, markerPath, fsImpl, waitUntil });
  const isUnplugged = () => readMarker(fsImpl, markerPath) !== null;
  return { inspect, unplug, replug, isUnplugged };
};

// ------------------------------------------------------------ API, device

// `ps -eo pid=,comm=,args=` -> the miner processes and the port each one drives.
// The comm is the binary: screen's own command line also names the miner, and must
// not be counted as a second miner.
const parseMinerProcs = (text) =>
  String(text || '').split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => /^futurebit-miner/.test(m[2]))
    .map((m) => ({ pid: Number(m[1]), comport: /-comport\s+(\S+)/.exec(m[3])?.[1] ?? null }));
const procsOn = (procs, tty) => procs.filter((p) => p.comport === `/dev/${tty}`);
const internalProcs = (procs) => procs.filter((p) => p.comport && !/ttyACM/.test(p.comport));

// A schema without `Miner.boards`: the feature is not on this build.
const isBoardsMissing = (err) =>
  !!err && err.malformed === true && /Cannot query field "boards"/.test(String(err.message));

const usbBoards = (boards) => (boards || []).filter((b) => b.kind === 'usb');

const msUntilExpiry = (board, nowMs) => {
  const t = Date.parse(board?.expiresAt);
  return Number.isFinite(t) ? t - nowMs : null;
};
const expiresAround = (board, nowMs, { minMs = 13 * 60000, maxMs = 16 * 60000 } = {}) => {
  const ms = msUntilExpiry(board, nowMs);
  return ms !== null && ms >= minMs && ms <= maxMs;
};

// ------------------------------------------------------------------- UI

// Every "Active a/t" badge in a block of page text.
const activeBadges = (text) =>
  [...String(text || '').matchAll(/Active\s+(\d+)\s*\/\s*(\d+)/g)].map((m) => ({ active: Number(m[1]), total: Number(m[2]) }));

// "rgb(237, 137, 54)" is Chakra's orange.500; accept the warm range, not one value.
const isOrange = (css) => {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(css || ''));
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return r >= 200 && g >= 90 && g <= 190 && b <= 110 && r - b >= 100;
};

const leadingInt = (text) => {
  const m = /(\d+)\s*$/.exec(String(text || '').trim());
  return m ? Number(m[1]) : null;
};

module.exports = {
  BOARD,
  MARKER,
  shq,
  ttyOf,
  usbDeviceDirOf,
  isDeviceDir,
  parseIds,
  isApolloBoard,
  authorizeCommand,
  readMarker,
  replugFromMarker,
  createUsbRig,
  parseMinerProcs,
  procsOn,
  internalProcs,
  isBoardsMissing,
  usbBoards,
  msUntilExpiry,
  expiresAround,
  activeBadges,
  isOrange,
  leadingInt,
  markerFile: (out) => path.join(out, MARKER),
};
