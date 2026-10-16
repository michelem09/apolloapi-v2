// A ckpool that crashes on start sits in `activating (auto-restart)` under
// Restart=on-failure and never reaches `failed`. Past the start grace window the
// monitor must call that an error, and go back to normal once it is up.

const { knex } = require('../src/db');
const monitorFactory = require('../src/services/serviceMonitor');

const mockWarn = jest.fn();
jest.mock('../src/logger', () => () => ({
  warn: (...a) => mockWarn(...a),
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
}));
const stuckWarnings = () => mockWarn.mock.calls.filter((c) => /stuck in auto-restart/.test(c[1]));

let publishSpy;
beforeAll(() => {
  publishSpy = jest.spyOn(require('../src/graphql/pubsub'), 'publish').mockImplementation(() => {});
});
afterAll(() => publishSpy?.mockRestore());

jest.mock('child_process', () => ({
  exec: (cmd, cb) => {
    if (typeof cb !== 'function') return;
    if (/systemctl show/.test(cmd)) return cb(null, { stdout: `${global.__sub}\n`, stderr: '' });
    if (!/is-active/.test(cmd)) return cb(null, { stdout: '', stderr: '' });
    const value = global.__systemd;
    if (value === 'active') return cb(null, { stdout: 'active\n', stderr: '' });
    const err = new Error(value);
    err.code = value === 'inactive' ? 3 : 1;
    err.stdout = value;
    return cb(err, { stdout: value, stderr: '' });
  },
}));

const setSolo = async (row) => {
  await knex('service_status').where({ service_name: 'solo' }).del();
  await knex('service_status').insert({ service_name: 'solo', ...row });
};
const readSolo = () => knex('service_status').where({ service_name: 'solo' }).first();

describe('ckpool in activating (auto-restart)', () => {
  let monitor;
  let now;
  beforeEach(() => {
    mockWarn.mockClear();
    global.__systemd = 'activating';
    global.__sub = 'auto-restart';
    monitor = monitorFactory(knex, {});
    now = 1_000_000_000_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);
  });
  afterEach(() => jest.restoreAllMocks());

  // 2nd argument is updateInProgress, compared `=== false`: anything else skips
  // the grace / manual-stop block these tests are about.
  const poll = () => monitor.checkServiceStatus('ckpool', false);
  // Past the grace window of the request that started it all.
  const settled = () => setSolo({ status: 'pending', requested_status: 'online', requested_at: now - 200000 });

  it('stays pending at first, becomes error after 90 s of it', async () => {
    await settled();
    await poll();
    expect((await readSolo()).status).toBe('pending');
    now += 60000;
    await poll();
    expect((await readSolo()).status).toBe('pending');
    now += 31000;
    await poll();
    expect((await readSolo()).status).toBe('error');
  });

  it('goes back to online when it comes up, and the clock starts over after', async () => {
    await settled();
    await poll();
    now += 100000;
    await poll();
    expect((await readSolo()).status).toBe('error');
    global.__systemd = 'active';
    await poll();
    expect((await readSolo()).status).toBe('online');
    global.__systemd = 'activating';
    now += 1000;
    await poll();
    expect((await readSolo()).status).not.toBe('error');
  });

  it('plain `activating` (a slow start, not a restart loop) is never an error', async () => {
    global.__sub = 'start';
    await settled();
    await poll();
    now += 200000;
    await poll();
    expect((await readSolo()).status).toBe('pending');
  });

  it('is left alone while a request is still inside its grace window', async () => {
    // The loop has been running for 100 s (the clock is well past the error
    // threshold) when a fresh request arrives: its grace window wins. The final
    // status is `pending` either way (the grace branch overrides), so what the
    // `!isWithinGracePeriod` guard really decides is whether the error is
    // declared: the warning is the observable.
    await settled();
    await poll();
    now += 100000;
    await poll();
    expect((await readSolo()).status).toBe('error');
    expect(stuckWarnings()).toHaveLength(1);
    await setSolo({ status: 'pending', requested_status: 'online', requested_at: now - 1000 });
    mockWarn.mockClear();
    await poll();
    expect((await readSolo()).status).toBe('pending');
    expect(stuckWarnings()).toHaveLength(0);
  });

  it('warns once on entering error, not on every poll, and again after a recovery', async () => {
    await settled();
    await poll();
    now += 100000;
    for (let i = 0; i < 5; i += 1) {
      await poll();
      now += 10000;
    }
    expect((await readSolo()).status).toBe('error');
    expect(stuckWarnings()).toHaveLength(1);
    global.__systemd = 'active';
    await poll();
    global.__systemd = 'activating';
    await poll();
    now += 100000;
    await poll();
    expect((await readSolo()).status).toBe('error');
    expect(stuckWarnings()).toHaveLength(2);
  });

  it('a poll landing in `activating (start)` between retries neither resets the clock nor flaps', async () => {
    await settled();
    await poll(); // clock starts
    now += 60000;
    global.__sub = 'start'; // a retry in flight
    await poll();
    expect((await readSolo()).status).toBe('pending');
    now += 31000; // 91 s since the loop began
    await poll(); // still in `start`: same run, so error
    expect((await readSolo()).status).toBe('error');
    global.__sub = 'auto-restart';
    await poll();
    expect((await readSolo()).status).toBe('error');
    global.__sub = 'start';
    now += 1000;
    await poll();
    expect((await readSolo()).status).toBe('error');
  });

  it('a failed unit ends the run: the next loop starts a new clock', async () => {
    await settled();
    await poll();
    now += 100000;
    global.__systemd = 'failed';
    await poll();
    global.__systemd = 'activating';
    await poll();
    expect((await readSolo()).status).not.toBe('error');
  });
});
