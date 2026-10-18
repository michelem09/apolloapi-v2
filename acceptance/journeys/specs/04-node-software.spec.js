const { test } = require('../fixtures');
const C = require('../common');

const ENUM = { core: { '28.1': 'core_28_1' }, knots: { '29.3': 'knots_29_3' } };

// Journey 4 — change the node software: Core 28.1 → Knots 29.3 → Core 28.1.
//
// A leg is: open Settings → Node, wait for the settings to arrive, pick the
// version, save. Each leg is judged by the binary on disk, by the version the
// running bitcoind reports over RPC, and by the setting the API now holds — the
// last one is what catches a selection the page silently undid.
test('node software: core → knots → core', async ({ j }) => {
  const { core, knots } = j.cfg.nodeLegs;

  if (!j.local && (await C.unit(j, 'node')) !== 'active') {
    j.skip('the node is not running (a device with no blockchain drive keeps it stopped on purpose)');
  }

  const legs = [];
  // Locally there is no binary to ask; the dev settings start on Core 28.1.
  const before = j.local ? { family: 'core', version: `${core}.0` } : await j.probes.bitcoindVersion(j.ssh);
  if (!j.probes.bitcoindIs(before, 'core', core)) legs.push({ family: 'core', version: core });
  legs.push({ family: 'knots', version: knots }, { family: 'core', version: core });
  j.note('versionAtStart', before);

  await j.step('sign in', () => j.signIn());

  try {
    for (const leg of legs) {
      const label = `${leg.family} ${leg.version}`;
      await j.step(`pick ${label} and save`, async () => {
        await j.open('/settings/node');
        await j.page.getByText('Node Software').waitFor({ timeout: 20000 });
        const re = new RegExp(`^\\s*${leg.version.replace('.', '\\.')}\\b`);
        const buttons = j.page.getByRole('button', { name: re });
        j.must((await buttons.count()) > 0, `no button for ${leg.version}`);
        // Core and Knots both list some versions; the family headers order them.
        await (leg.family === 'knots' ? buttons.last() : buttons.first()).click();
        await j.shot(`picked-${leg.family}-${leg.version}`);
        const since = j.toastCount();
        await j.save();
        await j.settle(since, 12000);
      });

      await j.verify(`the setting is ${label}`, async () => {
        const s = await C.currentSettings(j);
        j.must(s.nodeSoftware === ENUM[leg.family][leg.version], `Settings.nodeSoftware is ${s.nodeSoftware}`);
      });
      await j.verify(`bitcoind on disk is ${label}`, async () => {
        const r = await j.waitUntil(
          async () => j.probes.bitcoindIs(await j.probes.bitcoindVersion(j.ssh), leg.family, leg.version),
          { timeoutMs: 360000, everyMs: 5000 }
        );
        j.must(r.ok, `bitcoind -version is ${JSON.stringify(await j.probes.bitcoindVersion(j.ssh))}`);
        return `after ${Math.round(r.waitedMs / 1000)} s`;
      });
      await j.verify('the node is back and answering', async () => {
        const up = await C.waitUnit(j, 'node', true, 360000);
        const rpc = await C.waitNodeAnswering(j, 300000);
        const net = await C.nodeNetwork(j);
        const want = leg.family === 'knots' ? /knots/i : /satoshi/i;
        j.must(want.test(net.subversion || ''), `RPC reports ${net.subversion}`);
        j.must((net.subversion || '').includes(leg.version), `RPC version is ${net.subversion}, wanted ${leg.version}`);
        return `active ${Math.round(up / 1000)} s, RPC ${Math.round(rpc / 1000)} s, ${net.subversion}`;
      });
      await j.step('the Node page after the change', async () => {
        await j.page.goto('/node');
        await j.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        await j.shot(`node-page-${leg.family}`);
      });
    }
  } finally {
    // Whatever happened, do not leave the device on the other family. Through the
    // API, so it works when the UI is the thing that failed; the round's restore
    // puts the database back, but only this brings the binary back.
    if (!j.local) {
      try {
        const now = await j.probes.bitcoindVersion(j.ssh);
        if (!j.probes.bitcoindIs(now, 'core', core)) {
          await C.updateSettings(j, { nodeSoftware: ENUM.core[core] });
          await C.restartNode(j);
        }
      } catch (err) {
        j.note('undoFailed', err.message);
        throw err;
      }
    }
  }
});
