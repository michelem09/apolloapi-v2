// Exercises the REAL Apollo III stat-file parser in src/services/miner.js against
// the fixture: the sanitizing regexes, JSON.parse, the int_<key> renaming and the
// moment date handling all run here (previously this file re-implemented the
// rename and asserted on its own copy, testing no production code).
//
// The fixture is a real sample, captured from an Apollo III on 2026-07-28
// (statVersion 1.3, miner 3.0.1). Only the pool host and worker name are
// replaced; everything else is the hardware's own telemetry. Swapping the
// invented fixture for this one immediately contradicted three of the
// assumptions encoded here: the III reports one slot rather than four, has no
// comport, and does carry an empty slaves[].
const path = require('path');
const { knex } = require('../src/db');

// tests/setup.js globally mocks `fs`, so fs.promises.readFile returns canned
// content for any apollo-miner path — it never reads a real file. Feed the parser
// the actual fixture bytes (read with the real fs) so it runs on the true sample.
const fs = require('fs'); // the mocked module
const miner = require('../src/services/miner')(knex, {});
const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'apollo-miner-3.json');

describe('Apollo III stat fixture — real parser', () => {
  let parsed;

  beforeAll(async () => {
    const bytes = jest.requireActual('fs').readFileSync(FIXTURE_PATH);
    fs.promises.readFile.mockResolvedValueOnce(bytes); // real fixture → real parser
    parsed = await miner._parseStatFileEntry(FIXTURE_PATH, { version: 'v3', id: '3' });
  });

  it('parses cleanly and tags the source (uuid/version/date)', () => {
    expect(parsed).not.toBeNull();
    expect(parsed.uuid).toBe('3');
    expect(parsed.version).toBe('v3');
    expect(typeof parsed.date).toBe('string'); // moment-formatted
  });

  it('renames master/pool interval keys to int_<n> (the UI selector shape)', () => {
    expect(parsed.master.intervals.int_30.bySol).toBeDefined();
    expect(parsed.master.intervals.int_3600.bySol).toBeDefined();
    expect(parsed.master.intervals.int_3600.byPool).toBeDefined();
    expect(parsed.master.intervals.int_3600.chipSpeed).toBeDefined();
    expect(parsed.pool.intervals.int_0.sharesSent).toBeDefined();
    expect(parsed.pool.intervals.int_0.sharesAccepted).toBeDefined();
  });

  it('exposes the master scalars and pool identity the UI reads', () => {
    expect(parsed.master.boardsI).toBeDefined();
    expect(parsed.master.boardsW).toBeDefined();
    expect(parsed.master.wattPerGHs).toBeDefined();
    expect(parsed.master.upTime).toBeDefined();
    expect(parsed.pool.host).toBeDefined();
    expect(parsed.pool.port).toBeDefined();
    expect(parsed.pool.userName).toBeDefined();
    expect(parsed.pool.diff).toBeDefined();
  });

  // One slot, not four: the Apollo III presents its 21 chips as a single board.
  // The invented fixture assumed four hashboards, which is what an Apollo II with
  // several USB units looks like.
  it('contains a single internal hashboard under slots (int_0)', () => {
    expect(Object.keys(parsed.slots)).toEqual(['int_0']);
    const slot = parsed.slots.int_0;
    expect(slot.temperature).toBeDefined();
    expect(slot.errorRate).toBeDefined();
    expect(slot.chips).toBeDefined();
  });

  it('contains fan RPM array at int_0', () => {
    expect(Array.isArray(parsed.fans.int_0.rpm)).toBe(true);
    expect(parsed.fans.int_0.rpm.length).toBeGreaterThan(0);
  });

  it('contains top-level metadata (date, statVersion)', () => {
    expect(parsed.date).toBeDefined();
    expect(parsed.statVersion).toBeDefined();
    // No comport: that identifies the serial device a USB board is attached to,
    // and the Apollo III has none.
    expect(parsed.comport).toBeUndefined();
  });

  it('reports an empty slaves[] rather than omitting it', () => {
    // It is present and empty, not absent — the UI must not treat the key's
    // existence as evidence of chained units.
    expect(parsed.slaves).toEqual([]);
  });

  // New in statVersion 1.3 and not consumed yet: per-chip temperature spread
  // across the board, which is richer than the single figure in the slot.
  it('exposes the top-level temperature summary', () => {
    expect(parsed.temperature).toMatchObject({
      count: expect.any(Number),
      min: expect.any(Number),
      avr: expect.any(Number),
      max: expect.any(Number),
    });
  });
});
