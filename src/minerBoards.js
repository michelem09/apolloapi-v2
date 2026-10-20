const fs = require('fs');
const path = require('path');
const { getDeviceFamily } = require('./deviceFamily');

/**
 * Registry of the hashboards the device knows about, internal and USB.
 *
 * Sources, all read from the machine (nothing is persisted):
 *  - stat files in the apollo-miner dir (`apollo-miner.<id>` v1,
 *    `apollo-miner-v2.<id>` v2, `apollo-miner-3.json` v3). They exist only
 *    while a miner has run, and miner_start.sh deletes the enumerated ones;
 *  - the ttyACM ports and their USB serial/product (/sys/class/tty). The USB
 *    serial equals the uuid in the stat file (verified on a Solo Node), so it
 *    is the join key between a port and a board.
 *
 * `deriveBoards` is pure (input + memory + clock in, boards + new memory out);
 * `MinerBoards` wraps it with the file reads, change detection and watching.
 *
 * Supersedes the 60 s grace of src/usbMiners.js on v2.2: a replug is absorbed
 * by DEBOUNCE_MS here, and a lost board is kept visible for EXPIRY_MS.
 */
const DEBOUNCE_MS = 5 * 1000; // a replug enumerates up to 4 times in 20 s
const EXPIRY_MS = 15 * 60 * 1000; // a disconnected board is forgotten after this
const STUCK_MS = 2 * 60 * 1000; // a board in IAP (bootloader) this long is not coming up
const MINING_MS = 15 * 1000; // same "fresh stat file" threshold as services/miner.js

const iso = (ms) => (ms === null || ms === undefined ? null : new Date(ms).toISOString());

// USB ids of the hashboards, as in backend/udev/99-apollo-usb-miner.rules.
const MINER_VID = '0483';
const MINER_PID = '5740';

const STAT_RE = /^apollo-miner(?:-v(\d+))?\.(.+)$/;

// Filename -> { version, id }, or null when it is not a stat file.
function parseStatFileName(file) {
  if (file === 'apollo-miner-3.json') return { version: 'v3', id: '3' };
  const m = file.match(STAT_RE);
  if (!m) return null;
  return { version: m[1] ? `v${m[1]}` : 'v1', id: m[2] };
}

// "BCO IAP #<serial>" is the bootloader phase: a board enumerates as IAP on
// power-on and after every miner stop (which resets it), then re-enumerates as
// "BCO SLV #<serial>" (the miner firmware) about 30 s later, with the SAME serial.
// Negative match only: the SLV/RD6 strings of other boards are not all known.
// One criterion in four places (this file, the udev rule, miner_start.sh and
// usb_miner_run.sh): the word IAP, case-sensitive, in the USB product string.
const isIap = (port) => /\bIAP\b/.test(port.product || '');

const portDev = (name) => `/dev/${name}`;

function classifyKind({ entry, port, family }) {
  if (entry) {
    if (entry.version === 'v3') return 'internal';
    const cp = entry.comport || '';
    if (/\/ttyS\d+$/.test(cp) || /^ttyS\d+$/.test(cp)) return 'internal';
    if (/ttyACM\d+$/.test(cp)) return 'usb';
  }
  if (port) return 'usb';
  // No usable comport and no port: a Solo Node has no internal miner.
  return family === 'solo-node' ? 'usb' : 'internal';
}

function buildSnapshot(boards, family) {
  const usb = boards.filter((b) => b.kind === 'usb');
  return {
    boards,
    hasMiner: family !== 'solo-node' || usb.length > 0,
    hasUsbMiners: usb.length > 0,
    usbCount: usb.length,
    // Only `active` boards count: booting, stuck and disconnected are attached
    // (hasUsbMiners / usbCount) but not mining.
    usbActiveCount: usb.filter((b) => b.status === 'active').length,
    // Booting = in the bootloader (IAP), under 2 minutes: about to become a miner.
    usbBootingCount: usb.filter((b) => b.status === 'booting').length,
    deviceFamily: family,
  };
}

