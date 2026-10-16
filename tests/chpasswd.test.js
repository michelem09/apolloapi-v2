const childProcess = require('child_process');

// Errors go through the logger (console is banned in src/), so read them there.
jest.mock('../src/logger', () => {
  const logger = {
    trace: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    fatal: jest.fn(),
    isLevelEnabled: () => false,
  };
  return () => logger;
});
const log = require('../src/logger')();

const utils = require('../src/utils');

describe('chpasswd', () => {
  let origEnv;
  beforeEach(() => {
    origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    // sqlite's own scheduling must keep running while the timeout is simulated.
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
  });
  afterEach(() => {
    process.env.NODE_ENV = origEnv;
    jest.useRealTimers();
  });

  const fakeChild = () => {
    const handlers = {};
    const stdinHandlers = {};
    const child = {
      stdin: { write: jest.fn(), end: jest.fn(), on: jest.fn((e, cb) => (stdinHandlers[e] = cb)) },
      stderr: { on: jest.fn() },
      on: jest.fn((e, cb) => (handlers[e] = cb)),
      kill: jest.fn(),
      pid: 4242,
    };
    return { child, handlers, stdinHandlers };
  };

  it('F4: a chpasswd that never exits is killed and reported, not waited on for ever', async () => {
    const { child } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = utils.auth.changeSystemPassword('longenough1');
    const outcome = pending.catch((e) => e);
    await jest.advanceTimersByTimeAsync(30000);

    const error = await outcome;
    expect(error.message).toMatch(/did not finish within 30s/);
    expect(error.message).toMatch(/may or may not have changed/);
    // The child is sudo, which runs as root: signals go through `sudo kill`, since
    // a plain kill() from the service user would be refused. TERM first, KILL later.
    const signals = () =>
      childProcess.spawn.mock.calls.filter(([cmd, args]) => cmd === 'sudo' && args[0] === 'kill').map(([, args]) => args.join(' '));
    expect(signals()).toEqual(['kill -TERM 4242']);
    expect(child.kill).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5000);
    expect(signals()).toEqual(['kill -TERM 4242', 'kill -KILL 4242']);
  });

  it('a failing `sudo kill` does not take the process down', async () => {
    const { child, handlers } = fakeChild();
    childProcess.spawn.mockReturnValue(child);
    const outcome = utils.auth.changeSystemPassword('longenough1').catch((e) => e);
    await jest.advanceTimersByTimeAsync(30000);
    await outcome;
    // The killer is another child whose 'error' event must have a listener.
    const errorListeners = child.on.mock.calls.filter(([event]) => event === 'error');
    expect(errorListeners.length).toBeGreaterThanOrEqual(2);
    expect(() => handlers.error?.(new Error('spawn sudo ENOENT'))).not.toThrow();
  });

  it('keeps what chpasswd said off the screen', async () => {
    const { child, handlers } = fakeChild();
    let onStderr;
    child.stderr.on = jest.fn((event, cb) => {
      onStderr = cb;
    });
    childProcess.spawn.mockReturnValue(child);

    const outcome = utils.auth.changeSystemPassword('longenough1').catch((e) => e);
    await jest.advanceTimersByTimeAsync(10);
    onStderr('chpasswd: (user futurebit) pam_chauthtok() failed, error:\nAuthentication token manipulation error');
    handlers.close(1);

    const error = await outcome;
    expect(error.message).toBe('Could not change the system password');
    expect(JSON.stringify(log.error.mock.calls)).toMatch(/pam_chauthtok/);
  });

  it('does not time out a chpasswd that finishes', async () => {
    const { child, handlers } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = utils.auth.changeSystemPassword('longenough1');
    await jest.advanceTimersByTimeAsync(10);
    handlers.close(0);
    await expect(pending).resolves.toBeUndefined();
    await jest.advanceTimersByTimeAsync(60000);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('F5: a broken pipe on its stdin rejects instead of crashing the process', async () => {
    const { child, stdinHandlers } = fakeChild();
    childProcess.spawn.mockReturnValue(child);

    const pending = utils.auth.changeSystemPassword('longenough1');
    const outcome = pending.catch((e) => e);
    await jest.advanceTimersByTimeAsync(10);
    expect(stdinHandlers.error).toBeInstanceOf(Function);
    stdinHandlers.error(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));

    expect((await outcome).message).toMatch(/EPIPE/);
  });
});
