const os = require('os');
const path = require('path');
const realFs = jest.requireActual('fs');

jest.mock('axios');

// "Is an update available?" used to be answered from
// raw.githubusercontent.com/jstefanop/apolloui-v2/main/package.json — a different
// source from the one the updater installs against, unsigned, and unrelated to the
// release. The banner and the OTA channel could never agree: a tag could ship and
// move the channel while that package.json was unchanged, so the fleet was never
// told; and on a device pointed at a fork the comparison never converged at all.
describe('Mcu.version — read from the signed update channel', () => {
  let stateDir;
  let mcuService;
  let axios;

  beforeEach(() => {
    stateDir = realFs.mkdtempSync(path.join(os.tmpdir(), 'apollo-src-'));
    // resetModules gives the service a FRESH axios instance, so the mock has to
    // be taken from the same registry — a reference captured before the reset
    // configures a different object and every assertion here silently sees null.
    jest.resetModules();
    jest.doMock('../src/paths', () => ({
      ...jest.requireActual('../src/paths'),
      getStateDir: () => stateDir,
    }));
    // eslint-disable-next-line global-require
    axios = require('axios');
    axios.get.mockReset();

    // The shared setup mocks fs.promises.readFile to serve miner fixtures, so the
    // real source.conf has to be served explicitly — otherwise the service always
    // falls back to the defaults and every channel assertion passes or fails for
    // a reason that has nothing to do with the code under test.
    // eslint-disable-next-line global-require
    const fsPromises = require('fs').promises;
    const existing = fsPromises.readFile;
    jest.spyOn(fsPromises, 'readFile').mockImplementation((p, enc) => {
      if (String(p).endsWith('source.conf')) return realFs.promises.readFile(p, enc);
      return existing(p, enc);
    });
    // eslint-disable-next-line global-require
    mcuService = require('../src/services/mcu')(null, {});
  });

  afterEach(() => {
    realFs.rmSync(stateDir, { recursive: true, force: true });
    jest.dontMock('../src/paths');
  });

  const writeSourceConf = (contents) =>
    realFs.writeFileSync(path.join(stateDir, 'source.conf'), contents);

  it('asks the channel the device is actually configured for', async () => {
    writeSourceConf(
      'APOLLO_GIT_BASE="https://github.com/michelem09"\nAPOLLO_CHANNEL="dev"\n'
    );
    axios.get.mockResolvedValue({ data: { version: '2.2.1-rc9' } });

    const { available } = await mcuService.getVersion();

    expect(available).toBe('2.2.1-rc9');
    // A device on the fork must not be asking the official repo — that mismatch
    // is what made fork releases un-installable from the UI.
    expect(axios.get.mock.calls[0][0]).toContain('michelem09');
    expect(axios.get.mock.calls[0][0]).toContain('channel-dev/dev.json');
  });

  it('falls back to the official stable channel with no source.conf', async () => {
    axios.get.mockResolvedValue({ data: { version: '2.3.0' } });

    await mcuService.getVersion();

    expect(axios.get.mock.calls[0][0]).toContain('jstefanop');
    expect(axios.get.mock.calls[0][0]).toContain('channel-stable/stable.json');
  });

  it('reports no available version when the channel cannot be reached', async () => {
    // Offering an update we cannot name is worse than staying quiet: the user
    // would press a button for a release the updater will refuse.
    axios.get.mockRejectedValue(new Error('ENOTFOUND'));

    const { available } = await mcuService.getVersion();

    expect(available).toBeNull();
  });

  it('caches the channel so every poll is not a network round trip', async () => {
    axios.get.mockResolvedValue({ data: { version: '2.3.0' } });

    await mcuService.getVersion();
    await mcuService.getVersion();
    await mcuService.getVersion();

    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('reports the installed version alongside it', async () => {
    axios.get.mockResolvedValue({ data: { version: '2.3.0' } });

    const { installed } = await mcuService.getVersion();

    // Falls back to package.json on a device that has never taken a tarball
    // update, which is every device before the switch.
    expect(typeof installed).toBe('string');
    expect(installed).toMatch(/^\d+\.\d+\.\d+/);
  });
});