/**
 * Memory shape: { [id]: { uuid, serial, family, kind, port, since, lastSeen, absentSince, iapSince } }
 * (times in ms; iapSince = start of the continuous IAP phase, null otherwise). Returns { boards, memory, nextExpiryAt } where nextExpiryAt is the
 * earliest ISO instant at which the result changes with no new input (end of a
 * debounce window, or a disconnected board expiring), or null.
 */
// When the board enumerated, from the port collector (the ctime of its device
// node), clamped to the clock; `now` when unknown.
const enumeratedAt = (port, now) => {
  const t = port.enumeratedAtMs;
  return typeof t === 'number' && Number.isFinite(t) ? Math.min(t, now) : now;
};

function deriveBoards({ family = 'unknown', statEntries = [], ports = [], memory = {}, now }) {
  // IAP ports are kept: the board is booting, not absent.
  const livePorts = ports
    .filter((p) => /^ttyACM\d+$/.test(p.name))
    .map((p) => ({ ...p, iap: isIap(p) }));

  // One entry per uuid (the newest file wins).
  const entries = new Map();
  for (const e of statEntries) {
    const prev = entries.get(e.uuid);
    if (!prev || e.mtimeMs > prev.mtimeMs) entries.set(e.uuid, e);
  }

  const cands = new Map(); // id -> { id, entry, port }
  const claimed = new Set();
  for (const [id, entry] of entries) cands.set(id, { id, entry, port: null });

  for (const p of livePorts) {
    let c = p.serial ? cands.get(p.serial) : null;
    if (!c) {
      // No stat file under this serial: either the serial is unreadable, or it
      // differs from the uuid the miner wrote (verified equal only on Apollo BTC).
      // Join on the port the stat file names, so the mining board is not marked
      // disconnected next to a phantom one. The stat uuid stays the board id.
      c = [...cands.values()].find(
        (x) => !x.port && x.entry && path.basename(x.entry.comport || '') === p.name
      );
    }
    if (c) {
      // IAP and SLV of one board can be listed together for an instant: SLV wins.
      if (!c.port || (c.port.iap && !p.iap)) c.port = p;
      claimed.add(p.name);
    } else {
      const id = p.serial || `port:${p.name}`;
      cands.set(id, { id, entry: null, port: p });
    }
  }
  // A port whose serial could not be read is listed as `port:<name>`; when the
  // same port comes back with a real serial (IAP -> SLV) inside the debounce, it
  // is the same board: the serial-less entry is absorbed instead of left behind
  // as a disconnected ghost.
  const mem = { ...memory };
  for (const c of cands.values()) {
    if (!c.port || c.id.startsWith('port:') || mem[c.id]) continue;
    const ghostId = `port:${c.port.name}`;
    const ghost = mem[ghostId];
    if (ghost && (ghost.absentSince === null || ghost.absentSince === undefined || now - ghost.absentSince < DEBOUNCE_MS)) {
      mem[c.id] = { ...ghost, uuid: c.id };
      delete mem[ghostId];
    }
  }
  for (const id of Object.keys(mem)) {
    if (!cands.has(id)) cands.set(id, { id, entry: null, port: null });
  }

  const boards = [];
  const nextMemory = {};
  let next = null;
  const soon = (ms) => {
    if (ms > now && (next === null || ms < next)) next = ms;
  };

  for (const c of cands.values()) {
    const prev = mem[c.id];
    const kind = prev && !c.entry && !c.port ? prev.kind : classifyKind({ ...c, family });
    const boardFamily = (c.entry && c.entry.version) || (prev && prev.family) || null;
    const port = c.port ? portDev(c.port.name) : (c.entry && c.entry.comport) || (prev && prev.port) || null;
    const present = kind === 'internal' || Boolean(c.port);

    let since;
    let absentSince = null;
    let lastSeen;
    let status = 'active';
    let expiresAt = null;
    let iapSince = null;
    let outSince = null;

    if (present) {
      const flap = prev && (prev.absentSince === null || now - prev.absentSince < DEBOUNCE_MS);
      const wasIap = Boolean(prev) && prev.iapSince !== null && prev.iapSince !== undefined;
      since = flap ? prev.since : now;
      lastSeen = now;
      if (c.port && c.port.iap) {
        // Continuous since IAP was first seen; a gap longer than the debounce
        // (disconnected in between) starts the count again. With no memory at all
        // (API restart) the count starts when the board enumerated, not now.
        if (flap && wasIap) iapSince = prev.iapSince;
        else iapSince = prev ? now : enumeratedAt(c.port, now);
        since = iapSince;
        status = 'booting';
      } else if (wasIap) {
        // Left the bootloader: an active board is "since" the moment it came up.
        since = now;
      }
    } else {
      // First observed absence is now; with no memory at all (API restart) the
      // miner exited when the port vanished, so the stat-file mtime dates it.
      const mtime = c.entry ? Math.min(c.entry.mtimeMs, now) : now;
      absentSince = prev ? (prev.absentSince !== null ? prev.absentSince : now) : mtime;
      if (now - absentSince >= EXPIRY_MS) continue; // dropped, and forgotten
      lastSeen = prev ? prev.lastSeen : absentSince;
      if (now - absentSince < DEBOUNCE_MS && prev && prev.iapSince !== null && prev.iapSince !== undefined) {
        // Unplugged, or between IAP and SLV, but still inside the debounce:
        // keeps its state, so the booting phase does not flash orange.
        iapSince = prev.iapSince;
        status = 'booting';
      }
      if (now - absentSince >= DEBOUNCE_MS) {
        status = 'disconnected';
        since = absentSince;
        expiresAt = absentSince + EXPIRY_MS;
        soon(expiresAt);
      } else {
        since = prev ? prev.since : absentSince;
        soon(absentSince + DEBOUNCE_MS);
      }
    }

    if (status === 'booting') {
      // The 2-minute rule has its own timer: nothing else changes at that instant.
      if (now - iapSince >= STUCK_MS) {
        status = 'stuck';
        // A stuck board is "since" the moment it became stuck; booting keeps the IAP start.
        outSince = iapSince + STUCK_MS;
      } else soon(iapSince + STUCK_MS);
    }

    const mining = Boolean(
      present && c.entry && now - c.entry.mtimeMs <= MINING_MS && status === 'active'
    );
    boards.push({
      id: c.id,
      uuid: c.id,
      serial: c.port ? c.port.serial || null : (prev && prev.serial) || (kind === 'usb' ? c.id : null),
      family: boardFamily,
      kind,
      port,
      status,
      mining,
      since: iso(outSince !== null ? outSince : since),
      lastSeen: iso(lastSeen),
      expiresAt: iso(expiresAt),
    });
    nextMemory[c.id] = {
      uuid: c.id,
      serial: boards[boards.length - 1].serial,
      family: boardFamily,
      kind,
      port,
      since,
      lastSeen,
      absentSince,
      iapSince,
    };
  }

  boards.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind === 'internal' ? -1 : 1));
  return { boards, memory: nextMemory, nextExpiryAt: iso(next) };
}

