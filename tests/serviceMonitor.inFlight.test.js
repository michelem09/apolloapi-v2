// tests/serviceMonitor.inFlight.test.js
//
// A service the user has just started or stopped is in flight. Until it lands,
// or until the grace window runs out, the monitor must not write a terminal
// status over it — whatever systemd happens to report in the meantime.
//
// This is the "sync mess" seen from the UI: press Start, and two seconds later
// the panel says the pool is off, because one poll caught the unit in a state
// none of the specific branches expected and wrote it straight through.

const { knex } = require('../src/db');

const monitorFactory = require('../src/services/serviceMonitor');

let publishSpy;
beforeAll(() => {
  const pubsub = require('../src/graphql/pubsub');
  publishSpy = jest.spyOn(pubsub, 'publish').mockImplementation(() => {});
});
afterAll(() => publishSpy?.mockRestore());

// The decision under test reads systemd, so drive `systemctl is-active` from here.
jest.mock('child_process', () => ({
  exec: (cmd, cb) => {
    if (typeof cb !== 'function') return;
    if (!/is-active/.test(cmd)) return cb(null, { stdout: '', stderr: '' });
    const value = global.__systemd || 'inactive';
    if (value === 'active') return cb(null, { stdout: 'active\n', stderr: '' });
    const err = new Error(value);
    err.code = value === 'failed' ? 4 : value === 'inactive' ? 3 : 1;
    err.stdout = value;
    return cb(err, { stdout: value, stderr: '' });
  },
}));

const setSolo = async (row) => {
  await knex('service_status').where({ service_name: 'solo' }).del();
  await knex('service_status').insert({ service_name: 'solo', ...row });
};

const readSolo = () =>
  knex('service_status').where({ service_name: 'solo' }).first();

const run = async ({ autoStart = true } = {}) => {
  const monitor = monitorFactory(knex, {});
  monitor.config = { ...monitor.config, autoStart };
  return monitor.checkServiceStatus('ckpool', 'solo');
};

// Milliseconds, as the services write them — a Date lands in this column as
// the string "[object Object]".
const secondsAgo = (s) => Date.now() - s * 1000;

describe('a service in flight', () => {
  beforeEach(() => {
    global.__systemd = 'inactive';
  });

  // The exact shape that produced the flash: ckpool has been asked to start and
  // has not got there yet. `failed` is deliberately not in this list — see
  // below.
  it.each(['deactivating', 'unknown'])(
    'is left pending while systemd reports %s',
    async (reading) => {
      global.__systemd = reading;
      await setSolo({
        status: 'pending',
        requested_status: 'online',
        requested_at: secondsAgo(2),
      });

      await run();

      expect((await readSolo()).status).toBe('pending');
    }
  );

  // A unit that failed has answered. Protecting that reading would hide the
  // only signal a misconfigured service gives — ckpool with a bad pool address
  // fails in under a second, and the user would watch a spinner for a minute
  // and a half instead of being told.
  it('does not hold a start that has already failed', async () => {
    global.__systemd = 'failed';
    await setSolo({
      status: 'pending',
      requested_status: 'online',
      requested_at: secondsAgo(1),
    });

    // With auto-restart on, `failed` genuinely does mean "restarting", and
    // pending is the honest answer. This is the other case: nothing is going to
    // pick it up, so the user has to be told.
    await run({ autoStart: false });

    expect((await readSolo()).status).not.toBe('pending');
  });

  // Being quicker matters as much as being quieter: the moment the unit is up
  // there is nothing left to protect.
  it('settles as soon as the unit is actually up', async () => {
    global.__systemd = 'active';
    await setSolo({
      status: 'pending',
      requested_status: 'online',
      requested_at: secondsAgo(2),
    });

    await run();

    expect((await readSolo()).status).toBe('online');
  });

  it('settles as soon as a stop has actually taken effect', async () => {
    global.__systemd = 'inactive';
    await setSolo({
      status: 'pending',
      requested_status: 'offline',
      requested_at: secondsAgo(2),
    });

    await run();

    expect((await readSolo()).status).toBe('offline');
  });

  // The protection is a window, not a licence to stay pending for ever.
  it('gives up on a request that never landed', async () => {
    global.__systemd = 'unknown';
    await setSolo({
      status: 'pending',
      requested_status: 'online',
      requested_at: secondsAgo(200),
    });

    await run();

    expect((await readSolo()).status).not.toBe('pending');
  });

  // Nothing was asked for, so nothing is in flight: the reading stands.
  it('does not protect a service nobody asked to change', async () => {
    global.__systemd = 'inactive';
    await setSolo({
      status: 'pending',
      requested_status: null,
      requested_at: null,
    });

    await run();

    expect((await readSolo()).status).toBe('offline');
  });
});
