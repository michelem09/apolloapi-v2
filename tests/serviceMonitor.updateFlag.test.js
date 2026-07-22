const { promisify } = require('util');

// Whether an update is running is asked of systemd, not inferred from a file.
//
// Both earlier versions latched. Keyed on the progress file's EXISTENCE, one
// failed update suppressed service recovery forever; keyed on its VALUE, an
// updater killed during the health check left a mid-range number behind and did
// the same. Nothing clears that file except the next update, and these devices do
// not reboot on their own — so the block it guards, which includes the auto
// restart of a crashed bitcoind or miner, stayed off on exactly the device that
// had just been through a failed update.
describe('serviceMonitor update-in-progress detection', () => {
  let isUpdateRunning;
  let execMock;

  const withSystemctl = (impl) => {
    jest.resetModules();
    execMock = jest.fn(impl);
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      exec: (cmd, cb) => execMock(cmd, cb),
    }));
    // eslint-disable-next-line global-require
    ({ isUpdateRunning } = require('../src/services/serviceMonitor'));
  };

  afterEach(() => {
    jest.dontMock('child_process');
  });

  it('reports an update running while the transient unit is active', async () => {
    withSystemctl((cmd, cb) => cb(null, { stdout: 'active\n', stderr: '' }));
    await expect(isUpdateRunning()).resolves.toBe(true);
    expect(execMock.mock.calls[0][0]).toContain('is-active apollo-update.service');
  });

  it('reports no update once the unit is gone', async () => {
    // systemd clears this by itself however the updater died — which is the whole
    // point of asking it instead of reading a file nothing ever cleans up.
    withSystemctl((cmd, cb) => cb(Object.assign(new Error('inactive'), { code: 3 })));
    await expect(isUpdateRunning()).resolves.toBe(false);
  });

  it('reports no update when the unit failed', async () => {
    withSystemctl((cmd, cb) => cb(Object.assign(new Error('failed'), { code: 4 })));
    await expect(isUpdateRunning()).resolves.toBe(false);
  });

  it('treats an unusable systemctl as no update', async () => {
    // A false positive suppresses service recovery indefinitely; a false negative
    // costs one poll misreading a deliberate stop. Fail towards recovery.
    withSystemctl((cmd, cb) => cb(new Error('systemctl: command not found')));
    await expect(isUpdateRunning()).resolves.toBe(false);
  });
});
