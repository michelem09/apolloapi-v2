const { test, expect } = require('../fixtures');
const P = require('../pools-ui');
const { poolList } = require('../common');

// Journey 3 — a custom pool typed with stray spaces at the edges.
//
// Both the URL and the worker are pasted with spaces around them, as they are
// when copied from a web page. The fields are cleaned when the user leaves them,
// nothing complains, and what is saved and written to miner_config has no spaces.
test('padded url and worker are cleaned', async ({ j }) => {
  if (j.kind === 'solo-node') j.skip('a Solo Node has no pools tab');
  const { paddedWorker, paddedUrl, paddedHost } = j.cfg;

  await j.step('sign in', () => j.signIn());
  await j.step('open Settings → Pools', () => P.openPools(j));
  await j.step('start from a different worker, so the save is a real change', () => P.avoidNoop(j, paddedWorker));
  await j.step('solo off, choose a custom pool', async () => {
    await P.setSolo(j, false);
    await P.presetSelect(j.page).selectOption({ label: 'Setup Custom Pool' });
  });
  await j.step('type the url and worker with spaces around them', async () => {
    await P.urlInput(j.page).fill(`  ${paddedUrl} `);
    await P.userInput(j.page).fill(` ${paddedWorker} `);
    await j.page.keyboard.press('Tab'); // leaving the field is what cleans it
    await j.page.waitForTimeout(500);
    await j.shot('padded-blurred');
  });
  await j.step('fields are trimmed and nothing is flagged', async () => {
    await expect(P.urlInput(j.page)).toHaveValue(paddedUrl);
    await expect(P.userInput(j.page)).toHaveValue(paddedWorker);
    j.must((await j.page.getByText(/Invalid pool URL/i).count()) === 0, 'the page says "Invalid pool URL"');
  });
  await j.step('save', async () => {
    await P.saveAndWait(j);
    j.must(!j.toasts().some((t) => /invalid|error|fail/i.test(t)), `an error toast appeared: ${JSON.stringify(j.toasts())}`);
    await j.shot('saved');
  });
  await j.step('after a reload the pool is still the clean one', async () => {
    await j.page.reload();
    await P.urlInput(j.page).waitFor({ timeout: 20000 });
    await expect(P.urlInput(j.page)).toHaveValue(paddedUrl);
    await expect(P.userInput(j.page)).toHaveValue(paddedWorker);
    await j.shot('reloaded');
  });

  await j.verify('the API holds no spaces', async () => {
    const [main] = (await poolList(j)).sort((a, b) => a.index - b.index);
    j.must(main.url === paddedUrl, `url is ${JSON.stringify(main.url)}`);
    j.must(main.username === paddedWorker, `username is ${JSON.stringify(main.username)}`);
  });
  await j.verify('miner_config has the clean host and worker', async () => {
    const r = await j.waitUntil(async () => {
      const a = await j.probes.minerArgs(j.ssh);
      return [a.usb, a.iii].some((x) => x.user === paddedWorker && x.host === paddedHost);
    }, { timeoutMs: 60000, everyMs: 3000 });
    j.must(r.ok, 'miner_config does not hold the trimmed host and worker');
  });
});
