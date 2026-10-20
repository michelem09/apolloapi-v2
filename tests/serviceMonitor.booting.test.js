// Solo Node: a board in its bootloader (IAP) is about to mine and Start is allowed
// meanwhile, so apollo-miner reads as pending (starting) while one is booting, and
// offline only when nothing is about to mine (no boards, stuck, disconnected).

const { knex } = require('../src/db');
const monitorFactory = require('../src/services/serviceMonitor');

jest.mock('child_process', () => ({
  exec: (cmd, cb) => {
    if (typeof cb !== 'function') return;
    if (/systemctl show/.test(cmd)) {
      return cb(null, { stdout: global.__show ? global.__show() : 'n/a', stderr: '' });
    }
    const value = global.__systemd;
    if (value === 'active') return cb(null, { stdout: 'active\n', stderr: '' });
    const err = new Error(value);
    err.code = value === 'inactive' ? 3 : 1;
    err.stdout = value;
    return cb(err, { stdout: value, stderr: '' });
  },
}));

jest.mock('../src/minerBoards', () => ({
  getMinerBoards: () => ({
    refresh: async () => {},
    snapshot: () => global.__snap,
  }),
}));

const snap = (statuses) => ({
  deviceFamily: 'solo-node',
  usbActiveCount: statuses.filter((s) => s === 'active').length,
  usbBootingCount: statuses.filter((s) => s === 'booting').length,
});
const readMiner = () => knex('service_status').where({ service_name: 'miner' }).first();

let publishSpy;
beforeAll(() => {
  publishSpy = jest.spyOn(require('../src/graphql/pubsub'), 'publish').mockImplementation(() => {});
});
afterAll(() => publishSpy?.mockRestore());

describe('apollo-miner on a Solo Node with a booting board', () => {
  let monitor;
  let online;
  beforeEach(async () => {
    online = 'offline';
    monitor = monitorFactory(knex, { miner: { checkOnline: async () => ({ online: { status: online } }) } });
    // Start pressed long ago: no grace window helps, the rule alone decides.
    await knex('service_status').where({ service_name: 'miner' }).del();
    await knex('service_status').insert({
      service_name: 'miner',
      status: 'pending',
      requested_status: 'online',
      requested_at: Date.now() - 600000,
    });
  });
  const poll = async (systemd, boards) => {
    global.__systemd = systemd;
    global.__snap = snap(boards);
    await monitor.checkServiceStatus('apollo-miner', false);
    return (await readMiner()).status;
  };

  it('booting + unit active: pending', async () => {
    expect(await poll('active', ['booting'])).toBe('pending');
  });
  // No "booting + unit activating" case on purpose: activating with the app offline
  // is pending through the generic path, rule or no rule, so such a test cannot fail
  // (checked by mutation: it stayed green with the booting rule removed). The rule
  // only changes the outcome for `active`, which the case above pins.
  it('booting + unit inactive: offline', async () => {
    expect(await poll('inactive', ['booting'])).toBe('offline');
  });
  it('stuck only + unit active: offline', async () => {
    expect(await poll('active', ['stuck'])).toBe('offline');
  });
  it('disconnected only + unit active: offline', async () => {
    expect(await poll('active', ['disconnected'])).toBe('offline');
  });
  it('no boards + unit active: offline', async () => {
    expect(await poll('active', [])).toBe('offline');
  });
  it('an active board takes the normal path (fresh stat file: online)', async () => {
    online = 'online';
    expect(await poll('active', ['active', 'booting'])).toBe('online');
  });
  it('a fresh stat file wins over a booting board', async () => {
    online = 'online';
    expect(await poll('active', ['booting'])).toBe('online');
  });
  it('stays pending through a long boot, then offline once stuck (no timer of its own)', async () => {
    for (let i = 0; i < 3; i++) expect(await poll('active', ['booting'])).toBe('pending');
    expect(await poll('active', ['stuck'])).toBe('offline');
  });
});

