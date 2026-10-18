const { test, expect } = require('../fixtures');
const P = require('../pools-ui');
const { waitUnit } = require('../common');

// Journey 1 — solo mining with an address, on the real UI.
//
// A user turns solo on, pastes an address, saves, and expects to see their device
// hashing. The outcome is checked where it is true: ckpool is running with that
// address, the miner is up, and pool.status shows a rate and accepted shares —
// then the UI is asked whether it shows the same.
test('solo mining with an address', async ({ j }) => {
  if (j.kind === 'solo-node') j.skip('a Solo Node mines solo by construction; its page is not this one');
  const { soloAddress, mineDwellMs } = j.cfg;

  await j.step('sign in', () => j.signIn());
  await j.step('open Settings → Pools', () => P.openPools(j));
  await j.shot('pools-before');

  await j.step('switch solo on and enter the address', async () => {
    await P.setSolo(j, true);
    await P.walletInput(j.page).waitFor({ timeout: 10000 });
    await P.walletInput(j.page).fill(soloAddress);
    await j.shot('solo-filled');
  });
  await j.step('save', async () => {
    await P.saveAndWait(j);
    await j.shot('saved');
  });

  await j.verify('ckpool is running', async () => {
    const ms = await waitUnit(j, 'ckpool', true, 180000);
    return `active after ${Math.round(ms / 1000)} s`;
  });
  await j.verify('the address is what the device mines to', async () => {
    // ckpool.conf, or the miner's user name (solo pays to the user it is given).
    const conf = await j.probes.readFile(j.ssh, j.probes.PATHS.ckpoolConf);
    const args = await j.probes.minerArgs(j.ssh);
    const where = conf.includes(soloAddress) ? 'ckpool.conf'
      : [args.usb.user, args.iii.user].some((u) => (u || '').startsWith(soloAddress)) ? 'miner_config'
        : null;
    j.must(where, 'the address is in neither ckpool.conf nor miner_config');
    return `found in ${where}`;
  });
  await j.verify('the miner is running', async () => {
    const ms = await waitUnit(j, 'apollo-miner', true, 240000);
    return `active after ${Math.round(ms / 1000)} s`;
  });
  await j.verify('ckpool shows a hashrate', async () => {
    const r = await j.waitUntil(async () => (await j.probes.poolStatus(j.ssh)).hashrate1m > 0, { timeoutMs: 300000, everyMs: 10000 });
    j.must(r.ok, 'pool.status never showed a hashrate in 5 minutes');
    return `first rate after ${Math.round(r.waitedMs / 1000)} s`;
  });

  // Mining for a while is the point: a rate that appears and then dies is a miner
  // that connected once. An explicit dwell, not a guess at how long to wait.
  await j.step(`let it mine for ${Math.round(mineDwellMs / 1000)} s`, () => j.page.waitForTimeout(mineDwellMs));

  await j.verify('shares were accepted and the rate held', async () => {
    const s = await j.probes.poolStatus(j.ssh);
    j.must(s.accepted > 0, `no accepted shares (accepted=${s.accepted})`);
    j.must(s.hashrate1m > 0, 'the hashrate fell back to zero');
    return `accepted=${s.accepted} rejected=${s.rejected} rate1m=${s.hashrate1m}`;
  });

  await j.step('the UI shows the hashrate too', async () => {
    await j.page.goto('/solo-mining');
    await expect(j.page.locator('body')).toContainText(/[1-9][\d.]*\s*[KMGTP]?H\/s/i, { timeout: 60000 });
    await j.shot('solo-mining-page');
  });
});
