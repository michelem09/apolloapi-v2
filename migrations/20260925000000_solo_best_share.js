// The best share the device has ever found, kept where ckpool cannot lose it.
//
// ckpool's pool-level `bestshare` lives in logs/pool/pool.status and counts the
// current run only: every `systemctl restart ckpool` — a node software switch, a
// settings change, the unit's own Restart=always — puts it back to zero, and the
// headline on the solo page went with it. ckpool does keep a per-user `bestever`
// in logs/users/<wallet> and reloads it at startup, but that file is outside the
// checkout and can be lost with a reinstall, and our own reader drops it once it
// is a day old.
//
// One row, id 1. The value only ever rises: a reset of ckpool must never lower
// what the device has actually found.
// SQLite's CURRENT_TIMESTAMP is UTC with nothing to say so — '2026-09-12
// 22:15:00' — and moment in the browser reads a string in that shape as local
// time. Copied verbatim into this table, a seeded record would be dated by the
// device's own offset and could show the wrong day. The runtime writes ISO with
// a Z, so the seed does too: one format in the column, one reading of it.
const toIsoUtc = (value) => {
  if (!value) return null;

  const parsed =
    value instanceof Date
      ? value
      : (() => {
          const text = String(value);
          return text.includes('T') || text.endsWith('Z')
            ? new Date(text)
            : new Date(`${text.replace(' ', 'T')}Z`);
        })();

  // An unparseable timestamp must not take the device down with it. Migrations
  // run from init.js before the server is required, so a RangeError thrown by
  // .toISOString() on an Invalid Date fails `migrate:latest` and the API never
  // starts — over a date on a card. Seeding the record without one is the worst
  // this is allowed to cost.
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
};

exports.up = async function up(knex) {
  await knex.schema.createTable('solo_best_share', (table) => {
    table.integer('id').primary();
    table.float('best_share').notNullable().defaultTo(0);
    table.datetime('found_at');
  });

  // Seed from what was already sampled. time_series_solo_data holds up to 30
  // days of that same per-run figure, taken once a minute, so a device that has
  // been mining starts from its own record instead of from zero.
  let best = null;
  if (await knex.schema.hasTable('time_series_solo_data')) {
    // Oldest first among equals: the record was set the first time that figure
    // appeared, and every sample after it merely repeats the same number.
    best = await knex('time_series_solo_data')
      .whereNotNull('bestshare')
      .orderBy([
        { column: 'bestshare', order: 'desc' },
        { column: 'createdAt', order: 'asc' },
      ])
      .first();
  }

  await knex('solo_best_share').insert({
    id: 1,
    best_share: best?.bestshare || 0,
    found_at: best?.bestshare ? toIsoUtc(best.createdAt) : null,
  });
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('solo_best_share');
};
