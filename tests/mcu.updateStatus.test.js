const os = require('os');
const path = require('path');
const realFs = jest.requireActual('fs');

// The record says what the updater believes; systemd says whether it is still
// there to believe it. Either alone lies, which is why they are reported together.
describe('Mcu.updateStatus', () => {
  let stateDir;
  let mcuService;
  let execMock;

  const build = (systemctl) => {
    jest.resetModules();
    execMock = jest.fn(systemctl);
    jest.doMock('child_process', () => ({
      ...jest.requireActual('child_process'),
      exec: (cmd, cb) => execMock(cmd, cb),
    }));
    jest.doMock('../src/paths', () => ({
      ...jest.requireActual('../src/paths'),
      getStateDir: () => stateDir,
    }));
    // eslint-disable-next-line global-require
    const fsPromises = require('fs').promises;
    const existing = fsPromises.readFile;
    jest.spyOn(fsPromises, 'readFile').mockImplementation((p, enc) => {
      if (String(p).endsWith('last-update.json')) return realFs.promises.readFile(p, enc);
      return existing(p, enc);
    });
    // eslint-disable-next-line global-require
    mcuService = require('../src/services/mcu')(null, {});
  };

  const inactive = (cmd, cb) => cb(Object.assign(new Error('inactive'), { code: 3 }));
  const active = (cmd, cb) => cb(null, { stdout: 'active\n', stderr: '' });

  const writeRecord = (record) =>
    realFs.writeFileSync(path.join(stateDir, 'last-update.json'), JSON.stringify(record));

  beforeEach(() => {
    stateDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'apollo-state-'));
  });

  afterEach(() => {
    realFs.rmSync(stateDir, { recursive: true, force: true });
    jest.dontMock('../src/paths');
    jest.dontMock('child_process');
  });

  it('returns no record when no update has ever run', async () => {
    build(inactive);
    await expect(mcuService.getUpdateStatus()).resolves.toEqual({
      running: false,
      record: null,
    });
  });

  it('carries the run id, so a client can recognise its own update', async () => {
    // This replaces comparing the browser's clock against the device's — on
    // boards with no RTC, in the minutes after a restart when NTP has not
    // converged, that rejected genuine records and accepted stale ones.
    build(inactive);
    writeRecord({ run_id: 'abc-123', state: 'succeeded', from: '2.2.0', to: '2.3.0' });
    const { record } = await mcuService.getUpdateStatus();
    expect(record.runId).toBe('abc-123');
    expect(record.state).toBe('succeeded');
  });

  it('reports a run still in flight as running', async () => {
    build(active);
    writeRecord({ run_id: 'r1', state: 'running', phase: 'downloading', progress: 15 });
    const status = await mcuService.getUpdateStatus();
    expect(status.running).toBe(true);
    expect(status.record.state).toBe('running');
    expect(status.record.phase).toBe('downloading');
  });

  it('calls a killed updater interrupted rather than leaving it running forever', async () => {
    // A record stuck on "running" with no unit alive is the state the previous
    // design could not express: it latched service recovery off and left any
    // client waiting on an outcome that would never arrive.
    build(inactive);
    writeRecord({ run_id: 'r1', state: 'running', phase: 'installing', progress: 70 });
    const status = await mcuService.getUpdateStatus();
    expect(status.running).toBe(false);
    expect(status.record.state).toBe('interrupted');
  });

  it('distinguishes a rollback that worked from one that did not', async () => {
    build(inactive);
    writeRecord({ run_id: 'r1', state: 'recovery-failed', reason: 'disk full' });
    const { record } = await mcuService.getUpdateStatus();
    // The only state that means SSH is required, and the one the old vocabulary
    // had no room for — so a half-failed rollback claimed the device was restored.
    expect(record.state).toBe('recovery-failed');
    expect(record.reason).toBe('disk full');
  });

  it('returns no record rather than throwing on a malformed one', async () => {
    build(inactive);
    realFs.writeFileSync(path.join(stateDir, 'last-update.json'), '{ not json');
    await expect(mcuService.getUpdateStatus()).resolves.toEqual({
      running: false,
      record: null,
    });
  });
});
