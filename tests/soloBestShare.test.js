// tests/soloBestShare.test.js
//
// The record must survive ckpool. Its pool-level `bestshare` counts the current
// run: every restart puts it back to zero, and before this the headline on the
// solo page went with it.
jest.mock('child_process', () => ({ exec: jest.fn() }));

const { knex } = require('../src/db');
const makeSoloService = require('../src/services/solo');

const readRow = () => knex('solo_best_share').where({ id: 1 }).first();

describe('best share ever', () => {
  let solo;

  beforeEach(async () => {
    await knex('solo_best_share')
      .where({ id: 1 })
      .update({ best_share: 0, found_at: null });
    solo = makeSoloService(knex, {});
  });

  it('records a new record and reports it', async () => {
    const best = await solo._recordBestShare({ pool: { bestshare: 4200 }, users: [] });

    expect(best.value).toBe(4200);
    expect((await readRow()).best_share).toBe(4200);
  });

  it('does not lower the record when ckpool restarts', async () => {
    await solo._recordBestShare({ pool: { bestshare: 4200 }, users: [] });

    // What a freshly restarted ckpool reports: a run with no shares yet.
    const best = await solo._recordBestShare({ pool: { bestshare: 0 }, users: [] });

    expect(best.value).toBe(4200);
    expect((await readRow()).best_share).toBe(4200);
  });

  it('takes the highest of the pool and the users', async () => {
    const best = await solo._recordBestShare({
      pool: { bestshare: 1000 },
      // ckpool's own persisted figure, reloaded from logs/users at startup.
      users: [{ bestever: 9000 }, { bestever: 30 }],
    });

    expect(best.value).toBe(9000);
  });

  it('survives a service rebuilt from scratch', async () => {
    await solo._recordBestShare({ pool: { bestshare: 777 }, users: [] });

    // A restart of the API: new instance, empty cache, same database.
    const reborn = makeSoloService(knex, {});
    expect((await reborn._loadBestShareEver()).value).toBe(777);
  });

  it('treats a missing or unreadable figure as no record at all', async () => {
    await solo._recordBestShare({ pool: { bestshare: 500 }, users: [] });

    const best = await solo._recordBestShare({ pool: null, users: null });

    expect(best.value).toBe(500);
  });

  // getStats runs from two schedulers at once — a push every 5 s and the time
  // series every 60 s — each reading pool.status for itself. The slower one can
  // arrive last holding the smaller figure, and must not undo the record.
  it('refuses a write that would lower the record', async () => {
    const slow = makeSoloService(knex, {});
    const fast = makeSoloService(knex, {});
    // Both read the table before either writes: the state of a real race.
    await slow._loadBestShareEver();
    await fast._loadBestShareEver();

    await fast._recordBestShare({ pool: { bestshare: 9000 }, users: [] });
    const after = await slow._recordBestShare({ pool: { bestshare: 8000 }, users: [] });

    expect((await readRow()).best_share).toBe(9000);
    // And the loser is told the truth rather than its own stale figure.
    expect(after.value).toBe(9000);
  });

  // A plain UPDATE reports a missing row as nothing happening, and the record
  // would live only in memory until the next restart.
  it('creates the row if it is not there', async () => {
    await knex('solo_best_share').where({ id: 1 }).del();

    const best = await makeSoloService(knex, {})._recordBestShare({
      pool: { bestshare: 321 },
      users: [],
    });

    expect(best.value).toBe(321);
    expect((await readRow()).best_share).toBe(321);
  });

  // The first reading after ckpool starts can be a figure it restored from
  // disk, and dating that with today would be a lie.
  it('leaves a record undated when ckpool has only just started', async () => {
    const best = await solo._recordBestShare({
      pool: { bestshare: 500, runtime: 3 },
      users: [],
    });

    expect(best.value).toBe(500);
    expect(best.at).toBeNull();
  });

  // Past that window a rise cannot be a restore: we were watching.
  it('dates the first record of a device that has been running a while', async () => {
    const best = await solo._recordBestShare({
      pool: { bestshare: 500, runtime: 3600 },
      users: [],
    });

    expect(best.at).not.toBeNull();
  });

  // Already knowing a record is not evidence that the next one was watched. An
  // upgraded device is seeded from a 30-day time series and can meet its own
  // older, larger all-time record seconds after ckpool restores it.
  it('does not date a larger record met just after a restart', async () => {
    await solo._recordBestShare({ pool: { bestshare: 500, runtime: 4000 }, users: [] });

    const best = await solo._recordBestShare({
      pool: { bestshare: 9000, runtime: 2 },
      users: [{ bestever: 9000 }],
    });

    expect(best.value).toBe(9000);
    expect(best.at).toBeNull();
  });

  it('says nothing and logs nothing without a database', async () => {
    const orphan = makeSoloService(null, {});
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const best = await orphan._recordBestShare({ pool: { bestshare: 5000 }, users: [] });

    expect(best.value).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  // A refused write leaves the record exactly as it was — this is what guards
  // a stored date against a stale read, not any special handling of the date.
  it('leaves the stored record untouched when the candidate loses', async () => {
    await knex('solo_best_share')
      .where({ id: 1 })
      .update({ best_share: 100000, found_at: '2026-01-02T03:04:05.000Z' });

    // A service whose cached view is behind: it still believes the record is 0.
    const stale = makeSoloService(knex, {});
    jest.spyOn(stale, '_loadBestShareEver').mockResolvedValue({ value: 0, at: null });

    await stale._recordBestShare({ pool: { bestshare: 900, runtime: 4000 }, users: [] });

    const row = await readRow();
    expect(row.best_share).toBe(100000);
    expect(row.found_at).toBe('2026-01-02T03:04:05.000Z');
  });

  // Every five seconds, for ever, is not a reasonable way to report a problem.
  it('complains once about a table it cannot read', async () => {
    const broken = makeSoloService(
      { ...knex, __proto__: knex },
      {}
    );
    broken.knex = () => { throw new Error('no such table'); };
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await broken._loadBestShareEver();
    await broken._loadBestShareEver();
    await broken._loadBestShareEver();

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  it('puts the record in the stats the UI receives', async () => {
    await solo._recordBestShare({ pool: { bestshare: 1234 }, users: [] });

    jest.spyOn(solo, 'getStatus').mockResolvedValue('inactive');
    const stats = await solo.getStats();

    expect(stats.bestShareEver.value).toBe(1234);
  });
});
