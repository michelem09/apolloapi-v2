const { test } = require('../fixtures');
const C = require('../common');

// Journey 9 — regression: Stop pressed while the miner is still starting.
//
// miner_start.sh sleeps ~35 s before it starts anything, so for that long the unit
// is `activating`, and systemd does not run ExecStop for a unit in that state:
// miner_stop.sh — the hashboard gpio reset on an Apollo II, the clean SIGTERM on an
// Apollo III — is skipped. Expected to FAIL on a build with the defect and pass once
// it is fixed. The outcome is read from the journal, not from the UI.
//
// If the unit was no longer `activating` when Stop was pressed, the run proved
// nothing about this defect: it is reported as inconclusive (a skip), never green.
test('stop while the miner is still starting', async ({ j }) => {
  if (j.local) j.skip('needs a device: the state of the unit and the journal are the evidence');
  if (j.kind === 'solo-node') j.skip('a Solo Node has no internal miner');

  const state = () => j.probes.unitState(j.ssh, 'apollo-miner');
  const start = j.page.getByRole('button', { name: /^Start$/ });
  const stop = j.page.getByRole('button', { name: /^Stop$/ });

  // Begin from a miner that is stopped, the clean way.
  await j.step('make sure the miner is stopped first', async () => {
    const s = await state();
    if (s === 'inactive' || s === 'failed') return;
    if (s === 'activating') await j.waitUntil(async () => (await state()) !== 'activating', { timeoutMs: 150000, everyMs: 3000 });
    await j.gqlWrite('mutation { Miner { stop { error { message } } } }');
    const r = await j.waitUntil(async () => ['inactive', 'failed'].includes(await state()), { timeoutMs: 120000, everyMs: 3000 });
    j.must(r.ok, 'could not bring the miner to a stop before starting');
  });

  await j.step('sign in and open the Miner page', async () => {
    await j.signIn();
    await j.page.goto('/miner');
    await start.waitFor({ timeout: 30000 });
    await j.shot('miner-stopped');
  });

  const epoch = Number(await j.ssh('date +%s'));
  const t0 = Date.now();
  await j.step('press Start', async () => { await start.click(); });

  let before = null;
  let stopAt = null;
  await j.step('wait for systemd to report activating, then press Stop', async () => {
    const seen = await j.waitUntil(async () => (await state()) === 'activating', { timeoutMs: 15000, everyMs: 700 });
    if (!seen.ok) return;
    await stop.waitFor({ state: 'visible', timeout: 8000 }).catch(() => {});
    // The state the click will land on, read as late as it can be.
    before = await state();
    stopAt = Date.now() - t0;
    if (before === 'activating') {
      await j.shot('about-to-stop');
      await stop.click();
    }
  });

  if (before !== 'activating') {
    j.finding(`inconclusive: the unit was ${before ?? 'never activating'} when Stop was pressed (${stopAt ?? '—'} ms after Start)`);
    j.skip(`inconclusive: systemd was not \`activating\` at the moment of Stop (state ${before ?? 'never seen'})`);
  }
  j.note('stopPressedAfterMs', stopAt);

  await j.verify('the miner ends up stopped', async () => {
    const r = await j.waitUntil(async () => ['inactive', 'failed'].includes(await state()), { timeoutMs: 150000, everyMs: 3000 });
    j.must(r.ok, `the miner is ${await state()} two and a half minutes after Stop`);
  });

  await j.verify('miner_stop.sh ran for that stop', async () => {
    const seen = j.probes.analyseStops(await j.ssh(`journalctl -u apollo-miner --since @${epoch} -o cat --no-pager 2>/dev/null || true`));
    j.must(seen.stops > 0, 'the journal shows no stop at all (volatile journal?)');
    j.must(!seen.lastSkipped, 'after "Stopping apollo-miner" there is no "Stopped" from miner_stop.sh: ExecStop was skipped, the board was not reset');
    return `${seen.stops} stop(s), ${seen.scripts} with the script's output`;
  });
});
