// tests/poolsTrim.test.js
// A pool URL or worker name pasted with a space or newline at an edge is cleaned
// on the way in, whichever client sent it. The password is never touched.
const mockGenerate = jest.fn();
jest.mock('../src/configurator', () => (...args) => mockGenerate(...args));

const { knex } = require('../src/db');
const createPools = require('../src/services/pools');
const createPoolProfiles = require('../src/services/poolProfiles');
const poolsResolver = require('../src/graphql/resolvers/pools');

const svc = createPools(knex);

describe('pools service trims url and username, not password', () => {
  beforeEach(async () => {
    await knex('pools').del();
    await knex('pool_profiles').del();
    mockGenerate.mockReset();
  });

  it('updateAll stores trimmed values for the primary and the backup', async () => {
    await svc.updateAll([
      { enabled: 1, url: '  stratum+tcp://pool.example.com:3333 ', username: ' wallet.w1\n', password: ' p w ', index: 1 },
      { enabled: 1, url: '\tbackup.example.com:4444  ', username: ' w2 ', password: 'x', index: 2 },
    ]);
    const rows = await knex('pools').select('url', 'username', 'password').orderBy('index');
    expect(rows).toEqual([
      { url: 'stratum+tcp://pool.example.com:3333', username: 'wallet.w1', password: ' p w ' },
      { url: 'backup.example.com:4444', username: 'w2', password: 'x' },
    ]);
  });

  it('what reaches the miner config generator is the trimmed value', async () => {
    await svc.updateAll([
      { enabled: 1, url: ' stratum+tcp://pool.example.com:3333 ', username: ' w ', password: 'x', index: 1 },
    ]);
    const passed = mockGenerate.mock.calls[0][0];
    expect(passed[0].url).toBe('stratum+tcp://pool.example.com:3333');
    expect(passed[0].username).toBe('w');
  });

  it('create and update trim as well', async () => {
    const { pool } = await svc.create({ enabled: 1, url: ' a.example.com:3333 ', username: ' u ', password: 'x', index: 1 });
    expect(pool.url).toBe('a.example.com:3333');
    expect(pool.username).toBe('u');
    const updated = await svc.update({ id: pool.id, url: '  b.example.com:3333', username: 'v  ' });
    expect(updated.pool.url).toBe('b.example.com:3333');
    expect(updated.pool.username).toBe('v');
  });

  it('works through the resolver, the way an old client or a direct API call arrives', async () => {
    const out = await poolsResolver.PoolMutations.updateAll(
      null,
      { input: { pools: [{ enabled: 1, url: ' a.example.com:3333 ', username: ' u ', password: 'x', index: 1 }] } },
      { services: { pools: svc } }
    );
    expect(out.error).toBeNull();
    expect(out.result.pools[0].url).toBe('a.example.com:3333');
    expect(out.result.pools[0].username).toBe('u');
  });

  it('a saved pool profile trims the worker too', async () => {
    const { profile } = await createPoolProfiles(knex).save({
      name: 'p', url: ' a.example.com:3333 ', username: ' u ', password: ' x ',
    });
    expect(profile.url).toBe('a.example.com:3333');
    expect(profile.username).toBe('u');
    expect(profile.password).toBe(' x ');
  });
});
