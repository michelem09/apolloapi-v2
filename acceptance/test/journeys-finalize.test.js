// Offline tier: the two obligations at the end of a round.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ensureMinerOff, ensurePassword } = require('../journeys/finalize');

// A miner as systemd treats it: stopping a unit that is still `activating` does
// NOT run ExecStop, so miner_stop.sh never logs its closing line.
const model = ({ start, activatingPolls = 2, stopRefused = false }) => {
  const m = { s: start, polls: 0, log: [], lines: [], stopCalls: 0, manual: 0 };
  m.state = async () => m.s;
  m.stop = async () => {
    m.stopCalls += 1;
    m.log.push(`stop while ${m.s}`);
    if (stopRefused) return;
    m.lines.push('Stopping apollo-miner.');
    if (m.s === 'active') m.lines.push('Stopped'); // ExecStop ran: the script's closing line
    m.lines.push('Stopped apollo-miner.');
    m.s = 'inactive';
  };
  // Polling advances the model: activating settles into active after a few polls.
  m.waitUntil = async (probe) => {
    for (let i = 0; i < 50; i += 1) {
      if (await probe()) return { ok: true, waitedMs: i * 3000 };
      if (m.s === 'activating' && ++m.polls >= activatingPolls) m.s = 'active';
    }
    return { ok: false, waitedMs: 150000 };
  };
  m.args = () => ({
    state: m.state,
    stop: m.stop,
    waitUntil: m.waitUntil,
    deviceEpoch: async () => 1000,
    journal: async () => m.lines.join('\n'),
    runStopScript: async () => { m.manual += 1; },
  });
  return m;
};

test('a miner that is mid-start is allowed to finish starting before it is stopped', async () => {
  const m = model({ start: 'activating' });
  const r = await ensureMinerOff(m.args());
  assert.deepEqual(m.log, ['stop while active']);
  assert.equal(r.off, true);
  assert.equal(r.scriptRan, true);
  assert.deepEqual(r.errors, []);
});

test('a stop that lands on an activating unit is caught: the stop script did not run', async () => {
  // The same miner, with the wait removed from the procedure's side.
  const m = model({ start: 'activating' });
  m.waitUntil = async (probe) => ((await probe()) ? { ok: true, waitedMs: 0 } : { ok: false, waitedMs: 0 });
  const r = await ensureMinerOff(m.args());
  assert.equal(m.log[0], 'stop while activating');
  assert.equal(r.scriptRan, false);
  // The device is left reset anyway: the script is run by hand, and the report says so.
  assert.equal(m.manual, 1);
  assert.equal(r.remedied, true);
  assert.match(r.notes.join(), /ran miner_stop\.sh by hand/);
  assert.deepEqual(r.errors, []);
});

test('without a way to run the script by hand, a skipped stop script is an error', async () => {
  const m = model({ start: 'activating' });
  m.waitUntil = async (probe) => ((await probe()) ? { ok: true, waitedMs: 0 } : { ok: false, waitedMs: 0 });
  const args = m.args();
  delete args.runStopScript;
  const r = await ensureMinerOff(args);
  assert.match(r.errors.join(), /miner_stop\.sh did not log/);
});

test('a miner already stopped by a journey that skipped the script is still remedied', async () => {
  // The defect happened mid-round (journey 9); by the end the unit is inactive.
  const m = model({ start: 'inactive' });
  m.lines.push('Stopping apollo-miner.', 'Stopped apollo-miner.');
  const r = await ensureMinerOff({ ...m.args(), roundSince: 500 });
  assert.equal(m.stopCalls, 0);
  assert.equal(m.manual, 1);
  assert.equal(r.remedied, true);
});

test('a stop whose script did run is not remedied', async () => {
  const m = model({ start: 'inactive' });
  m.lines.push('Stopping apollo-miner.', 'Stopped', 'Stopped apollo-miner.');
  const r = await ensureMinerOff({ ...m.args(), roundSince: 500 });
  assert.equal(m.manual, 0);
  assert.equal(r.scriptRan, true);
});

test('running the script by hand failing is an error', async () => {
  const m = model({ start: 'inactive' });
  m.lines.push('Stopping apollo-miner.', 'Stopped apollo-miner.');
  const r = await ensureMinerOff({ ...m.args(), runStopScript: async () => { throw new Error('boom'); } });
  assert.match(r.errors.join(), /by hand failed: boom/);
});

test('an active miner is stopped and its stop script is confirmed', async () => {
  const m = model({ start: 'active' });
  const r = await ensureMinerOff(m.args());
  assert.equal(m.stopCalls, 1);
  assert.equal(r.off, true);
  assert.equal(r.scriptRan, true);
});

test('an already stopped miner is left alone', async () => {
  const m = model({ start: 'inactive' });
  const r = await ensureMinerOff(m.args());
  assert.equal(m.stopCalls, 0);
  assert.equal(r.off, true);
});

test('a miner that will not stop is reported, not assumed off', async () => {
  const m = model({ start: 'active', stopRefused: true });
  const r = await ensureMinerOff(m.args());
  assert.equal(r.off, false);
  assert.match(r.errors.join(), /still active/);
});

test('a stop the API refuses is an error but the wait still happens', async () => {
  const m = model({ start: 'active' });
  const args = m.args();
  args.stop = async () => { throw new Error('refused'); };
  const r = await ensureMinerOff(args);
  assert.match(r.errors.join(), /Miner\.stop: refused/);
  assert.equal(r.off, false);
});

const pw = ({ loginResults, touched, changeThrows = false, linux = true }) => {
  const calls = [];
  const queue = [...loginResults];
  return {
    calls,
    args: {
      touched,
      login: async () => { calls.push('login'); return queue.length > 1 ? queue.shift() : queue[0]; },
      change: async () => { calls.push('change'); if (changeThrows) throw new Error('nope'); },
      linuxMatches: async () => { calls.push('linux'); return linux; },
    },
  };
};

test('a round that touched the password sets the original again even though login already works', async () => {
  // Restoring the database puts the old hash back, so a login check passes while
  // the Linux user may still have the temporary password.
  const p = pw({ touched: true, loginResults: [true] });
  const r = await ensurePassword(p.args);
  assert.ok(p.calls.includes('change'));
  assert.equal(r.ok, true);
});

test('a round that never touched it does not rewrite a working password', async () => {
  const p = pw({ touched: false, loginResults: [true] });
  const r = await ensurePassword(p.args);
  assert.ok(!p.calls.includes('change'));
  assert.equal(r.ok, true);
});

test('an untouched round with a password that fails to log in repairs it', async () => {
  const p = pw({ touched: false, loginResults: [false, true] });
  const r = await ensurePassword(p.args);
  assert.ok(p.calls.includes('change'));
  assert.equal(r.ok, true);
});

test('failing to restore the password is an error, and the checks still run', async () => {
  const p = pw({ touched: true, loginResults: [false], changeThrows: true });
  const r = await ensurePassword(p.args);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /changePassword\(original\): nope/);
  assert.match(r.errors.join(), /does not log in/);
  assert.ok(p.calls.includes('linux'));
});

test('the Linux user disagreeing with the dashboard is an error', async () => {
  const p = pw({ touched: true, loginResults: [true], linux: false });
  const r = await ensurePassword(p.args);
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /Linux user/);
});
