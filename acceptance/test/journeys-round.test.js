// Offline tier: the round's ordering and its promise to leave the device in the
// right state, however the journeys went.
const test = require('node:test');
const assert = require('node:assert/strict');
const { runRound } = require('../journeys/round');

const journeys = [
  { id: '01-a', name: 'a' },
  { id: '02-b', name: 'b' },
  { id: '03-c', name: 'c' },
];

// Every collaborator logs its name; `fail` makes the named ones throw.
const make = ({ fail = [], results = {}, drift = [], finalErrors = [] } = {}) => {
  const calls = [];
  const rec = (name, value) => async (...args) => {
    calls.push(args[0]?.id ? `${name}:${args[0].id}` : name);
    if (fail.includes(name) || (args[0]?.id && fail.includes(`${name}:${args[0].id}`))) throw new Error(`${name} blew up`);
    return typeof value === 'function' ? value(...args) : value;
  };
  const deps = {
    snapshot: rec('snapshot', { snap: true }),
    runJourney: rec('run', (j) => results[j.id] || { id: j.id, name: j.name, ok: true, durationMs: 1 }),
    restore: rec('restore', { notes: [], errors: [] }),
    password: rec('password', { errors: [] }),
    minerOff: rec('minerOff', { errors: [], off: true }),
    finalCheck: rec('finalCheck', { errors: finalErrors, drift }),
  };
  return { calls, deps };
};

const TAIL = ['restore', 'password', 'minerOff', 'finalCheck'];

test('a clean round restores, hands the password back, stops the miner, then checks', async () => {
  const { calls, deps } = make();
  const r = await runRound({ journeys, deps });
  assert.deepEqual(calls, ['snapshot', 'run:01-a', 'run:02-b', 'run:03-c', ...TAIL]);
  assert.equal(r.exitCode, 0);
});

test('a journey that throws does not stop the round, and the tail still runs in order', async () => {
  const { calls, deps } = make({ fail: ['run:02-b'] });
  const r = await runRound({ journeys, deps });
  // restore after the failure, before the next journey
  assert.deepEqual(calls.slice(0, 5), ['snapshot', 'run:01-a', 'run:02-b', 'restore', 'run:03-c']);
  assert.deepEqual(calls.slice(-4), TAIL);
  assert.equal(r.journeys[1].ok, false);
  assert.match(r.journeys[1].error, /blew up/);
  assert.equal(r.exitCode, 1);
});

test('--bail stops at the first failure but still owes the device its state', async () => {
  const { calls, deps } = make({ fail: ['run:01-a'] });
  await runRound({ journeys, deps, bail: true });
  assert.ok(!calls.includes('run:02-b'));
  assert.deepEqual(calls.slice(-4), TAIL);
});

for (const broken of ['restore', 'password', 'minerOff', 'finalCheck']) {
  test(`when ${broken} throws, every step after it still runs`, async () => {
    const { calls, deps } = make({ fail: [broken] });
    const r = await runRound({ journeys: [journeys[0]], deps });
    assert.deepEqual(calls.slice(-4), TAIL);
    assert.equal(r.exitCode, 1);
    assert.ok(r.errors.some((e) => e.includes(`${broken} blew up`)), JSON.stringify(r.errors));
  });
}

test('everything failing at once still ends with the full tail', async () => {
  const { calls, deps } = make({ fail: ['run:01-a', 'restore', 'password', 'minerOff', 'finalCheck'] });
  const r = await runRound({ journeys: [journeys[0]], deps });
  assert.deepEqual(calls.filter((c) => TAIL.includes(c)).slice(-4), TAIL);
  assert.equal(r.exitCode, 1);
});

test('drift after the restore fails the round even when every journey passed', async () => {
  const { deps } = make({ drift: ['timezone Europe/Rome -> UTC'] });
  const r = await runRound({ journeys, deps });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.drift, ['timezone Europe/Rome -> UTC']);
});

test('a final-check error (miner still on) fails the round', async () => {
  const { deps } = make({ finalErrors: ['the miner is active at the end of the round'] });
  assert.equal((await runRound({ journeys, deps })).exitCode, 1);
});

test('skips are not passes: exit 3', async () => {
  const { deps } = make({ results: { '02-b': { id: '02-b', ok: false, skipped: 'no wifi', durationMs: 0 } } });
  const r = await runRound({ journeys, deps });
  assert.equal(r.exitCode, 3);
});

test('a skipped journey is not restored after, a failed one is', async () => {
  const { calls, deps } = make({ results: { '01-a': { id: '01-a', ok: false, skipped: 'x', durationMs: 0 } } });
  await runRound({ journeys: [journeys[0], journeys[1]], deps });
  assert.deepEqual(calls.slice(0, 4), ['snapshot', 'run:01-a', 'run:02-b', 'restore']);
});

test('if the snapshot cannot be taken, nothing runs and nothing is restored', async () => {
  const { calls, deps } = make({ fail: ['snapshot'] });
  await assert.rejects(() => runRound({ journeys, deps }), /snapshot blew up/);
  assert.deepEqual(calls, ['snapshot']);
});
