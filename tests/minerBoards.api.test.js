// API side of the board registry: resolver, stat filtering, time-series
// exclusion, and the Solo Node offline rule in the service monitor.
const { knex } = require('../src/db');
const fs = require('fs');

const mockRegistry = {
  started: true,
  snap: { boards: [], hasMiner: true, hasUsbMiners: false, usbCount: 0, usbActiveCount: 0, deviceFamily: 'solo-node' },
  snapshot() { return this.snap; },
  refreshSync: jest.fn(),
  refresh: jest.fn().mockResolvedValue(false),
};
jest.mock('../src/minerBoards', () => ({ getMinerBoards: () => mockRegistry }));

jest.mock('child_process', () => ({
  exec: (cmd, cb) => {
    if (typeof cb !== 'function') return;
    if (!/is-active/.test(cmd)) return cb(null, { stdout: '', stderr: '' });
    cb(null, { stdout: `${global.__systemd || 'active'}\n`, stderr: '' });
  },
}));

const board = (id, status = 'active', kind = 'usb') => ({
  id, uuid: id, serial: id, family: 'v2', kind, port: '/dev/ttyACM0',
  status, mining: status === 'active', since: null, lastSeen: null, expiresAt: null,
});
const snapOf = (boards, family = 'solo-node') => ({
  boards,
  hasMiner: true,
  hasUsbMiners: boards.length > 0,
  usbCount: boards.length,
  usbActiveCount: boards.filter((b) => b.status === 'active').length,
  deviceFamily: family,
});

describe('Miner.boards resolver', () => {
  const resolver = require('../src/graphql/resolvers/miner');

  it('returns the registry snapshot as result', async () => {
    mockRegistry.snap = snapOf([board('AAA')]);
    const minerService = require('../src/services/miner')(knex, {});
    const out = await resolver.MinerActions.boards(null, {}, { services: { miner: minerService } });
    expect(out).toEqual({ result: mockRegistry.snap, error: null });
    expect(mockRegistry.refresh).toHaveBeenCalled();
  });

  it('flattens a failure into the payload', async () => {
    const out = await resolver.MinerActions.boards(null, {}, {
      services: { miner: { getBoards: jest.fn().mockRejectedValue(new Error('nope')) } },
    });
    expect(out).toEqual({ result: null, error: { message: 'nope' } });
  });
});

describe('_getMinerStats drops boards the registry forgot', () => {
  const statJson = JSON.stringify({
    date: '2026-07-28 12:00:00', statVersion: '1.3',
    master: { intervals: {} }, pool: { intervals: {} }, fans: {}, slots: {}, slaves: [],
  });

  beforeEach(() => {
    fs.promises.readdir.mockResolvedValueOnce(['apollo-miner-v2.AAA', 'apollo-miner-v2.GONE']);
    fs.promises.access.mockRejectedValue(Object.assign(new Error('x'), { code: 'ENOENT' }));
    fs.promises.readFile.mockResolvedValue(Buffer.from(statJson));
  });

  it('keeps listed boards (also disconnected ones) and drops the unlisted', async () => {
    mockRegistry.started = true;
    mockRegistry.snap = snapOf([board('AAA', 'disconnected')]);
    const svc = require('../src/services/miner')(knex, {});
    const stats = await svc._getMinerStats({}, []);
    expect(stats.map((s) => s.uuid)).toEqual(['AAA']);
  });

  it('does not filter while the registry has not started', async () => {
    mockRegistry.started = false;
    mockRegistry.snap = snapOf([]);
    const svc = require('../src/services/miner')(knex, {});
    const stats = await svc._getMinerStats({}, []);
    expect(stats.map((s) => s.uuid).sort()).toEqual(['AAA', 'GONE']);
    mockRegistry.started = true;
  });
});

