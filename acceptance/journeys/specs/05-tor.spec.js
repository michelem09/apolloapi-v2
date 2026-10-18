const { test } = require('../fixtures');
const C = require('../common');

// Journey 5 — Tor on, then off.
//
// On: api.conf gets onlynet=onion, and once Tor has bootstrapped the node
// advertises a .onion address. Off: the line is gone and so is the address.
// Bootstrapping takes minutes, so the deadline is explicit and generous.
test('tor on and off', async ({ j }) => {
  if ((await C.unit(j, 'node')) !== 'active') {
    j.skip('the node is not running (a device with no blockchain drive keeps it stopped on purpose)');
  }
  const wasOn = j.local ? false : await j.probes.torEnabled(j.ssh);
  if (wasOn) j.skip('Tor is already on at the start; this journey toggles it on and off and will not guess which state to leave');

  const toggle = async (label) => {
    await j.open('/settings/node');
    await j.page.getByText('TOR mode').waitFor({ timeout: 20000 });
    const input = j.page.locator('input[type="checkbox"]').first();
    const row = j.page.locator('label', { has: j.page.locator('input[type="checkbox"]') }).first();
    const before = await input.isChecked().catch(() => null);
    await row.click();
    const after = await input.isChecked().catch(() => null);
    j.must(before !== null && before !== after, `the Tor switch did not move (${before} → ${after})`);
    await j.shot(`tor-${label}`);
    const since = j.toastCount();
    await j.save();
    await j.settle(since, 12000);
  };

  await j.step('sign in', () => j.signIn());
  try {
    await j.step('switch Tor on and save', () => toggle('on'));
    await j.verify('api.conf has onlynet=onion', async () => {
      const r = await j.waitUntil(() => j.probes.torEnabled(j.ssh), { timeoutMs: 120000, everyMs: 4000 });
      j.must(r.ok, 'api.conf never got onlynet=onion');
    });
    await j.verify('the node is back and advertises a .onion address', async () => {
      await C.waitUnit(j, 'node', true, 360000);
      await C.waitNodeAnswering(j, 300000);
      const r = await j.waitUntil(async () => (await C.nodeNetwork(j)).addresses.some((a) => /\.onion$/.test(a)), { timeoutMs: 600000, everyMs: 15000 });
      j.must(r.ok, 'no .onion address within 10 minutes of Tor being switched on');
      return `after ${Math.round(r.waitedMs / 1000)} s`;
    });
    await j.step('the Node page shows it', async () => {
      await j.page.goto('/node');
      await j.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await j.shot('node-page-tor-on');
    });

    await j.step('switch Tor off and save', () => toggle('off'));
    await j.verify('api.conf is clean again', async () => {
      const r = await j.waitUntil(async () => !(await j.probes.torEnabled(j.ssh)), { timeoutMs: 120000, everyMs: 4000 });
      j.must(r.ok, 'onlynet=onion is still in api.conf');
    });
    await j.verify('the node is back with no .onion address', async () => {
      await C.waitUnit(j, 'node', true, 360000);
      await C.waitNodeAnswering(j, 300000);
      const r = await j.waitUntil(async () => !(await C.nodeNetwork(j)).addresses.some((a) => /\.onion$/.test(a)), { timeoutMs: 120000, everyMs: 10000 });
      j.must(r.ok, 'the node still advertises a .onion address');
    });
  } finally {
    if (!j.local) {
      try {
        if ((await C.currentSettings(j))?.nodeEnableTor || (await j.probes.torEnabled(j.ssh))) {
          await C.updateSettings(j, { nodeEnableTor: false });
          await C.restartNode(j);
        }
      } catch (err) {
        j.note('undoFailed', err.message);
        throw err;
      }
    }
  }
});
