const os = require('os');
const path = require('path');
const realFs = jest.requireActual('fs');

// The compatibility value exists for ONE client: the UI bundle loaded before the
// update — the bundle the update replaces. That bundle polls Mcu.updateProgress
// and knows nothing else; it completes only on `value >= 90`, and its check sits
// outside its own in-progress guard.
//
// Driven behaviourally. The previous version of this was two assertions on the
// source text, and when the gate was changed to something that client can never
// satisfy they went on passing — CI certified the break.
describe('Mcu.updateProgress — the pre-update bundle\'s only signal', () => {
  let stateDir;
  let progressPath;
  let mcuService;

  const build = () => {
    jest.resetModules();
    jest.doMock('../src/paths', () => ({
      ...jest.requireActual('../src/paths'),
      getStateDir: () => stateDir,
    }));
    // eslint-disable-next-line global-require
    const fsPromises = require('fs').promises;
    // The progress file is redirected into the sandbox; everything else reads
    // for real. Nothing stubs the absence — an ENOENT here is a real ENOENT.
    jest.spyOn(fsPromises, 'readFile').mockImplementation((p, enc) => {
      const file = String(p) === '/tmp/update_progress' ? progressPath : p;
      return realFs.promises.readFile(file, enc);
    });
    // eslint-disable-next-line global-require
    mcuService = require('../src/services/mcu')(null, {});
  };

  const writeProgress = (v) => realFs.writeFileSync(progressPath, String(v));
  const clearProgress = () => realFs.rmSync(progressPath, { force: true });
  const writeRecord = (r) =>
    realFs.writeFileSync(path.join(stateDir, 'last-update.json'), JSON.stringify(r));

  const SUCCEEDED = {
    run_id: 'RUN-1',
    state: 'succeeded',
    phase: 'done',
    progress: 100,
    from: '2.2.0',
    to: '2.3.0',
    updated_at: new Date().toISOString(),
  };

  beforeEach(() => {
    stateDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'apollo-state-'));
    progressPath = path.join(stateDir, 'update_progress');
    build();
  });

  afterEach(() => {
    realFs.rmSync(stateDir, { recursive: true, force: true });
    jest.dontMock('../src/paths');
    jest.restoreAllMocks();
  });

  it('serves the live value while the file is there', async () => {
    writeProgress(88);
    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 88 });
  });

  it('releases the old bundle after a successful update', async () => {
    // The real sequence: the updater starts apollo-api at 88, so this process
    // sees the file; the file goes once the health check passes; the record says
    // it worked. Without the last step the browser reads 0 and never reaches its
    // >= 90, sitting on "Updating... 0%" with no close button after a SUCCESSFUL
    // update.
    writeProgress(88);
    await mcuService.getUpdateProgress();
    clearProgress();
    writeRecord(SUCCEEDED);

    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 100 });
  });

  it('does not release a process that never watched the update', async () => {
    // An apollo-api restarted days later for any reason must not re-open the
    // window: that latched the old bundle's "Done!" on every mount.
    clearProgress();
    writeRecord(SUCCEEDED);
    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 0 });
  });

  it('does not release on a rollback', async () => {
    // Reporting 100 would make that bundle render "Done!" for an update that was
    // reverted — it has no way to show anything else.
    writeProgress(88);
    await mcuService.getUpdateProgress();
    clearProgress();
    writeRecord({ ...SUCCEEDED, state: 'rolled-back' });
    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 0 });
  });

  it('does not release when nothing was installed', async () => {
    // "Already on <version>" records succeeded WITHOUT replacing the UI, so the
    // bundle asking is not waiting for anything.
    writeProgress(5);
    await mcuService.getUpdateProgress();
    clearProgress();
    writeRecord({ ...SUCCEEDED, from: '2.3.0', to: '2.3.0' });
    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 0 });
  });
});
