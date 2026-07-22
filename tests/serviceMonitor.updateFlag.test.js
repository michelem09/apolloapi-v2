// Whether an update is running is asked of systemd, not inferred from a file.
//
// Both earlier versions latched. Keyed on the progress file's EXISTENCE, one
// failed update suppressed service recovery forever; keyed on its VALUE, an
// updater killed during the health check left a mid-range number behind and did
// the same. Nothing clears that file except the next update, and these devices do
// not reboot on their own — so the block it guards, which includes the auto
// restart of a crashed bitcoind or miner, stayed off on exactly the device that
// had just been through a failed update.
//
// Driven through the ServiceMonitor instance, which is what production calls.
// These assertions used to run against a module-level copy of the same two-liner
// that no device ever executed: four green tests, error handling that differed
// from the shipped path, and no coverage at all of the line that matters.
describe('serviceMonitor update-in-progress detection', () => {
  let monitor;
  let UPDATE_UNIT;
  let execMock;

  const withSystemctl = (impl) => {
    jest.resetModules();
    execMock = jest.fn(impl);
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      exec: (cmd, cb) => execMock(cmd, cb),
    }));
    // eslint-disable-next-line global-require
    const factory = require('../src/services/serviceMonitor');
    UPDATE_UNIT = factory.UPDATE_UNIT;
    monitor = factory(null, {});
  };

  afterEach(() => {
    jest.dontMock('child_process');
  });

  const updateRunning = () => monitor._isSystemdActive(UPDATE_UNIT);

  it('names the transient unit the updater actually creates', () => {
    withSystemctl((cmd, cb) => cb(null, { stdout: 'active\n', stderr: '' }));
    // A contract with backend/update's `systemd-run --unit=`; a mismatch here is
    // silent and permanent.
    expect(UPDATE_UNIT).toBe('apollo-update.service');
  });

  it('reports an update running while the transient unit is active', async () => {
    withSystemctl((cmd, cb) => cb(null, { stdout: 'active\n', stderr: '' }));
    await expect(updateRunning()).resolves.toBe(true);
    expect(execMock.mock.calls[0][0]).toContain('is-active apollo-update.service');
  });

  it('reports no update once the unit is gone', async () => {
    // systemd clears this by itself however the updater died — which is the whole
    // point of asking it instead of reading a file nothing ever cleans up.
    withSystemctl((cmd, cb) => cb(Object.assign(new Error('inactive'), { code: 3 })));
    await expect(updateRunning()).resolves.toBe(false);
  });

  it('reports no update when the unit failed', async () => {
    withSystemctl((cmd, cb) => cb(Object.assign(new Error('failed'), { code: 4 })));
    await expect(updateRunning()).resolves.toBe(false);
  });

  it('says null — not false — when systemd could not be asked', async () => {
    // This asserted `false`, which is the defect: `is-active` exits 3 on the
    // normal path, so "the call failed" cannot mean "the unit is not running".
    // A fork that fails for another reason — EAGAIN or ENOMEM while the updater
    // unpacks and backs up hundreds of megabytes — would answer "no update is
    // running" while one is, and checkService would then read the updater's
    // deliberate stop of node and the miner as the user's own and persist
    // requested_status='offline' for both. Compounded with the updater's
    // `wanted()` check, the miner never comes back.
    withSystemctl((cmd, cb) => cb(new Error('systemctl: command not found')));
    await expect(updateRunning()).resolves.toBeNull();
  });

  it('counts an activating unit as running', async () => {
    // is-active exits 3 for `activating` too, so the exit code alone cannot
    // distinguish it from inactive — and a transient unit is activating for the
    // moment right after systemd-run creates it, which is exactly when a client
    // is looking hardest.
    withSystemctl((cmd, cb) =>
      cb(Object.assign(new Error('activating'), { code: 3, stdout: 'activating\n' }))
    );
    await expect(updateRunning()).resolves.toBe(true);
  });

  it('leaves the manual-action branch alone when it cannot ask', async () => {
    // The consequence, at the call site: `!updateInProgress` was true for null,
    // so an unanswerable question sent checkService into the branch that
    // rewrites the user's intent.
    // eslint-disable-next-line global-require
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'src', 'services', 'serviceMonitor.js'),
      'utf8'
    );
    expect(src).toContain('if (existing && updateInProgress === false) {');
    expect(src).not.toContain('if (existing && !updateInProgress) {');
  });

  it('does not keep a second, untested copy of the check', () => {
    // The defect this file was rewritten against: the shipped path and the tested
    // path were different functions.
    // eslint-disable-next-line global-require
    const factory = require('../src/services/serviceMonitor');
    expect(factory.isUpdateRunning).toBeUndefined();
    // eslint-disable-next-line global-require
    const fs = require('fs');
    // eslint-disable-next-line global-require
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'serviceMonitor.js'),
      'utf8'
    );
    expect(src.match(/systemctl is-active/g)).toHaveLength(1);
  });
});