function loadLogger() {
  try {
    // eslint-disable-next-line global-require
    return require('./logger')('minerBoards');
  } catch (e) {
    // No central logger on this line: console.* is what the surrounding code uses.
    const line = (fn) => (fields, msg) => {
      const err = fields && fields.err;
      fn(`[minerBoards] ${msg || ''}${err ? `: ${err.message || err}` : ''}`);
    };
    return {
      warn: line(console.warn),
      error: line(console.error),
      info() {},
      debug() {},
    };
  }
}

class MinerBoards {
  constructor({ env = process.env, logger, enumeratedAt = null } = {}) {
    this.env = env;
    if (enumeratedAt) this._enumeratedAt = enumeratedAt;
    this.log = logger || loadLogger();
    this.memory = {};
    this.last = buildSnapshot([], 'unknown');
    this.lastKey = this._key(this.last);
    this.listeners = new Set();
    this.watcher = null;
    this.debounceTimer = null;
    this.expiryTimer = null;
    this.started = false;
  }

  snapshot() {
    return this.last;
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // `lastSeen` drifts while a board is present and is left out; `mining` flips
  // matter to the UI and are included. Same reading twice -> same key.
  _key(snap) {
    return JSON.stringify({
      ...snap,
      boards: snap.boards.map(({ lastSeen, ...rest }) => rest), // eslint-disable-line no-unused-vars
    });
  }

  _dirs(env) {
    const statsDir =
      env.APOLLO_MINER_STATS_DIR || path.resolve(__dirname, '../backend/apollo-miner');
    return {
      statsDir,
      iiiDir: env.APOLLO_III_STATS_DIR || statsDir,
      devDir: env.APOLLO_USB_DEV_DIR || '/dev',
      sysDir: env.APOLLO_USB_SYS_DIR || '/sys/class/tty',
    };
  }

  _readStatEntries({ statsDir, iiiDir }) {
    const out = [];
    const readOne = (dir, file) => {
      const d = parseStatFileName(file);
      if (!d) return;
      try {
        const full = path.join(dir, file);
        const mtimeMs = fs.statSync(full).mtimeMs;
        let comport = null;
        if (d.version !== 'v3') {
          try {
            const j = JSON.parse(fs.readFileSync(full, 'utf8'));
            comport = (j && j.comport) || null;
          } catch (e) {
            // Half-written or unparsable: still a board, comport unknown.
          }
        }
        out.push({ file, uuid: d.id, version: d.version, comport, mtimeMs });
      } catch (e) {
        // Vanished between readdir and stat (miner_start.sh clears them).
      }
    };
    let files = [];
    try {
      files = fs.readdirSync(statsDir);
    } catch (e) {
      // Directory missing: no stat files.
    }
    for (const f of files) if (f !== 'apollo-miner-3.json') readOne(statsDir, f);
    readOne(iiiDir, 'apollo-miner-3.json');
    return out;
  }

  // Machine timestamp (ms) of a port's enumeration: devtmpfs creates the node at
  // that moment, so its ctime dates it. The single source for IAP start after an
  // API restart: swap this function if a better one turns up. null when unreadable.
  _enumeratedAt(devDir, name) {
    try {
      return fs.statSync(path.join(devDir, name)).ctimeMs;
    } catch (e) {
      return null;
    }
  }

  _readPorts({ sysDir, devDir }) {
    const readTxt = (p) => {
      try {
        return fs.readFileSync(p, 'utf8').trim() || null;
      } catch (e) {
        return null;
      }
    };
    let names = null;
    try {
      names = fs.readdirSync(sysDir).filter((n) => /^ttyACM\d+$/.test(n));
    } catch (e) {
      names = null;
    }
    if (names === null || names.length === 0) {
      // No sysfs entry (dev machine, tests): the device nodes alone, without serial.
      try {
        names = fs.readdirSync(devDir).filter((n) => /^ttyACM\d+$/.test(n));
      } catch (e) {
        names = [];
      }
      return names.map((name) => ({
        name,
        serial: null,
        product: null,
        enumeratedAtMs: this._enumeratedAt(devDir, name),
      }));
    }
    const ports = [];
    for (const name of names) {
      // `device` is a symlink to the USB interface; serial/product sit on its
      // parent. Resolve first: a lexical `device/..` would land on the tty dir.
      let base = null;
      try {
        base = path.join(fs.realpathSync(path.join(sysDir, name, 'device')), '..');
      } catch (e) {
        // No device link: serial and product stay unknown.
      }
      // Same filter as the udev rule: a Zigbee/Z-Wave stick, an Arduino or a
      // printer is a ttyACM too, and is not a miner.
      const vid = base && readTxt(path.join(base, 'idVendor'));
      const pid = base && readTxt(path.join(base, 'idProduct'));
      if (vid !== MINER_VID || pid !== MINER_PID) continue;
      ports.push({
        name,
        serial: readTxt(path.join(base, 'serial')),
        product: readTxt(path.join(base, 'product')),
        enumeratedAtMs: this._enumeratedAt(devDir, name),
      });
    }
    return ports;
  }

  /**
   * Re-read the machine and update the snapshot. Synchronous core (a handful of
   * tiny sysfs/stat reads), so callers that need an answer now can have it.
   * Returns true iff the snapshot changed.
   */
  refreshSync({ env = this.env, now = Date.now() } = {}) {
    const dirs = this._dirs(env);
    const family = getDeviceFamily(env);
    const res = deriveBoards({
      family,
      statEntries: this._readStatEntries(dirs),
      ports: this._readPorts(dirs),
      memory: this.memory,
      now,
    });
    this.memory = res.memory;
    this.nextExpiryAt = res.nextExpiryAt;
    const snap = buildSnapshot(res.boards, family);
    const key = this._key(snap);
    this.last = snap;
    this._scheduleExpiry(now);
    if (key === this.lastKey) return false;
    this.lastKey = key;
    for (const fn of this.listeners) {
      try {
        fn(snap);
      } catch (e) {
        this.log.warn({ err: e }, 'minerBoards listener failed');
      }
    }
    return true;
  }

  async refresh(opts) {
    return this.refreshSync(opts);
  }

  _scheduleExpiry(now) {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    if (!this.started || !this.nextExpiryAt) return;
    const wait = Math.max(Date.parse(this.nextExpiryAt) - now, 0) + 50;
    this.expiryTimer = setTimeout(() => this.refreshSync(), Math.min(wait, 2 ** 31 - 1));
    if (this.expiryTimer.unref) this.expiryTimer.unref();
  }

  start() {
    if (this.started) return;
    this.started = true;
    try {
      this.refreshSync();
    } catch (e) {
      this.log.warn({ err: e }, 'minerBoards initial refresh failed');
    }
    try {
      this.watcher = fs.watch(this._dirs(this.env).devDir, (event, name) => {
        if (name && !String(name).startsWith('ttyACM')) return;
        if (this.debounceTimer) clearTimeout(this.debounceTimer);
        this.debounceTimer = setTimeout(() => {
          this.debounceTimer = null;
          try {
            this.refreshSync();
          } catch (e) {
            this.log.warn({ err: e }, 'minerBoards refresh failed');
          }
        }, 1500);
        if (this.debounceTimer.unref) this.debounceTimer.unref();
      });
      this.watcher.on('error', (e) => this.log.warn({ err: e }, 'minerBoards watcher error'));
      if (this.watcher.unref) this.watcher.unref();
    } catch (e) {
      // Not fatal: callers still refresh() on their own cadence.
      this.log.warn({ err: e }, 'minerBoards cannot watch the device dir');
      this.watcher = null;
    }
  }

  stop() {
    this.started = false;
    if (this.watcher) this.watcher.close();
    this.watcher = null;
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.debounceTimer = null;
    this.expiryTimer = null;
  }
}

let singleton = null;
const getMinerBoards = () => {
  if (!singleton) singleton = new MinerBoards();
  return singleton;
};
const resetMinerBoards = () => {
  if (singleton) singleton.stop();
  singleton = null;
};

module.exports = {
  deriveBoards,
  buildSnapshot,
  parseStatFileName,
  MinerBoards,
  getMinerBoards,
  resetMinerBoards,
  DEBOUNCE_MS,
  EXPIRY_MS,
  STUCK_MS,
  MINING_MS,
};
