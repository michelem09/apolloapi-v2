const os = require('os');
const path = require('path');
const realFs = jest.requireActual('fs');

// Live progress, and nothing inferred.
//
// Four rounds were spent trying to make this value also release the pre-update
// bundle after a successful update — a permanent 100, a wall-clock window, a
// monotonic window, a liveness flag — and each shape traded one failure for
// another. They failed for one reason: they reconstructed, from device state, a
// signal about a browser that never touches that state. This suite pins the
// simple contract that replaced them, so the next attempt has to argue with it.
describe('Mcu.updateProgress', () => {
  let stateDir;
  let progressPath;
  let mcuService;

  const build = () => {
    jest.resetModules();
    // eslint-disable-next-line global-require
    const fsPromises = require('fs').promises;
    jest.spyOn(fsPromises, 'readFile').mockImplementation((p, enc) => {
      const file = String(p) === '/tmp/update_progress' ? progressPath : p;
      return realFs.promises.readFile(file, enc);
    });
    // eslint-disable-next-line global-require
    mcuService = require('../src/services/mcu')(null, {});
  };

  beforeEach(() => {
    stateDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'apollo-state-'));
    progressPath = path.join(stateDir, 'update_progress');
    build();
  });

  afterEach(() => {
    realFs.rmSync(stateDir, { recursive: true, force: true });
    jest.restoreAllMocks();
  });

  it('reports the value the updater wrote', async () => {
    realFs.writeFileSync(progressPath, '88');
    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 88 });
  });

  it('reports 0 when no update is running', async () => {
    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 0 });
  });

  it('reports 0 rather than NaN on a garbled file', async () => {
    realFs.writeFileSync(progressPath, 'not a number');
    await expect(mcuService.getUpdateProgress()).resolves.toEqual({ value: 0 });
  });

  it('infers nothing from the update record', async () => {
    // The regression guard. Every attempt to synthesise a terminal value here
    // has produced a defect: the last one gated on a flag the only client for it
    // cannot set, so CI certified a completely closed path. If this method grows
    // a reason to consult the record again, that argument belongs in a design
    // note, not in a quiet condition.
    const src = realFs.readFileSync(
      path.join(__dirname, '..', 'src', 'services', 'mcu.js'),
      'utf8'
    );
    const method = src.match(/async getUpdateProgress\(\) \{[\s\S]*?\n {2}\}/)[0];
    expect(method).not.toContain('_readUpdateRecord');
    expect(method).not.toContain('100');
  });
});
