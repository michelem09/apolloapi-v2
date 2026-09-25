// tests/serviceStatusTimestamps.test.js
//
// One writer, one format: every service action puts milliseconds into
// requested_at, and the monitor's arithmetic runs on that.
//
// It is not a free choice. Node binds a Date to this column as an integer and
// the round trip works either way — but the suite runs under jsdom, where a
// jsdom Date fails knex's cross-realm instanceof check and is bound as the
// string "[object Object]". A Date written by a service is therefore fine on a
// device and unreadable here, which is a trap in both directions: a test that
// passes where the product is broken, or the reverse. Milliseconds behave the
// same in both realms.
jest.mock('child_process', () => ({ exec: jest.fn() }));

const { knex } = require('../src/db');

const makeSolo = require('../src/services/solo');

const readSolo = () =>
  knex('service_status').where({ service_name: 'solo' }).first();

describe('the timestamps a service action writes', () => {
  it('survives the round trip as a number the monitor can compare', async () => {
    await knex('service_status').where({ service_name: 'solo' }).del();
    await knex('service_status').insert({
      service_name: 'solo',
      status: 'offline',
      requested_status: null,
      requested_at: null,
    });

    const solo = makeSolo(knex, {});
    // Only the bookkeeping is under test; the shell and the wait are stubbed so
    // the write happens exactly as it does on a device.
    jest.spyOn(solo, '_execCommand').mockResolvedValue({ stdout: 'active', stderr: '' });
    jest.spyOn(solo, '_waitForActive').mockResolvedValue(true);

    await solo.start();

    const row = await readSolo();

    expect(typeof row.requested_at).toBe('number');
    // And it is this moment, not some epoch far away.
    expect(Math.abs(Date.now() - row.requested_at)).toBeLessThan(60000);
  });

  it('is what the grace-period arithmetic actually runs on', async () => {
    const row = await readSolo();

    // The monitor computes exactly this. NaN here is the whole defect: every
    // comparison against a window becomes false and nothing is ever protected.
    const timeSinceRequest = Date.now() - new Date(row.requested_at).getTime();

    expect(Number.isNaN(timeSinceRequest)).toBe(false);
    expect(timeSinceRequest).toBeGreaterThanOrEqual(0);
  });
});
