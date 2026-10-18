// Offline tier: choosing journeys, and the report that is the point of a round.
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../journeys/registry');
const report = require('../journeys/report');

test('the journeys are the eight, in order', () => {
  assert.deepEqual(registry.list().map((j) => j.name), [
    'solo', 'pooled', 'padded', 'node-software', 'tor', 'wifi', 'units-timezone', 'password',
  ]);
});

test('--only takes short names, ids and prefixes, keeps file order, and refuses a typo', () => {
  const all = registry.list();
  assert.deepEqual(registry.select(all, 'password,solo').map((j) => j.name), ['solo', 'password']);
  assert.deepEqual(registry.select(all, '04-node-software').map((j) => j.name), ['node-software']);
  assert.deepEqual(registry.select(all, 'node').map((j) => j.name), ['node-software']);
  assert.equal(registry.select(all, null).length, 8);
  assert.throws(() => registry.select(all, 'sollo'), /no journey named "sollo"/);
});

const sample = () => ({
  exitCode: 1,
  errors: ['miner: boom'],
  drift: ['timezone A -> B'],
  restore: { notes: ['restored miner_config'] },
  miner: { off: true, was: 'active', scriptRan: true },
  password: { loginOk: true, linuxOk: true, reset: true },
  journeys: [
    {
      id: '02-pooled', name: 'pooled', ok: false, durationMs: 4200, error: 'no toast',
      steps: [{ name: 'save', ok: true, ms: 100 }, { name: 'miner_config', ok: false, device: true, ms: 50, detail: 'host is x' }],
      toasts: [{ at: 't+1.0s', text: 'Settings saved.' }, { at: 't+1.2s', text: 'Settings saved.' }, { at: 't+2s', text: '(empty toast)' }],
      consoleErrors: ['boom'],
      shots: ['/o/02-pooled-01-saved.png'],
    },
    { id: '06-wifi', name: 'wifi', ok: false, skipped: 'no ssid', durationMs: 0 },
  ],
});

test('a toast shown twice is called out, and so are empty ones and console errors', () => {
  assert.deepEqual(report.duplicateToasts(sample().journeys[0].toasts), [{ text: 'Settings saved.', count: 2 }]);
  const md = report.toMarkdown(sample(), { host: 'apollo2', durationMs: 5000 });
  assert.match(md, /2x "Settings saved\."/);
  assert.match(md, /\(empty toast\)/);
  assert.match(md, /Console errors:\n- boom/);
  assert.match(md, /02-pooled-01-saved\.png/);
});

test('the report says plainly what the end of the round found', () => {
  const md = report.toMarkdown(sample(), { host: 'apollo2' });
  assert.match(md, /\*\*FAIL\*\*/);
  assert.match(md, /miner: OFF .*miner_stop\.sh ran/);
  assert.match(md, /DRIFT after restore: timezone A -> B/);
  assert.match(md, /SKIP \(no ssid\)/);
  assert.match(md, /\[device\] miner_config/);
  const bad = sample();
  bad.miner = { off: false, scriptRan: false };
  bad.password = { loginOk: false, linuxOk: false };
  const md2 = report.toMarkdown(bad, {});
  assert.match(md2, /NOT OFF/);
  assert.match(md2, /DID NOT RUN/);
  assert.match(md2, /DOES NOT LOG IN/);
  assert.match(md2, /DOES NOT MATCH/);
});

test('a device check that did not run is shown as skipped, never as a pass', () => {
  const r = sample();
  r.journeys[0].steps = [{ name: 'miner_config', ok: null, device: true, ms: 0, detail: 'SKIPPED — no device in a local run' }];
  const md = report.toMarkdown(r, {});
  assert.match(md, /- – \[device\] miner_config/);
  assert.ok(!/- ✓ \[device\] miner_config/.test(md));
});
