const test = require('node:test');
const assert = require('node:assert');
const P = require('../journeys/pools-ui');

const fakeJ = (unit) => {
  const calls = [];
  return {
    calls,
    ssh: null,
    probes: { unitState: async () => unit },
    toastCount: () => 3,
    save: async () => calls.push('save'),
    settle: async () => calls.push('settle'),
    waitForToast: async (re, o) => calls.push(`toast ${re} since=${o.since}`),
    shot: async () => calls.push('shot'),
    page: {
      goto: async (u) => calls.push(`goto ${u}`),
      getByRole: (role, o) => ({ waitFor: async () => calls.push('wait Start'), click: async () => calls.push(`click ${o.name}`) }),
    },
  };
};

test('minerIsStopped: only active/activating count as running', async () => {
  assert.equal(await P.minerIsStopped(fakeJ('inactive')), true);
  assert.equal(await P.minerIsStopped(fakeJ('failed')), true);
  assert.equal(await P.minerIsStopped(fakeJ('active')), false);
  assert.equal(await P.minerIsStopped(fakeJ('activating')), false);
});

test('a stopped miner: toast asserted, then Start pressed on /miner', async () => {
  const j = fakeJ('inactive');
  await P.saveAndStartIfStopped(j, undefined, { wasStopped: true });
  assert.deepEqual(j.calls.filter((c) => !c.startsWith('shot')), ['save', 'toast /The miner is stopped/ since=3', 'goto /miner', 'wait Start', 'click /^Start$/']);
});

test('a running miner: no Start, no stopped-toast, just settle', async () => {
  const j = fakeJ('active');
  await P.saveAndStartIfStopped(j, undefined, { wasStopped: false });
  assert.deepEqual(j.calls, ['save', 'settle']);
});
