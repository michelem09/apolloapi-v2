// Offline tier: the miner check with its three collaborators replaced by fakes.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const lib = (name) => path.resolve(__dirname, '../lib', name + '.js');
const fake = (name, exports) => {
  require.cache[lib(name)] = { id: lib(name), filename: lib(name), loaded: true, exports };
};

// `answers` maps "stop"/"start" to the payload `error` the fake API returns.
const load = ({ answers = {}, calls }) => {
  fake('ssh', {
    sshExec: async (_p, cmd) => {
      calls.push(`ssh ${cmd}`);
      return { stdout: 'active' };
    },
  });
  fake('api', {
    gql: async () => ({ Pool: { list: { result: { pools: [] } } } }),
    gqlWrite: async (_p, _t, doc) => {
      const action = /(stop|start)/.exec(doc)[1];
      calls.push(`write ${action}`);
      return { Miner: { [action]: { error: answers[action] ?? null } } };
    },
  });
  fake('wait', {
    waitUntil: async (fn) => {
      calls.push('wait');
      return { ok: true, waitedMs: 0 };
    },
  });
  delete require.cache[require.resolve('../checks/miner.js')];
  return require('../checks/miner.js');
};

const run = (check) => {
  const results = [];
  const assertFn = (ok, what) => {
    results.push([ok, what]);
    if (!ok) throw new Error(what);
  };
  return check.run({
    profile: {},
    token: 't',
    assert: assertFn,
    skip: (why) => ({ skipped: why }),
    device: { hasInternalMiner: true },
  });
};

test('a refusal in the stop payload fails at once, without waiting on systemd', async () => {
  const calls = [];
  const check = load({ answers: { stop: { message: 'permission denied' } }, calls });
  await assert.rejects(run(check), /Miner\.stop was accepted \(permission denied\)/);
  assert.ok(!calls.includes('wait'), 'no polling after a refused stop');
  assert.ok(!calls.includes('write start'));
});

test('a refusal in the start payload fails at once too', async () => {
  const calls = [];
  const check = load({ answers: { start: { message: 'unit masked' } }, calls });
  await assert.rejects(run(check), /Miner\.start was accepted \(unit masked\)/);
  assert.equal(calls.filter((c) => c === 'wait').length, 1, 'only the stop was waited on');
});

test('clean answers run the whole check (the pool lookup resolves gql)', async () => {
  const calls = [];
  const check = load({ calls });
  const out = await run(check);
  // no enabled pool with a port: skipped, not a ReferenceError on `gql`
  assert.deepEqual(out, { skipped: 'no enabled pool with a port in its URL — nothing to watch for' });
});
