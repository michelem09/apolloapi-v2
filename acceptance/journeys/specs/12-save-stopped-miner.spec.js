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
// systemd `inactive` only: for the service monitor a `failed` unit whose requested
// status is online is `error`, never `offline`, so the UI would not show a stopped miner.
const SERVICES = '{ Services { stats { result { data { serviceName status } } error { message } } } }';

test('saving the pools while the miner is stopped keeps it stopped', async ({ j }) => {
  if (j.local) j.skip('needs a device: the state of the unit and the journal are the evidence');
  if (j.kind === 'solo-node') j.skip('a Solo Node has no internal miner and no pools tab');

  const state = () => j.probes.unitState(j.ssh, 'apollo-miner');
  // The two fixture workers: `<host>-test` and the plain `<host>` one.
  const testWorker = j.cfg.worker;
  const plainWorker = testWorker.replace(/-test$/, '');
  const alt = plainWorker === testWorker ? `${testWorker}-alt` : plainWorker;

  // The status the UI shows: the service monitor's, from the API (10 s tick). The API's
  // serviceName is `miner` (the systemd unit is apollo-miner).
  const apiStatus = async () => {
    const data = await j.gql(SERVICES);
    return (data.Services.stats.result?.data ?? []).find((x) => x.serviceName === 'miner')?.status ?? 'unknown';
  };
  const waitApiOffline = async (timeoutMs) => {
    let last = 'unknown';
    const r = await j.waitUntil(async () => (last = await apiStatus()) === 'offline', { timeoutMs, everyMs: 2000 });
    return { ok: r.ok, last };
  };

  await j.step('make sure the miner is stopped first', async () => {
    let s = await state();
    if (s === 'activating') {
      await j.waitUntil(async () => (await state()) !== 'activating', { timeoutMs: 150000, everyMs: 3000 });
      s = await state();
    }
    if (s !== 'inactive') {
      await j.gqlWrite('mutation { Miner { stop { error { message } } } }');
      const r = await j.waitUntil(async () => (await state()) === 'inactive', { timeoutMs: 120000, everyMs: 3000 });
      j.must(r.ok, `precondition not met: apollo-miner is ${await state()} and could not be brought to inactive before saving (not a build failure)`);
    }
  });
  await j.verify('the unit is inactive on the device', async () => {
    const s = await state();
    j.must(s === 'inactive', `apollo-miner is ${s}`);
    return s;
  });
  // Right after a stop the DB can still say `pending`, and the UI would render
  // "Save & Restart" on a correct build: wait for the monitor to say offline.
  await j.verify('the API reports the miner offline', async () => {
    const r = await waitApiOffline(40000);
    j.must(r.ok, `precondition not met: the API still reports apollo-miner ${r.last} 40 s after it stopped (not a build failure)`);
    return r.last;
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
    const names = async () => buttons.evaluateAll((els) => els.map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim()));
    // Bounded wait, not one read: the label follows the status pushed over WS.
    let last = [];
    const r = await j.waitUntil(async () => {
      last = await names().catch(() => []);
      return last.length === 1 && last[0] === 'Save';
    }, { timeoutMs: 20000, everyMs: 500 });
    j.must(r.ok, `the save button reads ${JSON.stringify(last)}, not "Save" (a stopped miner has nothing to restart)`);
  });

  const epoch = Number(await j.ssh('date +%s'));
  // A line in the journal inside the window, so an empty read can be told from an unreadable journal.
  const MARK = `j12-marker-${epoch}`;
  await j.ssh(`logger -t acceptance-j12 ${MARK} || true`);
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
      j.must(s === 'inactive', `apollo-miner became ${s} ${Math.round((Date.now() - t0) / 1000)} s after the save`);
      await new Promise((r) => setTimeout(r, 2500));
    }
    return `${seen.length} reads, all ${[...new Set(seen)].join('/')}`;
  });
  await j.verify('the journal shows no apollo-miner start since the save', async () => {
    // Prints the exit status last, so an unreadable journal is not read as "no starts".
    const read = async (args) => {
      const out = await j.ssh(`journalctl ${args} --since @${epoch} -o cat --no-pager 2>&1; echo "__rc=$?"`);
      const m = /__rc=(\d+)\s*$/.exec(out);
      return { rc: m ? Number(m[1]) : -1, text: m ? out.slice(0, m.index) : out };
    };
    const marker = await read('-t acceptance-j12');
    const miner = await read('-u apollo-miner');
    if (marker.rc !== 0 || !marker.text.includes(MARK) || miner.rc !== 0) {
      // The 45 s systemd watch above stays the gate; say plainly that this one did not look.
      const why = `journal check inconclusive: journalctl ${marker.rc !== 0 || miner.rc !== 0 ? `failed (rc ${marker.rc}/${miner.rc})` : 'does not show this journey\'s own marker'}`;
      j.finding(why);
      return why;
    }
    const starts = miner.text.split('\n').filter((l) => /^Start(ing|ed) apollo-miner/.test(l.trim()));
    j.must(!starts.length, `the journal shows a start: ${starts.join(' | ')}`);
    return 'journal readable, no start';
  });
});