describe('fetchStatistics skips boards that are not active', () => {
  it('leaves them out of the inserted rows and totals', async () => {
    jest.resetModules();
    jest.unmock('../src/app/scheduler');
    const inserted = [];
    const mk = (uuid, gh) => ({
      uuid,
      master: { boardsI: 1, boardsW: 10, intervals: { int_3600: { chipSpeed: 1 }, int_30: { bySol: gh, byPool: gh } } },
      slots: { int_0: { temperature: 50, errorRate: 0 } },
      pool: { intervals: { int_0: { sharesRejected: 0, sharesAccepted: 1, sharesSent: 1 } } },
      fans: { int_0: { rpm: [1000] } },
    });
    jest.doMock('../src/services', () => ({
      miner: { getStats: jest.fn().mockResolvedValue({ stats: [mk('LIVE', 100), mk('DEAD', 900), mk('BOOT', 700), mk('STUCK', 800)] }) },
      serviceMonitor: null,
    }));
    const fakeKnex = jest.fn((table) => {
      const q = {
        select: () => q, where: () => q, whereIn: () => q, del: async () => 0,
        first: async () => ({ status: 'online' }),
        insert: async (rows) => { inserted.push(...[].concat(rows)); },
      };
      return q;
    });
    fakeKnex.raw = (q) => q;
    fakeKnex.transaction = async (fn) => fn(fakeKnex);
    jest.doMock('../src/db', () => ({ knex: fakeKnex }));
    mockRegistry.snap = snapOf([board('LIVE'), board('DEAD', 'disconnected'), board('BOOT', 'booting'), board('STUCK', 'stuck')]);
    const scheduler = require('../src/app/scheduler');
    await scheduler.fetchStatistics();
    const rows = inserted.filter((r) => r && r.uuid);
    expect(rows.map((r) => r.uuid).sort()).toEqual(['LIVE', 'totals']);
    expect(rows.find((r) => r.uuid === 'totals').hashrateInGh).toBe(100);
  });
});

describe('service monitor: Solo Node with no board', () => {
  const monitorFactory = require('../src/services/serviceMonitor');
  let publishSpy;
  beforeAll(() => {
    publishSpy = jest.spyOn(require('../src/graphql/pubsub'), 'publish').mockImplementation(() => {});
  });
  afterAll(() => publishSpy.mockRestore());

  const readMiner = () => knex('service_status').where({ service_name: 'miner' }).first();
  const run = async (appStatus, row) => {
    await knex('service_status').where({ service_name: 'miner' }).update(row);
    const monitor = monitorFactory(knex, {
      miner: { checkOnline: async () => ({ online: { status: appStatus } }) },
    });
    return monitor.checkServiceStatus('apollo-miner');
  };

  beforeEach(() => {
    global.__systemd = 'active';
    delete process.env.NODE_ENV_DEV;
  });

  const idle = { status: 'offline', requested_status: null, requested_at: null };

  it('maps active unit + app offline to offline instead of pending', async () => {
    mockRegistry.snap = snapOf([]);
    const res = await run('offline', idle);
    expect(res.status).toBe('offline');
    expect((await readMiner()).status).toBe('offline');
  });

  it('a Start pressed with no board settles on offline, no restart issued', async () => {
    mockRegistry.snap = snapOf([]);
    const res = await run('offline', {
      status: 'pending', requested_status: 'online', requested_at: Date.now() - 2000,
    });
    expect(res.status).toBe('offline');
  });

  it('keeps a Stop in flight pending', async () => {
    mockRegistry.snap = snapOf([]);
    const res = await run('offline', {
      status: 'pending', requested_status: 'offline', requested_at: Date.now() - 2000,
    });
    expect(res.status).toBe('pending');
  });

  it('with an active board the old mapping holds (app offline -> pending)', async () => {
    mockRegistry.snap = snapOf([board('AAA')]);
    const res = await run('offline', idle);
    expect(res.status).toBe('pending');
  });

  it.each(['booting', 'stuck'])('a %s board is not an active one: still offline', async (st) => {
    mockRegistry.snap = snapOf([board('AAA', st)]);
    const res = await run('offline', idle);
    expect(res.status).toBe('offline');
  });

  it('only on a Solo Node (Apollo II keeps pending)', async () => {
    mockRegistry.snap = snapOf([], 'apollo-ii');
    const res = await run('offline', idle);
    expect(res.status).toBe('pending');
  });

  it('a fresh stat file (app online) wins', async () => {
    mockRegistry.snap = snapOf([]);
    const res = await run('online', idle);
    expect(res.status).toBe('online');
  });

  it('only when systemd is active (activating stays pending)', async () => {
    mockRegistry.snap = snapOf([]);
    global.__systemd = 'activating';
    const res = await run('offline', idle);
    expect(res.status).toBe('pending');
  });
});
