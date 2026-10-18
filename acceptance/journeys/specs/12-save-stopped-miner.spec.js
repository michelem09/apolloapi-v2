const { test } = require('../fixtures');
const P = require('../pools-ui');

// Journey 12 — saving pool settings while the miner is stopped must not start it.
//
// NEW behaviour on v2.1.4, not deployed to the guinea-pig device yet: until it is,
// this journey is expected to FAIL at the "button reads exactly Save" step (the
// build still says "Save & Restart" and starts the miner on save). Once the build
// is out it must pass: the button says "Save", the toast says the miner is stopped
// and the settings apply on its next start, and the unit stays inactive.
//
// miner_start.sh waits ~35 s before it starts anything, so the unit is watched for
// 45 s after the save: a start would be visible as `activating` by then. The round's
// snapshot/restore puts the worker back; this journey never starts the miner.
const WATCH_MS = 45000;
const STOPPED = ['inactive', 'failed'];

test('saving the pools while the miner is stopped keeps it stopped', async ({ j }) => {
  if (j.local) j.skip('needs a device: the state of the unit and the journal are the evidence');
  if (j.kind === 'solo-node') j.skip('a Solo Node has no internal miner and no pools tab');

  const state = () => j.probes.unitState(j.ssh, 'apollo-miner');
  // The two fixture workers: `<host>-test` and the plain `<host>` one.
  const testWorker = j.cfg.worker;
  const plainWorker = testWorker.replace(/-test$/, '');
  const alt = plainWorker === testWorker ? `${testWorker}-alt` : plainWorker;

  await j.step('make sure the miner is stopped first', async () => {
    const s = await state();
    if (STOPPED.includes(s)) return;
    if (s === 'activating') await j.waitUntil(async () => (await state()) !== 'activating', { timeoutMs: 150000, everyMs: 3000 });
    await j.gqlWrite('mutation { Miner { stop { error { message } } } }');
    const r = await j.waitUntil(async () => STOPPED.includes(await state()), { timeoutMs: 120000, everyMs: 3000 });
    j.must(r.ok, 'could not bring the miner to a stop before saving');
  });
  await j.verify('the unit is inactive on the device', async () => {
    const s = await state();
    j.must(STOPPED.includes(s), `apollo-miner is ${s}`);
    return s;
  });

  await j.step('sign in', () => j.signIn());
  await j.step('open Settings → Pools', () => P.openPools(j));

  let worker;
  await j.step('change the worker to the other fixture worker', async () => {
    worker = (await P.userInput(j.page).inputValue()) === testWorker ? alt : testWorker;
    await P.userInput(j.page).fill(worker);
    await j.shot('worker-changed');
  });

  await j.step('the save button reads exactly "Save"', async () => {
    const buttons = j.page.getByRole('button', { name: /^Save/ });
    await buttons.first().waitFor({ timeout: 10000 });
    const names = (await buttons.evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())));
    j.must(names.length === 1 && names[0] === 'Save', `the save button reads ${JSON.stringify(names)}, not "Save" (a stopped miner has nothing to restart)`);
  });

  const epoch = Number(await j.ssh('date +%s'));
  let since;
  await j.step('save', async () => {
    since = j.toastCount();
    await j.save({ label: 'worker', stillThere: async () => (await P.userInput(j.page).inputValue()) === worker });
    await j.shot('saved');
  });
  await j.step('the toast says the miner is stopped', async () => {
    await j.waitForToast(/The miner is stopped/, { since, timeoutMs: 12000 });
  });

  await j.verify('miner_config carries the new worker', async () => {
    const r = await j.waitUntil(async () => {
      const a = await j.probes.minerArgs(j.ssh);
      return [a.usb, a.iii].some((x) => x.user === worker);
    }, { timeoutMs: 30000, everyMs: 2000 });
    j.must(r.ok, `neither miner_config nor miner_config3 has ${worker}`);
  });
  await j.verify(`apollo-miner stays stopped for ${WATCH_MS / 1000} s after the save`, async () => {
    const t0 = Date.now();
    const seen = [];
    while (Date.now() - t0 < WATCH_MS) {
      const s = await state();
      seen.push(s);
      j.must(STOPPED.includes(s), `apollo-miner became ${s} ${Math.round((Date.now() - t0) / 1000)} s after the save`);
      await new Promise((r) => setTimeout(r, 2500));
    }
    return `${seen.length} reads, all ${[...new Set(seen)].join('/')}`;
  });
  await j.verify('the journal shows no apollo-miner start since the save', async () => {
    const log = await j.ssh(`journalctl -u apollo-miner --since @${epoch} -o cat --no-pager 2>/dev/null || true`);
    const starts = log.split('\n').filter((l) => /^Start(ing|ed) apollo-miner/.test(l.trim()));
    j.must(!starts.length, `the journal shows a start: ${starts.join(' | ')}`);
  });
});
