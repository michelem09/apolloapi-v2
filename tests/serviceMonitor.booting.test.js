// Solo Node: a board in its bootloader (IAP) is about to mine and Start is allowed
// meanwhile, so apollo-miner reads as pending (starting) while one is booting, and
// offline only when nothing is about to mine (no boards, stuck, disconnected).

const { knex } = require('../src/db');
const monitorFactory = require('../src/services/serviceMonitor');

jest.mock('child_process', () => ({
  exec: (cmd, cb) => {
    if (typeof cb !== 'function') return;
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
  it('booting + unit activating: pending', async () => {
    expect(await poll('activating', ['booting'])).toBe('pending');
  });
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
