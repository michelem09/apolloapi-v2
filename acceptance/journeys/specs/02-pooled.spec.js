const { test, expect } = require('../fixtures');
const P = require('../pools-ui');
const { poolList, waitUnit } = require('../common');

// Journey 2 — a pooled setup with a worker name of the user's choosing.
//
// Pick the pool from the list, change the username, save. What matters is that the
// miner was handed that worker: miner_config on disk, and the stat file the
// running miner writes once it is connected.
test('pooled mining with a changed worker', async ({ j }) => {
  if (j.kind === 'solo-node') j.skip('a Solo Node has no pools tab');
  const { poolOption, worker } = j.cfg;

  await j.step('sign in', () => j.signIn());
  await j.step('open Settings → Pools', () => P.openPools(j));
  await j.step('start from a different worker, so the save is a real change', () => P.avoidNoop(j, worker));
  await j.step('solo off, pick the pool, change the worker', async () => {
    await P.setSolo(j, false);
    await P.presetSelect(j.page).selectOption({ label: poolOption });
    await P.userInput(j.page).fill(worker);
    await j.shot('pooled-filled');
  });
  await j.step('save', async () => {
    await P.saveAndWait(j);
    await j.shot('saved');
  });

  await j.verify('the API holds the worker', async () => {
    const [main] = (await poolList(j)).sort((a, b) => a.index - b.index);
    j.must(main?.username === worker, `Pool.list username is ${JSON.stringify(main?.username)}`);
  });
  await j.verify('miner_config carries the pool and the worker', async () => {
    const r = await j.waitUntil(async () => {
      const a = (await j.probes.minerArgs(j.ssh));
      return [a.usb, a.iii].some((x) => x.user === worker);
    }, { timeoutMs: 60000, everyMs: 3000 });
    j.must(r.ok, 'neither miner_config nor miner_config3 has the worker');
    const a = await j.probes.minerArgs(j.ssh);
    const used = a.usb.user === worker ? a.usb : a.iii;
    j.must(/braiins/i.test(used.host || ''), `host is ${used.host}`);
    return `${used.host}:${used.port} as ${used.user}`;
  });
  await j.verify('the miner is running', async () => {
    const ms = await waitUnit(j, 'apollo-miner', true, 240000);
    return `active after ${Math.round(ms / 1000)} s`;
  });
  await j.verify('the stat file names the worker', async () => {
    const r = await j.waitUntil(async () => (await j.probes.statFileMentions(j.ssh, [worker]))[worker], { timeoutMs: 300000, everyMs: 10000 });
    j.must(r.ok, 'no miner stat file mentions the worker after 5 minutes');
    return `seen after ${Math.round(r.waitedMs / 1000)} s`;
  });
  await j.step('the page still shows what was saved', async () => {
    await P.openPools(j);
    await expect(P.userInput(j.page)).toHaveValue(worker);
    await j.shot('reloaded');
  });
});
