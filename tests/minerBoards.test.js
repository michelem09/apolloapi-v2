const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  deriveBoards,
  MinerBoards,
  DEBOUNCE_MS,
  EXPIRY_MS,
  STUCK_MS,
} = require('../src/minerBoards');

const T0 = Date.parse('2026-10-19T10:00:00Z');
const SERIAL = '310059000850393855313720';

const usbEntry = (over = {}) => ({
  file: `apollo-miner-v2.${SERIAL}`,
  uuid: SERIAL,
  version: 'v2',
  comport: '/dev/ttyACM0',
  mtimeMs: T0 - 2000,
  ...over,
});
const port = (over = {}) => ({ name: 'ttyACM0', serial: SERIAL, product: 'BCO SLV #1', ...over });
const run = (args) => deriveBoards({ family: 'solo-node', statEntries: [], ports: [], memory: {}, now: T0, ...args });
const byId = (res, id) => res.boards.find((b) => b.id === id);

describe('IAP criterion (shared table with the udev rule and the scripts)', () => {
  const rows = fs
    .readFileSync(path.join(__dirname, 'fixtures', 'iap_product_cases.tsv'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'));
  test.each(rows)('"%s" is IAP: %s', (product, want) => {
    const [b] = run({ ports: [port({ product })] }).boards;
    expect(b.status).toBe(want === 'yes' ? 'booting' : 'active');
  });
});

describe('deriveBoards classification', () => {
  test('v1 / v2 on ttyS1 are internal, ttyACM are usb, v3 internal', () => {
    const res = run({
      family: 'legacy',
      statEntries: [
        { file: 'apollo-miner.AAA', uuid: 'AAA', version: 'v1', comport: '/dev/ttyS1', mtimeMs: T0 },
        usbEntry(),
        { file: 'apollo-miner-3.json', uuid: '3', version: 'v3', comport: null, mtimeMs: T0 },
      ],
      ports: [port()],
    });
    expect(byId(res, 'AAA')).toMatchObject({ kind: 'internal', family: 'v1', status: 'active', mining: true });
    expect(byId(res, SERIAL)).toMatchObject({ kind: 'usb', family: 'v2', port: '/dev/ttyACM0', mining: true });
    expect(byId(res, '3')).toMatchObject({ kind: 'internal', family: 'v3' });
  });

  test('family unknown decides from the comport', () => {
    const res = run({
      family: 'unknown',
      statEntries: [
        { file: 'apollo-miner.AAA', uuid: 'AAA', version: 'v1', comport: '/dev/ttyS1', mtimeMs: T0 },
        usbEntry(),
      ],
      ports: [port()],
    });
    expect(byId(res, 'AAA').kind).toBe('internal');
    expect(byId(res, SERIAL).kind).toBe('usb');
  });

  test('a port with no stat file yet is a usb board of unknown family, not mining', () => {
    const res = run({ ports: [port()] });
    expect(res.boards).toEqual([
      expect.objectContaining({ id: SERIAL, kind: 'usb', family: null, mining: false, status: 'active' }),
    ]);
  });

  test('an IAP (bootloader) port is a booting board; a missing product is active', () => {
    expect(run({ ports: [port({ product: 'BCO IAP #1' })] }).boards).toEqual([
      expect.objectContaining({ id: SERIAL, kind: 'usb', status: 'booting', mining: false }),
    ]);
    expect(run({ ports: [port({ product: null })] }).boards).toHaveLength(1);
    expect(run({ ports: [port({ product: 'Apollo RD6' })] }).boards).toHaveLength(1);
  });

  test('stat file stale (> 15 s) means not mining but still active while the port is there', () => {
    const res = run({ statEntries: [usbEntry({ mtimeMs: T0 - 16000 })], ports: [port()] });
    expect(byId(res, SERIAL)).toMatchObject({ status: 'active', mining: false });
  });

  test('without a readable serial the port is matched by the comport in the stat file', () => {
    const res = run({ statEntries: [usbEntry()], ports: [port({ serial: null })] });
    expect(res.boards).toHaveLength(1);
    expect(res.boards[0]).toMatchObject({ id: SERIAL, status: 'active', mining: true });
  });
});

describe('deriveBoards serial that differs from the stat uuid', () => {
  test('the stat file joins the port by comport; no phantom board, not disconnected', () => {
    const res = run({
      statEntries: [usbEntry({ file: 'apollo-miner-v2.ABCDEF', uuid: 'ABCDEF' })],
      ports: [port({ serial: 'SERIAL-XYZ' })],
    });
    expect(res.boards).toEqual([
      expect.objectContaining({ id: 'ABCDEF', kind: 'usb', status: 'active', mining: true, port: '/dev/ttyACM0' }),
    ]);
  });

  test('a stat file on another port is not stolen', () => {
    const res = run({
      statEntries: [usbEntry({ file: 'apollo-miner-v2.ABCDEF', uuid: 'ABCDEF', comport: '/dev/ttyACM1' })],
      ports: [port({ serial: 'SERIAL-XYZ' })],
    });
    expect(res.boards.map((b) => b.id).sort()).toEqual(['ABCDEF', 'SERIAL-XYZ']);
  });
});

describe('deriveBoards lifecycle', () => {
  const present = () => run({ statEntries: [usbEntry()], ports: [port()] });

  test('absence under 5 s is debounced: still active', () => {
    const a = present();
    const b = run({ statEntries: [usbEntry({ mtimeMs: T0 - 2000 })], ports: [], memory: a.memory, now: T0 + 1000 });
    const c = run({ statEntries: [usbEntry({ mtimeMs: T0 - 2000 })], ports: [], memory: b.memory, now: T0 + 1000 + DEBOUNCE_MS - 1 });
    expect(byId(c, SERIAL).status).toBe('active');
    expect(c.nextExpiryAt).not.toBeNull();
  });

  test('unplug -> disconnected after 5 s, since = first observed absence, expiresAt +15 min', () => {
    let m = present().memory;
    const gone = run({ ports: [], memory: m, now: T0 + 1000 }); // first absent observation
    const later = run({ ports: [], memory: gone.memory, now: T0 + 1000 + DEBOUNCE_MS });
    const b = byId(later, SERIAL);
    expect(b).toMatchObject({ status: 'disconnected', mining: false });
    expect(b.since).toBe(new Date(T0 + 1000).toISOString());
    expect(b.expiresAt).toBe(new Date(T0 + 1000 + EXPIRY_MS).toISOString());
    expect(later.nextExpiryAt).toBe(b.expiresAt);
  });

  test('dropped after 15 min of continuous absence, and forgotten', () => {
    const gone = run({ ports: [], memory: present().memory, now: T0 + 1000 });
    const dropped = run({ ports: [], memory: gone.memory, now: T0 + 1000 + EXPIRY_MS });
    expect(dropped.boards).toEqual([]);
    expect(dropped.memory).toEqual({});
    const justBefore = run({ ports: [], memory: gone.memory, now: T0 + 1000 + EXPIRY_MS - 1 });
    expect(justBefore.boards).toHaveLength(1);
  });

  test('replug is active at once and the clock restarts', () => {
    const gone = run({ ports: [], memory: present().memory, now: T0 + 1000 });
    const disc = run({ ports: [], memory: gone.memory, now: T0 + 60000 });
    expect(byId(disc, SERIAL).status).toBe('disconnected');
    const back = run({ statEntries: [usbEntry({ mtimeMs: T0 + 61000 })], ports: [port()], memory: disc.memory, now: T0 + 62000 });
    expect(byId(back, SERIAL)).toMatchObject({ status: 'active', mining: true, expiresAt: null });
    expect(byId(back, SERIAL).since).toBe(new Date(T0 + 62000).toISOString());
  });

  test('a flap shorter than the debounce keeps the original since', () => {
    const a = present();
    const gone = run({ ports: [], memory: a.memory, now: T0 + 1000 });
    const back = run({ statEntries: [usbEntry()], ports: [port()], memory: gone.memory, now: T0 + 3000 });
    expect(byId(back, SERIAL).since).toBe(byId(a, SERIAL).since);
  });

  test('API restart: no memory, since is the stat-file mtime', () => {
    const mtime = T0 - 3 * 60000;
    const res = run({ statEntries: [usbEntry({ mtimeMs: mtime })], ports: [] });
    const b = byId(res, SERIAL);
    expect(b).toMatchObject({ status: 'disconnected' });
    expect(b.since).toBe(new Date(mtime).toISOString());
    expect(b.expiresAt).toBe(new Date(mtime + EXPIRY_MS).toISOString());
  });

  test('API restart with a stale leftover stat file (> 15 min) shows nothing', () => {
    expect(run({ statEntries: [usbEntry({ mtimeMs: T0 - EXPIRY_MS - 1 })], ports: [] }).boards).toEqual([]);
  });

  test('stat file deleted but the board is remembered (and keeps its family)', () => {
    const a = present();
    const res = run({ statEntries: [], ports: [port()], memory: a.memory, now: T0 + 5000 });
    expect(res.boards).toEqual([
      expect.objectContaining({ id: SERIAL, family: 'v2', status: 'active', mining: false, kind: 'usb' }),
    ]);
  });

  test('stat file deleted and port gone: remembered board goes disconnected', () => {
    const a = present();
    const gone = run({ ports: [], memory: a.memory, now: T0 + 1000 });
    const res = run({ ports: [], memory: gone.memory, now: T0 + 10000 });
    expect(byId(res, SERIAL)).toMatchObject({ status: 'disconnected', family: 'v2', kind: 'usb' });
  });

  test('same uuid on a different port is the same board', () => {
    const res = run({ statEntries: [usbEntry({ comport: '/dev/ttyACM0' })], ports: [port({ name: 'ttyACM3' })] });
    expect(res.boards).toHaveLength(1);
    expect(res.boards[0]).toMatchObject({ id: SERIAL, port: '/dev/ttyACM3', status: 'active' });
  });

  test('internal boards stay active even with no port at all', () => {
    const res = run({
      family: 'apollo-iii',
      statEntries: [{ file: 'apollo-miner-3.json', uuid: '3', version: 'v3', comport: null, mtimeMs: T0 - 3600000 }],
    });
    expect(res.boards[0]).toMatchObject({ kind: 'internal', status: 'active', mining: false, expiresAt: null });
  });
});

describe('snapshot flags per family', () => {
  const snapOf = (family, over) => {
    const { buildSnapshot } = require('../src/minerBoards');
    return buildSnapshot(run({ family, ...over }).boards, family);
  };

  test('solo node: no boards -> no miner; any usb board (even disconnected) -> miner', () => {
    expect(snapOf('solo-node', {})).toMatchObject({ hasMiner: false, hasUsbMiners: false, usbCount: 0 });
    expect(snapOf('solo-node', { ports: [port()] })).toMatchObject({ hasMiner: true, hasUsbMiners: true, usbCount: 1, usbActiveCount: 1 });
    const disc = snapOf('solo-node', { statEntries: [usbEntry({ mtimeMs: T0 - 60000 })] });
    expect(disc).toMatchObject({ hasMiner: true, usbCount: 1, usbActiveCount: 0 });
    expect(disc.usbBootingCount).toBe(0);
    const boot = snapOf('solo-node', { ports: [port({ product: 'BCO IAP #1' })] });
    expect(boot).toMatchObject({ usbActiveCount: 0, usbBootingCount: 1 });
  });

  test('other families always have a miner', () => {
    for (const f of ['legacy', 'apollo-iii', 'unknown']) {
      expect(snapOf(f, {}).hasMiner).toBe(true);
    }
    expect(snapOf('apollo-iii', {}).hasUsbMiners).toBe(false);
  });
});

describe('MinerBoards.refresh', () => {
  let dir;
  let env;
  let reg;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minerboards-'));
    for (const d of ['stats', 'dev', 'sys']) fs.mkdirSync(path.join(dir, d));
    fs.writeFileSync(path.join(dir, 'release'), 'BOARD_NAME="Solo Node"\n');
    env = {
      APOLLO_MINER_STATS_DIR: path.join(dir, 'stats'),
      APOLLO_USB_DEV_DIR: path.join(dir, 'dev'),
      APOLLO_USB_SYS_DIR: path.join(dir, 'sys'),
      ARMBIAN_RELEASE_FILE: path.join(dir, 'release'),
    };
    reg = new MinerBoards({ env, logger: { warn() {}, debug() {}, info() {}, error() {} } });
  });
  afterEach(() => {
    reg.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const plug = (product = 'BCO SLV #1') => {
    // sysfs layout: <sys>/ttyACM0/device is the interface, serial/product on its parent
    const usbdev = path.join(dir, 'sys', 'usbdev');
    fs.mkdirSync(path.join(usbdev, 'if0'), { recursive: true });
    fs.writeFileSync(path.join(usbdev, 'serial'), `${SERIAL}\n`);
    fs.writeFileSync(path.join(usbdev, 'product'), `${product}\n`);
    fs.writeFileSync(path.join(usbdev, 'idVendor'), '0483\n');
    fs.writeFileSync(path.join(usbdev, 'idProduct'), '5740\n');
    fs.mkdirSync(path.join(dir, 'sys', 'ttyACM0'));
    fs.symlinkSync(path.join(usbdev, 'if0'), path.join(dir, 'sys', 'ttyACM0', 'device'));
    fs.writeFileSync(path.join(dir, 'dev', 'ttyACM0'), '');
  };
  const writeStat = (now) => {
    const f = path.join(dir, 'stats', `apollo-miner-v2.${SERIAL}`);
    fs.writeFileSync(f, JSON.stringify({ comport: '/dev/ttyACM0' }));
    fs.utimesSync(f, new Date(now), new Date(now));
  };

  test('reads serial from the USB parent and the stat file; unchanged reading returns false', async () => {
    const now = Date.now();
    plug();
    writeStat(now);
    expect(await reg.refresh({ now })).toBe(true);
    expect(reg.snapshot().boards[0]).toMatchObject({ id: SERIAL, serial: SERIAL, family: 'v2', kind: 'usb', mining: true, status: 'active' });
    expect(reg.snapshot()).toMatchObject({ hasMiner: true, deviceFamily: 'solo-node', usbCount: 1 });
    expect(await reg.refresh({ now: now + 1000 })).toBe(false);
    expect(await reg.refresh({ now: now + 2000 })).toBe(false);
  });

  test('a ttyACM with another vendor/product id (Zigbee stick, Arduino) is not a miner', async () => {
    const now = Date.now();
    plug();
    writeStat(now);
    const other = path.join(dir, 'sys', 'otherdev');
    fs.mkdirSync(path.join(other, 'if0'), { recursive: true });
    fs.writeFileSync(path.join(other, 'serial'), 'ZB-1\n');
    fs.writeFileSync(path.join(other, 'idVendor'), '10c4\n');
    fs.writeFileSync(path.join(other, 'idProduct'), 'ea60\n');
    fs.mkdirSync(path.join(dir, 'sys', 'ttyACM1'));
    fs.symlinkSync(path.join(other, 'if0'), path.join(dir, 'sys', 'ttyACM1', 'device'));
    fs.writeFileSync(path.join(dir, 'dev', 'ttyACM1'), '');
    await reg.refresh({ now });
    expect(reg.snapshot().boards.map((b) => b.id)).toEqual([SERIAL]);
    expect(reg.snapshot().usbCount).toBe(1);
  });

  test('only a non-miner ACM on the Solo Node: no board, no miner', async () => {
    const other = path.join(dir, 'sys', 'otherdev');
    fs.mkdirSync(path.join(other, 'if0'), { recursive: true });
    fs.writeFileSync(path.join(other, 'idVendor'), '10c4\n');
    fs.writeFileSync(path.join(other, 'idProduct'), 'ea60\n');
    fs.mkdirSync(path.join(dir, 'sys', 'ttyACM0'));
    fs.symlinkSync(path.join(other, 'if0'), path.join(dir, 'sys', 'ttyACM0', 'device'));
    fs.writeFileSync(path.join(dir, 'dev', 'ttyACM0'), '');
    await reg.refresh();
    expect(reg.snapshot()).toMatchObject({ boards: [], usbCount: 0, hasMiner: false });
  });

  test('mining flip, unplug and expiry each report a change, then settle', async () => {
    const now = Date.now();
    plug();
    writeStat(now);
    const seen = [];
    reg.onChange((s) => seen.push(s.boards.map((b) => `${b.status}/${b.mining}`).join()));
    await reg.refresh({ now });
    expect(await reg.refresh({ now: now + 20000 })).toBe(true); // stat file went stale
    fs.rmSync(path.join(dir, 'dev', 'ttyACM0'));
    fs.rmSync(path.join(dir, 'sys', 'ttyACM0'), { recursive: true });
    expect(await reg.refresh({ now: now + 21000 })).toBe(false); // debouncing, still active
    expect(await reg.refresh({ now: now + 27000 })).toBe(true); // disconnected
    expect(await reg.refresh({ now: now + 28000 })).toBe(false);
    expect(await reg.refresh({ now: now + 21000 + EXPIRY_MS + 1 })).toBe(true); // dropped
    expect(reg.snapshot().usbCount).toBe(0);
    expect(seen).toEqual(['active/true', 'active/false', 'disconnected/false', '']);
  });

  test('a board stuck in IAP is published by its own timer, with no other event', () => {
    jest.useFakeTimers({ now: Date.now() });
    try {
      plug(`BCO IAP #${SERIAL}`);
      const seen = [];
      reg.onChange((s) => seen.push(s.boards.map((b) => b.status).join()));
      reg.start();
      expect(seen).toEqual(['booting']);
      jest.advanceTimersByTime(STUCK_MS - 1000);
      expect(seen).toEqual(['booting']);
      jest.advanceTimersByTime(2000);
      expect(seen).toEqual(['booting', 'stuck']);
      expect(reg.snapshot()).toMatchObject({ usbCount: 1, usbActiveCount: 0, hasUsbMiners: true });
    } finally {
      reg.stop();
      jest.useRealTimers();
    }
  });

  test('empty machine: no boards, settles, tolerant of missing dirs', async () => {
    fs.rmSync(path.join(dir, 'stats'), { recursive: true });
    fs.rmSync(path.join(dir, 'sys'), { recursive: true });
    expect(await reg.refresh()).toBe(true); // first reading learns the family
    expect(await reg.refresh()).toBe(false);
    expect(reg.snapshot()).toMatchObject({ boards: [], hasMiner: false, usbCount: 0 });
  });

  test('start() tolerates a device dir that cannot be watched, stop() is idempotent', () => {
    fs.rmSync(path.join(dir, 'dev'), { recursive: true });
    expect(() => reg.start()).not.toThrow();
    reg.stop();
    reg.stop();
  });
});

describe('deriveBoards booting / stuck', () => {
  const iap = (over = {}) => port({ product: `BCO IAP #${SERIAL}`, ...over });
  const slv = (over = {}) => port({ product: `BCO SLV #${SERIAL}`, ...over });
  const step = (prev, at, args) => run({ ...args, memory: prev.memory, now: T0 + at });

  test('IAP only, no stat file: booting, counted as attached but not active', () => {
    const res = run({ ports: [iap()] });
    expect(res.boards).toHaveLength(1);
    expect(res.boards[0]).toMatchObject({ status: 'booting', since: new Date(T0).toISOString() });
    const snap = require('../src/minerBoards').buildSnapshot(res.boards, 'solo-node');
    expect(snap).toMatchObject({ hasUsbMiners: true, hasMiner: true, usbCount: 1, usbActiveCount: 0 });
  });

  test('IAP -> SLV: active with the same id, no disconnected in between', () => {
    const r0 = run({ statEntries: [usbEntry()], ports: [iap()] });
    expect(byId(r0, SERIAL).status).toBe('booting');
    // the gap between the two enumerations: nothing listed for a moment
    const r1 = step(r0, 30000, { statEntries: [usbEntry()], ports: [] });
    expect(byId(r1, SERIAL).status).toBe('booting');
    const r2 = step(r1, 30300, { statEntries: [usbEntry()], ports: [slv()] });
    expect(r2.boards).toHaveLength(1);
    expect(byId(r2, SERIAL).status).toBe('active');
  });

  test('IAP and SLV listed together: SLV wins', () => {
    const res = run({ ports: [iap({ name: 'ttyACM0' }), slv({ name: 'ttyACM1' })] });
    expect(res.boards).toHaveLength(1);
    expect(res.boards[0]).toMatchObject({ status: 'active', port: '/dev/ttyACM1' });
  });

  test('IAP for more than 2 minutes: stuck, and the timer is scheduled at the boundary', () => {
    const r0 = run({ ports: [iap()] });
    expect(r0.nextExpiryAt).toBe(new Date(T0 + STUCK_MS).toISOString());
    const before = step(r0, STUCK_MS - 1, { ports: [iap()] });
    expect(byId(before, SERIAL).status).toBe('booting');
    const after = step(r0, STUCK_MS, { ports: [iap()] });
    // booting keeps the IAP start; stuck is "since" the moment it became stuck
    expect(byId(before, SERIAL).since).toBe(new Date(T0).toISOString());
    expect(byId(after, SERIAL)).toMatchObject({ status: 'stuck', since: new Date(T0 + STUCK_MS).toISOString() });
    expect(after.nextExpiryAt).toBeNull();
  });

  test('stuck -> SLV: active again', () => {
    const r0 = run({ ports: [iap()] });
    const r1 = step(r0, STUCK_MS + 5000, { ports: [iap()] });
    expect(byId(r1, SERIAL).status).toBe('stuck');
    expect(byId(step(r1, STUCK_MS + 6000, { ports: [slv()] }), SERIAL).status).toBe('active');
  });

  test('the 2 minutes count from the IAP start, also across a stop (SLV -> IAP) cycle', () => {
    const r0 = run({ ports: [slv()] });
    const r1 = step(r0, 60000, { ports: [iap()] });
    expect(byId(r1, SERIAL)).toMatchObject({ status: 'booting', since: new Date(T0 + 60000).toISOString() });
    expect(byId(step(r1, 60000 + STUCK_MS - 1, { ports: [iap()] }), SERIAL).status).toBe('booting');
  });

  test('unplug while booting / stuck: disconnected after the debounce, then forgotten', () => {
    for (const idle of [1000, STUCK_MS + 1000]) {
      const r0 = run({ ports: [iap()] });
      const r1 = step(r0, idle, { ports: [iap()] });
      const r2 = step(r1, idle + 1000, { ports: [] });
      expect(['booting', 'stuck']).toContain(byId(r2, SERIAL).status);
      const r3 = step(r2, idle + 1000 + DEBOUNCE_MS, { ports: [] });
      expect(byId(r3, SERIAL)).toMatchObject({ status: 'disconnected' });
      // replugged later as IAP: the 2 minutes start again
      const r4 = step(r3, idle + 60000, { ports: [iap()] });
      expect(byId(r4, SERIAL)).toMatchObject({ status: 'booting' });
      const r5 = step(r3, idle + 1000 + DEBOUNCE_MS + EXPIRY_MS, { ports: [] });
      expect(r5.boards).toEqual([]);
    }
  });
});

describe('deriveBoards IAP start survives an API restart', () => {
  const iapAt = (enumeratedAtMs) => port({ product: `BCO IAP #${SERIAL}`, enumeratedAtMs });
  const slv = (over = {}) => port({ product: `BCO SLV #${SERIAL}`, ...over });
  const step = (prev, at, args) => run({ ...args, memory: prev.memory, now: T0 + at });

  test('empty memory: the count starts at the enumeration, not at now', () => {
    const res = run({ ports: [iapAt(T0 - 30000)] });
    expect(byId(res, SERIAL)).toMatchObject({ status: 'booting', since: new Date(T0 - 30000).toISOString() });
    expect(res.nextExpiryAt).toBe(new Date(T0 - 30000 + STUCK_MS).toISOString());
  });

  test('empty memory, enumerated more than 2 minutes ago: stuck at once, since = the stuck instant', () => {
    const res = run({ ports: [iapAt(T0 - 3 * 60000)] });
    expect(byId(res, SERIAL)).toMatchObject({
      status: 'stuck',
      since: new Date(T0 - 3 * 60000 + STUCK_MS).toISOString(),
    });
  });

  test('a restart mid-IAP keeps the original anchor of the previous run', () => {
    const before = run({ ports: [iapAt(T0 - 60000)] });
    const afterRestart = run({ ports: [iapAt(T0 - 60000)], now: T0 + 20000 }); // memory lost
    expect(byId(afterRestart, SERIAL).since).toBe(byId(before, SERIAL).since);
    expect(byId(afterRestart, SERIAL).status).toBe('booting');
  });

  test('a restart never turns a stuck board back into booting', () => {
    const live = run({ ports: [iapAt(T0)] });
    const stuck = step(live, STUCK_MS + 5000, { ports: [iapAt(T0)] });
    expect(byId(stuck, SERIAL).status).toBe('stuck');
    const restarted = run({ ports: [iapAt(T0)], now: T0 + STUCK_MS + 6000 }); // empty memory
    expect(byId(restarted, SERIAL).status).toBe('stuck');
    expect(byId(restarted, SERIAL).since).toBe(byId(stuck, SERIAL).since);
  });

  test('unreadable or future ctime: falls back to / is clamped to now', () => {
    expect(byId(run({ ports: [iapAt(null)] }), SERIAL).since).toBe(new Date(T0).toISOString());
    expect(byId(run({ ports: [iapAt(undefined)] }), SERIAL).since).toBe(new Date(T0).toISOString());
    expect(byId(run({ ports: [iapAt(T0 + 99999)] }), SERIAL).since).toBe(new Date(T0).toISOString());
  });

  test('with memory the anchor is the remembered one, whatever the ctime says', () => {
    const r0 = run({ ports: [iapAt(T0)] });
    const r1 = step(r0, 10000, { ports: [iapAt(T0 + 10000)] });
    expect(byId(r1, SERIAL).since).toBe(new Date(T0).toISOString());
  });
});

describe('deriveBoards since of a board that left the bootloader', () => {
  const iap = (over = {}) => port({ product: `BCO IAP #${SERIAL}`, ...over });
  const slv = (over = {}) => port({ product: `BCO SLV #${SERIAL}`, ...over });
  const step = (prev, at, args) => run({ ...args, memory: prev.memory, now: T0 + at });

  test('booting -> SLV: since is the moment it came up, not the IAP start', () => {
    const r0 = run({ ports: [iap()] });
    const r1 = step(r0, 30000, { ports: [slv()] });
    expect(byId(r1, SERIAL)).toMatchObject({ status: 'active', since: new Date(T0 + 30000).toISOString() });
    // and it stays put while the board keeps mining
    expect(byId(step(r1, 40000, { ports: [slv()] }), SERIAL).since).toBe(new Date(T0 + 30000).toISOString());
  });

  test('booting -> gap -> SLV inside the debounce: since is the SLV moment', () => {
    const r0 = run({ ports: [iap()] });
    const r1 = step(r0, 30000, { ports: [] });
    const r2 = step(r1, 31000, { ports: [slv()] });
    expect(byId(r2, SERIAL)).toMatchObject({ status: 'active', since: new Date(T0 + 31000).toISOString() });
  });

  test('stuck -> SLV: since is the moment it came up', () => {
    const r0 = run({ ports: [iap()] });
    const r1 = step(r0, STUCK_MS + 5000, { ports: [iap()] });
    const r2 = step(r1, STUCK_MS + 6000, { ports: [slv()] });
    expect(byId(r2, SERIAL)).toMatchObject({ status: 'active', since: new Date(T0 + STUCK_MS + 6000).toISOString() });
  });

  test('a replug flap of an active board keeps its since (no IAP involved)', () => {
    const r0 = run({ ports: [slv()] });
    const r1 = step(r0, 1000, { ports: [] });
    const r2 = step(r1, 2000, { ports: [slv()] });
    expect(byId(r2, SERIAL).since).toBe(new Date(T0).toISOString());
  });
});

describe('deriveBoards serial-less IAP port, then SLV with a serial', () => {
  const iapNoSerial = () => port({ serial: null, product: 'BCO IAP #' });
  const slv = (over = {}) => port({ product: `BCO SLV #${SERIAL}`, ...over });
  const step = (prev, at, args) => run({ ...args, memory: prev.memory, now: T0 + at });

  test('the serial-less entry is absorbed: one board, no ghost', () => {
    const r0 = run({ ports: [iapNoSerial()] });
    expect(r0.boards.map((b) => b.id)).toEqual(['port:ttyACM0']);
    const r1 = step(r0, 30000, { ports: [slv()] });
    expect(r1.boards.map((b) => b.id)).toEqual([SERIAL]);
    expect(byId(r1, SERIAL)).toMatchObject({ status: 'active', serial: SERIAL });
    expect(Object.keys(r1.memory)).toEqual([SERIAL]);
  });

  test('absorbed across the gap between the two enumerations too', () => {
    const r0 = run({ ports: [iapNoSerial()] });
    const r1 = step(r0, 30000, { ports: [] });
    const r2 = step(r1, 31000, { ports: [slv()] });
    expect(r2.boards.map((b) => b.id)).toEqual([SERIAL]);
  });

  test('the booting clock carries over to the board that absorbed it', () => {
    const r0 = run({ ports: [iapNoSerial()] });
    const r1 = step(r0, 10000, { ports: [port({ product: `BCO IAP #${SERIAL}` })] });
    expect(byId(r1, SERIAL)).toMatchObject({ status: 'booting', since: new Date(T0).toISOString() });
  });

  test('not absorbed once the debounce has passed: it is a disconnected board', () => {
    const r0 = run({ ports: [iapNoSerial()] });
    const r1 = step(r0, 1000, { ports: [] });
    const r2 = step(r1, 1000 + DEBOUNCE_MS, { ports: [slv()] });
    expect(r2.boards.map((b) => b.id).sort()).toEqual([SERIAL, 'port:ttyACM0'].sort());
  });

  test('a serial-less entry on another port is left alone', () => {
    const r0 = run({ ports: [iapNoSerial()] });
    const r1 = step(r0, 1000, { ports: [iapNoSerial(), slv({ name: 'ttyACM1' })] });
    expect(r1.boards.map((b) => b.id).sort()).toEqual([SERIAL, 'port:ttyACM0'].sort());
  });
});

describe('MinerBoards after an API restart', () => {
  let dir;
  const quiet = { warn() {}, debug() {}, info() {}, error() {} };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boards-restart-'));
    for (const d of ['stats', 'dev', 'sys']) fs.mkdirSync(path.join(dir, d));
    const usbdev = path.join(dir, 'sys', 'usbdev');
    fs.mkdirSync(path.join(usbdev, 'if0'), { recursive: true });
    fs.writeFileSync(path.join(usbdev, 'serial'), `${SERIAL}\n`);
    fs.writeFileSync(path.join(usbdev, 'product'), `BCO IAP #${SERIAL}\n`);
    fs.writeFileSync(path.join(usbdev, 'idVendor'), '0483\n');
    fs.writeFileSync(path.join(usbdev, 'idProduct'), '5740\n');
    fs.mkdirSync(path.join(dir, 'sys', 'ttyACM0'));
    fs.symlinkSync(path.join(usbdev, 'if0'), path.join(dir, 'sys', 'ttyACM0', 'device'));
    fs.writeFileSync(path.join(dir, 'dev', 'ttyACM0'), '');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const make = (enumeratedAt) =>
    new MinerBoards({
      env: {
        APOLLO_MINER_STATS_DIR: path.join(dir, 'stats'),
        APOLLO_USB_DEV_DIR: path.join(dir, 'dev'),
        APOLLO_USB_SYS_DIR: path.join(dir, 'sys'),
        ARMBIAN_RELEASE_FILE: path.join(dir, 'release'),
      },
      logger: quiet,
      enumeratedAt,
    });

  test('the first snapshot of a new process is stuck when the board enumerated long ago, and never booting', () => {
    const now = Date.now();
    const enumerated = now - 5 * 60000;
    const first = make(() => enumerated);
    first.refreshSync({ now: enumerated + 1000 });
    first.refreshSync({ now: enumerated + STUCK_MS + 1000 });
    expect(first.snapshot().boards[0].status).toBe('stuck');

    const restarted = make(() => enumerated); // memory lost
    const seen = [];
    restarted.onChange((s) => seen.push(s.boards.map((b) => b.status).join()));
    restarted.refreshSync({ now });
    restarted.refreshSync({ now: now + 1000 });
    restarted.refreshSync({ now: now + 60000 });
    expect(restarted.snapshot().boards[0].status).toBe('stuck');
    expect(seen).toEqual(['stuck']);
    expect(restarted.snapshot().boards[0].since).toBe(new Date(enumerated + STUCK_MS).toISOString());
  });

  test('the default source is the ctime of the device node', () => {
    const reg = make(null);
    const ctime = fs.statSync(path.join(dir, 'dev', 'ttyACM0')).ctimeMs;
    expect(reg._enumeratedAt(path.join(dir, 'dev'), 'ttyACM0')).toBe(ctime);
    expect(reg._enumeratedAt(path.join(dir, 'dev'), 'ttyACM9')).toBeNull();
  });
});