// Item 2: boards active but not mining (never started) must not leave pending forever.
describe('apollo-miner on a Solo Node with active boards that are not mining', () => {
  let monitor;
  let online;
  let enterMonoUs;
  let uptimeSpy;
  let mono; // the monitor's monotonic clock (performance.now), ms
  const NOW = 1_000_000 * 1000;
  beforeEach(async () => {
    online = 'offline';
    mono = 5000;
    jest.spyOn(require('perf_hooks').performance, 'now').mockImplementation(() => mono);
    uptimeSpy = jest.spyOn(require('os'), 'uptime').mockReturnValue(100000); // s
    jest.spyOn(Date, 'now').mockReturnValue(NOW);
    monitor = monitorFactory(knex, { miner: { checkOnline: async () => ({ online: { status: online } }) } });
    await knex('service_status').where({ service_name: 'miner' }).del();
    await knex('service_status').insert({
      service_name: 'miner', status: 'pending', requested_status: 'online', requested_at: NOW - 600000,
    });
    global.__show = () => String(enterMonoUs);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    delete global.__show;
  });
  // unit active for `unitS` s, board active (since) for `boardS` s, mining flag
  const poll = async ({ unitS, boardS, mining = false, extra = [] }) => {
    enterMonoUs = (100000 - unitS) * 1e6;
    global.__systemd = 'active';
    global.__snap = {
      deviceFamily: 'solo-node',
      usbActiveCount: 1 + extra.filter((b) => b.status === 'active').length,
      usbBootingCount: extra.filter((b) => b.status === 'booting').length,
      boards: [
        { kind: 'usb', status: 'active', mining, since: new Date(NOW - boardS * 1000).toISOString() },
        ...extra.map((b) => ({ kind: 'usb', mining: false, since: new Date(NOW).toISOString(), ...b })),
      ],
    };
    await monitor.checkServiceStatus('apollo-miner', false);
    return (await readMiner()).status;
  };

  it('a normal start (unit and board freshly up) stays pending', async () => {
    expect(await poll({ unitS: 25, boardS: 25 })).toBe('pending');
  });
  it('unit long up but the board only just came up: still pending (later clock anchors)', async () => {
    expect(await poll({ unitS: 3600, boardS: 20 })).toBe('pending');
  });
  it('board long up but the unit only just became active: still pending', async () => {
    expect(await poll({ unitS: 20, boardS: 3600 })).toBe('pending');
  });
  // The monitor must also have SEEN nothing mining for the window: the first tick
  // only starts the count.
  it('both past the window and nothing mining: offline once the monitor has seen it for 90 s', async () => {
    expect(await poll({ unitS: 120, boardS: 120 })).toBe('pending');
    mono += 91000;
    expect(await poll({ unitS: 211, boardS: 211 })).toBe('offline');
  });
  it('continuous not-mining under 90 s on the monitor clock stays pending', async () => {
    await poll({ unitS: 600, boardS: 600 });
    mono += 80000;
    expect(await poll({ unitS: 680, boardS: 680 })).toBe('pending');
  });
  it('a board that mined for an hour and has one stale tick stays pending, not offline', async () => {
    online = 'online';
    expect(await poll({ unitS: 3600, boardS: 3600, mining: true })).toBe('online');
    mono += 3600000;
    online = 'offline';
    expect(await poll({ unitS: 7200, boardS: 7200, mining: false })).toBe('pending');
    // ... and only continuous idleness past the window turns it offline
    mono += 91000;
    expect(await poll({ unitS: 7291, boardS: 7291, mining: false })).toBe('offline');
  });
  it('a mining tick in between restarts the count', async () => {
    await poll({ unitS: 600, boardS: 600 });
    mono += 80000;
    await poll({ unitS: 680, boardS: 680, mining: true });
    mono += 80000;
    expect(await poll({ unitS: 760, boardS: 760 })).toBe('pending');
  });
  it('an API restart (fresh monitor memory) is pending again up to 90 s', async () => {
    await poll({ unitS: 600, boardS: 600 });
    mono += 91000;
    expect(await poll({ unitS: 691, boardS: 691 })).toBe('offline');
    monitor = monitorFactory(knex, { miner: { checkOnline: async () => ({ online: { status: online } }) } });
    expect(await poll({ unitS: 700, boardS: 700 })).toBe('pending');
  });
  it('two idle boards with different since: the LATER one anchors (max, not min)', async () => {
    const young = { status: 'active', since: new Date(NOW - 20000).toISOString() };
    await poll({ unitS: 600, boardS: 600, extra: [young] });
    mono += 91000;
    expect(await poll({ unitS: 691, boardS: 691, extra: [young] })).toBe('pending');
  });
  it('a fresh stat file still wins: online', async () => {
    online = 'online';
    expect(await poll({ unitS: 600, boardS: 600, mining: true })).toBe('online');
  });
  it('a booting board next to an idle one keeps it pending', async () => {
    await poll({ unitS: 600, boardS: 600, extra: [{ status: 'booting' }] });
    mono += 91000;
    expect(await poll({ unitS: 691, boardS: 691, extra: [{ status: 'booting' }] })).toBe('pending');
  });
  it('unknown unit clock: the rule stays off (pending)', async () => {
    global.__show = () => 'n/a';
    enterMonoUs = 0;
    global.__systemd = 'active';
    global.__snap = {
      deviceFamily: 'solo-node', usbActiveCount: 1, usbBootingCount: 0,
      boards: [{ kind: 'usb', status: 'active', mining: false, since: new Date(NOW - 600000).toISOString() }],
    };
    await monitor.checkServiceStatus('apollo-miner', false);
    expect((await readMiner()).status).toBe('pending');
  });
});
