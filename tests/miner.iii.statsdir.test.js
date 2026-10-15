// _isMinerOnline and the III stats read must agree on where apollo-miner-3.json
// lives: one helper (paths.getApolloIIIStatsDir) honouring APOLLO_III_STATS_DIR.
// Real fs on a temp dir (the global fs mock is lifted for this file).
jest.unmock('fs');

const os = require('os');
const path = require('path');
const realFs = require('fs');

describe('Apollo III stats dir', () => {
  let tmp;
  let runtimeDir;
  let overrideDir;
  const saved = { state: process.env.APOLLO_STATE_DIR, iii: process.env.APOLLO_III_STATS_DIR };

  const load = () => {
    jest.resetModules();
    return require('../src/services/miner')({}, {});
  };
  const online = { requestedStatus: null };

  beforeEach(() => {
    tmp = realFs.mkdtempSync(path.join(os.tmpdir(), 'iiidir-'));
    runtimeDir = path.join(tmp, 'miner');
    overrideDir = path.join(tmp, 'elsewhere');
    realFs.mkdirSync(runtimeDir, { recursive: true });
    realFs.mkdirSync(overrideDir, { recursive: true });
    process.env.APOLLO_STATE_DIR = tmp;
    delete process.env.APOLLO_III_STATS_DIR;
  });

  afterEach(() => {
    realFs.rmSync(tmp, { recursive: true, force: true });
    for (const [k, v] of [['APOLLO_STATE_DIR', saved.state], ['APOLLO_III_STATS_DIR', saved.iii]]) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('helper defaults to the runtime dir and honours the override', () => {
    const paths = require('../src/paths');
    expect(paths.getApolloIIIStatsDir({})).toBe(paths.getMinerRuntimeDir());
    expect(paths.getApolloIIIStatsDir({ APOLLO_III_STATS_DIR: '/x' })).toBe('/x');
  });

  it('default dir: a fresh III stat file in the runtime dir means online', async () => {
    realFs.writeFileSync(path.join(runtimeDir, 'apollo-miner-3.json'), '{}');
    const miner = load();
    expect((await miner._isMinerOnline(online)).status).toBe('online');
  });

  it('override dir: a fresh III stat file there means online', async () => {
    process.env.APOLLO_III_STATS_DIR = overrideDir;
    realFs.writeFileSync(path.join(overrideDir, 'apollo-miner-3.json'), '{}');
    const miner = load();
    expect((await miner._isMinerOnline(online)).status).toBe('online');
  });

  it('override dir: a stale file there means offline, an empty runtime dir does not mask it', async () => {
    process.env.APOLLO_III_STATS_DIR = overrideDir;
    const f = path.join(overrideDir, 'apollo-miner-3.json');
    realFs.writeFileSync(f, '{}');
    const old = new Date(Date.now() - 120000);
    realFs.utimesSync(f, old, old);
    const miner = load();
    expect((await miner._isMinerOnline(online)).status).toBe('offline');
  });

  it('no stat file anywhere: offline', async () => {
    process.env.APOLLO_III_STATS_DIR = overrideDir;
    const miner = load();
    expect((await miner._isMinerOnline(online)).status).toBe('offline');
  });
});
