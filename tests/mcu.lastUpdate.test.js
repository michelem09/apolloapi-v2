const os = require('os');
const path = require('path');
const realFs = jest.requireActual('fs');

// The updater stops apollo-api partway through, so progress polling goes dark for
// the minutes that matter and the UI reconnects with no memory of what happened.
// This record is the only way it can distinguish "your update failed and the
// device was restored" from a blackout the user has to interpret for themselves.
describe('Mcu.lastUpdate', () => {
  let stateDir;
  let mcuService;

  let readFileSpy;

  beforeEach(() => {
    stateDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'apollo-state-'));
    jest.resetModules();
    jest.doMock('../src/paths', () => ({
      ...jest.requireActual('../src/paths'),
      getStateDir: () => stateDir,
    }));

    // The shared setup mocks fs.promises.readFile to serve miner fixtures, so the
    // real file has to be served explicitly for this path — otherwise every case
    // below passes for the same wrong reason: readFile never returns the record.
    // eslint-disable-next-line global-require
    const fsPromises = require('fs').promises;
    const existing = fsPromises.readFile;
    readFileSpy = jest.spyOn(fsPromises, 'readFile').mockImplementation((p, enc) => {
      if (String(p).endsWith('last-update.json')) return realFs.promises.readFile(p, enc);
      return existing(p, enc);
    });

    // eslint-disable-next-line global-require
    mcuService = require('../src/services/mcu')(null, {});
  });

  afterEach(() => {
    readFileSpy.mockRestore();
    realFs.rmSync(stateDir, { recursive: true, force: true });
    jest.dontMock('../src/paths');
  });

  const writeRecord = (contents) =>
    realFs.writeFileSync(path.join(stateDir, 'last-update.json'), contents);

  it('returns null when no update has ever run', async () => {
    await expect(mcuService.getLastUpdate()).resolves.toBeNull();
  });

  it('reports a rollback with the reason it happened', async () => {
    writeRecord(
      JSON.stringify({
        result: 'rolled-back',
        from: '2.2.1-rc5',
        to: '2.2.1-rc6',
        reason: 'Health check failed after installing 2.2.1-rc6',
        started_at: '2026-07-22T06:00:00Z',
        finished_at: '2026-07-22T06:04:11Z',
      })
    );

    await expect(mcuService.getLastUpdate()).resolves.toEqual({
      result: 'rolled-back',
      from: '2.2.1-rc5',
      to: '2.2.1-rc6',
      reason: 'Health check failed after installing 2.2.1-rc6',
      startedAt: '2026-07-22T06:00:00Z',
      finishedAt: '2026-07-22T06:04:11Z',
    });
  });

  it('reports a success with no reason', async () => {
    writeRecord(
      JSON.stringify({ result: 'success', from: '2.2.1-rc5', to: '2.2.1-rc6', reason: '' })
    );
    const record = await mcuService.getLastUpdate();
    expect(record.result).toBe('success');
    expect(record.reason).toBeNull();
  });

  // 'failed' means the device was never modified; 'rolled-back' means it was and
  // has been put back. The difference is what the user is told happened to them.
  it('distinguishes a failure that never touched the device', async () => {
    writeRecord(JSON.stringify({ result: 'failed', reason: 'Checksum mismatch' }));
    const record = await mcuService.getLastUpdate();
    expect(record.result).toBe('failed');
    expect(record.from).toBeNull();
  });

  it('returns null rather than throwing on a malformed record', async () => {
    // A broken outcome file must not become a second failure on a healthy device.
    writeRecord('{ this is not json');
    await expect(mcuService.getLastUpdate()).resolves.toBeNull();
  });

  it('returns null when the record has no result field', async () => {
    writeRecord(JSON.stringify({ from: '2.2.0' }));
    await expect(mcuService.getLastUpdate()).resolves.toBeNull();
  });
});
