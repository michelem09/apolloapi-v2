// Offline tier: the rules of a save (no browser).
const test = require('node:test');
const assert = require('node:assert/strict');
const { doSave } = require('../journeys/save');

// A bar that is busy for `busyPolls` polls after the click.
const run = async ({ busyPolls = 2, stillThere, never = false, label } = {}) => {
  const log = [];
  let clicked = false;
  let polls = 0;
  const findings = [];
  const waitUntil = async (probe) => {
    for (let i = 0; i < 20; i += 1) if (await probe()) return { ok: true, waitedMs: i };
    return { ok: false, waitedMs: 20 };
  };
  const args = {
    click: async () => { clicked = true; log.push('click'); },
    isBusy: async () => { polls += 1; return never || polls <= busyPolls; },
    stillThere,
    label,
    waitUntil,
    findings,
  };
  let result;
  let error = null;
  try { result = await doSave(args); } catch (e) { error = e; }
  return { log, clicked, polls, findings, result, error };
};

test('the save returns only once the bar is no longer busy', async () => {
  const r = await run({ busyPolls: 3 });
  assert.equal(r.result, true);
  assert.ok(r.polls >= 4, `polled ${r.polls} times: it must have waited out the busy bar`);
});

test('an edit lost before Save is a finding and nothing is clicked', async () => {
  const r = await run({ stillThere: async () => false, label: 'time zone Asia/Tokyo' });
  assert.equal(r.clicked, false);
  assert.match(r.error.message, /edit lost before save \(time zone Asia\/Tokyo\)/);
  assert.match(r.findings[0], /edit lost before save: time zone Asia\/Tokyo/);
});

test('an edit still in the form is saved', async () => {
  const r = await run({ stillThere: async () => true });
  assert.equal(r.clicked, true);
  assert.deepEqual(r.findings, []);
});

test('a bar that never closes is a finding, not an exception', async () => {
  const r = await run({ never: true });
  assert.equal(r.result, false);
  assert.equal(r.error, null);
  assert.match(r.findings[0], /still up/);
});
