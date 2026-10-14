const fs = require('fs');
const os = require('os');
const path = require('path');
const Knex = require('knex');

const migration = require('../migrations/20260925000000_solo_best_share');

// The schema lives in two places — migrations/ for devices, tests/setup.js for
// the suite — so this runs the real migration, including the seeding a device
// that has already been mining depends on.
describe('migration: solo_best_share', () => {
  let knex;

  const withTimeSeries = async () => {
    await knex.schema.createTable('time_series_solo_data', (table) => {
      table.increments('id');
      table.float('bestshare').defaultTo(0);
      table.timestamp('createdAt');
    });
  };

  beforeEach(async () => {
    const file = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-bestshare-')),
      'test.sqlite'
    );
    knex = Knex({
      client: 'sqlite3',
      connection: { filename: file },
      useNullAsDefault: true,
    });
  });

  afterEach(async () => {
    await knex.destroy();
  });

  it('creates the single row the service updates', async () => {
    await migration.up(knex);

    expect(await knex.schema.hasTable('solo_best_share')).toBe(true);
    const rows = await knex('solo_best_share');
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
  });

  // Without this an existing device would announce a brand new record of zero
  // and then climb back up, which reads as having lost the old one.
  it('seeds the record from the samples already taken', async () => {
    await withTimeSeries();
    await knex('time_series_solo_data').insert([
      { bestshare: 120, createdAt: '2026-09-01 10:00:00' },
      { bestshare: 98000, createdAt: '2026-09-12 22:15:00' },
      { bestshare: 4000, createdAt: '2026-09-20 08:00:00' },
    ]);

    await migration.up(knex);

    const row = await knex('solo_best_share').where({ id: 1 }).first();
    expect(row.best_share).toBe(98000);
    // The date is the one the share was actually found on, not today — and it
    // says which zone it is in. SQLite hands the sample over as bare UTC, and a
    // browser reading that shape assumes local time.
    expect(row.found_at).toBe('2026-09-12T22:15:00.000Z');
  });

  // Every sample after the record was set carries the same figure, so the
  // newest of them is not when it was found.
  it('dates the record from the first sample that reached it', async () => {
    await withTimeSeries();
    await knex('time_series_solo_data').insert([
      { bestshare: 98000, createdAt: '2026-09-12 22:15:00' },
      { bestshare: 98000, createdAt: '2026-09-24 06:00:00' },
    ]);

    await migration.up(knex);

    const row = await knex('solo_best_share').where({ id: 1 }).first();
    expect(String(row.found_at)).toContain('2026-09-12');
  });

  it('starts at zero on a device with no history', async () => {
    await withTimeSeries();

    await migration.up(knex);

    const row = await knex('solo_best_share').where({ id: 1 }).first();
    expect(row.best_share).toBe(0);
    expect(row.found_at).toBeNull();
  });

  // Migrations run from init.js before the server is required: anything thrown
  // here stops the API from starting at all. A date it cannot read is worth
  // exactly one null.
  it('does not take the boot down over an unreadable date', async () => {
    await withTimeSeries();
    await knex('time_series_solo_data').insert({
      bestshare: 4242,
      createdAt: 'not a date at all',
    });

    await expect(migration.up(knex)).resolves.not.toThrow();

    const row = await knex('solo_best_share').where({ id: 1 }).first();
    expect(row.best_share).toBe(4242);
    expect(row.found_at).toBeNull();
  });

  // A fresh install runs every migration in order, and this one must not care
  // whether the table it would like to read from happens to be there.
  it('runs on a database without the time series', async () => {
    await expect(migration.up(knex)).resolves.not.toThrow();

    const row = await knex('solo_best_share').where({ id: 1 }).first();
    expect(row.best_share).toBe(0);
  });
});
