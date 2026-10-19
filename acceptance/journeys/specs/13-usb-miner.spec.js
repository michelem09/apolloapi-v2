const { test } = require('../fixtures');
const U = require('../usb');

// Journey 13 — a USB hashboard is unplugged and plugged back in.  OPT-IN.
//
// Runs only when asked for, because it needs a USB miner physically attached:
//
//   node acceptance/journeys.js --profile acceptance/profiles/solonode.json --only usb-miner
//   node acceptance/journeys.js --profile acceptance/profiles/apollo2.json  --only usb-miner
//   … --only usb-miner --with usb-expiry      also waits out the 15-minute expiry (~20 min more)
//   … --with usb-miner                        adds it to the default round
//
// What kind of device it is comes from the device (/etc/armbian-release), not from
// the profile: a Solo Node is the case with no internal board, an Apollo II is the
// case where the internal board must keep mining while the USB one comes and goes.
// The device must carry /var/lib/apollo/ACCEPTANCE_OK like for every journey.
//
// The cable is never touched, and `authorized` is never written (that wedged the
// board, "Unknown board", until a physical replug). An unplug is a driver unbind:
// `echo 3-1.1:1.0 > /sys/bus/usb/drivers/cdc_acm/unbind` on the board's USB
// INTERFACE, over ssh with `sudo -n`; the tty and the miner on it are gone in seconds.
// A replug is the matching `bind`, and the miner mines again ~20-30 s later. The
// interface name is the last component of `readlink -f /sys/class/tty/ttyACMn/device`;
// its PARENT device must be 0483:5740 with the chosen board's serial and a product
// that reads SLV, apollo-miner must be active, and the interface must be bound to
// cdc_acm right now (checked here, and again by the shell that writes), otherwise the
// journey FAILS without writing anything: one level higher is the hub, with the
// Bluetooth and Home Assistant sticks. The interface is recorded in <out>/usb.unplugged
// BEFORE the unbind; the journey binds it back in a `finally`, and the round's restore
// does it again from that file if the journey died (journeys/deps.js). A board left
// unbound (or authorized=0 by an older run) by a killed run is put back at the start
// of the next round. A plug while the miner is stopped is not an unbind (an idle
// board wedges when toggled): the tty's udev add event is emitted again.
//
// Skips (never fails): the API has no `Miner.boards` ("feature not on this build"),
// or no USB board is listed active ("no USB miner attached"). A board that is
// listed but not mining (the round leaves the miner OFF) is started first, through
// the API, as a precondition.
//
// Steps: 1 the UI shows the board as USB (and the internal one as Internal);
// 2 unplug -> disconnected within ~15 s, toast, warning indicator, "Active 0/n",
// Start/Restart disabled on a Solo Node, the unit gone, the internal board
// untouched; 3 replug -> mining again, one process, one instance; 4 Stop from the UI,
// a udev add event re-emitted while stopped: it does NOT start, Start from the UI: it mines;
// 5 (--with usb-expiry) 15 minutes unplugged: the board disappears and a Solo Node
// UI goes back to solo-only without a reload.

const BOARDS = `{ Miner { boards { result {
  boards { id serial kind port status mining since expiresAt }
  hasMiner hasUsbMiners usbCount usbActiveCount deviceFamily
} error { message } } } }`;

const MS = 1000;

test('usb-miner: unplug and replug a USB hashboard', async ({ j }) => {
  if (j.local) j.skip('needs a device: sysfs, systemd and the process list are the evidence');

  const longStep = (j.ctx.options || []).includes('usb-expiry');
  // The default 25 minutes are for steps 1-4; the expiry wait is 15 more.
  test.setTimeout(longStep ? 55 * 60 * MS : 25 * 60 * MS);

  // A Solo Node has no internal board; an Apollo II has one that must keep mining
  // while the USB one comes and goes. An Apollo III with a USB board is not covered
  // here yet (its internal board has no comport and no stat-file join).
  if (j.kind === 'apollo-iii') j.skip('an Apollo III with a USB board is not supported by this journey yet');
  const solo = j.kind === 'solo-node';
  const expectInternal = j.kind === 'apollo-legacy';
  const rig = U.createUsbRig({
    ssh: j.ssh,
    markerPath: U.markerFile(j.ctx.out),
    healthPath: U.healthFile(j.ctx.out),
    waitUntil: j.waitUntil,
  });

  const readBoards = async () => {
    const out = (await j.gql(BOARDS)).Miner.boards;
    j.must(!out.error, `Miner.boards: ${out.error?.message}`);
    return out.result;
  };

  // ---- feature detection and the board to work with
  let first;
  try {
    first = await readBoards();
  } catch (err) {
    if (U.isBoardsMissing(err)) j.skip('feature not on this build: the API has no Miner.boards');
    throw err;
  }
  const listed = U.usbBoards(first.boards);
  const chosen = listed.find((b) => b.status === 'active');
  if (!chosen) {
    // A board a killed run left unplugged is not "no USB miner attached": say so.
    const orphans = await U.findOrphans(j.ssh);
    const left = [...orphans.deauthorized.map((o) => `${o.serial || o.dir} (authorized=0)`), ...orphans.unbound.map((o) => `${o.serial || o.iface} (${o.iface} has no driver)`)];
    j.must(left.length === 0, `a 0483:5740 board was left unplugged, probably by a killed run: ${left.join(', ')} — run: ${U.MANUAL_RESTORE}`);
    j.skip(`no USB miner attached (USB boards listed: ${listed.length ? listed.map((b) => `${b.id} ${b.status}`).join(', ') : 'none'})`);
  }
  const boardId = chosen.id;
  // Port names are not stable across a reset or an unplug: the board is its USB
  // serial, and `tty` is re-resolved from sysfs (refreshTty) before each use.
  const serial = chosen.serial || chosen.id;
  let tty = U.ttyOf(chosen.port);
  j.must(!!tty, `the active USB board ${boardId} has no ttyACM port (${chosen.port})`);

  // ---- what the device says
  const unit = () => `apollo-usb-miner@${tty}`;
  const readPort = async () => U.portFor(U.parsePortList(await j.ssh(U.PORT_LIST_CMD)), serial);
  const refreshTty = async () => {
    const p = await readPort();
    if (p) tty = p.tty;
    return p;
  };
  const unitActive = async () => { await refreshTty(); return j.probes.unitState(j.ssh, unit()); };
  const procs = async () => U.parseMinerProcs(await j.ssh('ps -eo pid=,comm=,args='));
  // Every active USB instance and every miner process on a ttyACM port, against what
  // the API says: a leftover on the OLD port name after ttyACM0 -> ttyACM1 shows here.
  const running = async () => ({
    units: U.activeUnitNames(await j.ssh(U.USB_UNITS_CMD)),
    procs: (await procs()).filter((p) => /ttyACM\d+$/.test(p.comport || '')),
  });
  const activeUsbCount = async () => U.usbBoards((await readBoards()).boards).filter((b) => b.status === 'active').length;
  const expectRunning = async (expected, what) => {
    const bad = U.instanceMismatch({ ...(await running()), expected });
    j.must(!bad, `${what}: ${bad}`);
    return `${expected} instance(s) and process(es), no strays`;
  };
  const usbProcs = async () => { await refreshTty(); return U.procsOn(await procs(), tty); };
  const minerUnit = () => j.probes.unitState(j.ssh, 'apollo-miner');
  const boardOnBus = async () => !!(await readPort());
  const minerShow = async () =>
    j.probes.parseShow(await j.ssh('systemctl show apollo-miner -p MainPID -p ActiveEnterTimestampMonotonic'));

  const board = async () => (await readBoards()).boards.find((b) => b.id === boardId) || null;
  const adopt = (b) => { const t = b && U.ttyOf(b.port); if (t) tty = t; };
  const waitBoard = async (pred, { timeoutMs, everyMs = 2000 }) => {
    let last = null;
    const r = await j.waitUntil(async () => {
      // One dropped connection is not "not yet".
      try { last = await board(); } catch (err) { if (U.isTransient(err)) return false; throw err; }
      adopt(last);
      return pred(last);
    }, { timeoutMs, everyMs });
    return { ok: r.ok, last, waitedMs: r.waitedMs };
  };
  // The reset cycle of a stop: IAP at once, SLV ~30 s later. Nothing is unplugged
  // before the board reads SLV and has been stable for 5 s (`since`: the stop).
  const settled = async (since, minMs) => {
    const r = await U.waitSlvStable({ read: readPort, since, minMs, timeoutMs: 90 * MS });
    j.must(r.ok, `the board never finished its reset cycle: ${r.reason}`);
    tty = r.tty;
    return `SLV on ${r.tty} after ${Math.round(r.waitedMs / MS)} s${r.sawReset ? ' (reset seen)' : ''}`;
  };
  // Why a board does not mine, from the journal.
  const journalSince = async (epoch) => U.pickJournal(await j.ssh(U.journalCommand(epoch))).join(' | ') || '(no relevant journal lines)';
  const describe = (b) => (b ? `${b.status}${b.mining ? ', mining' : ', not mining'}` : 'not listed');

  // ---- what the UI says
  const indicator = () => j.page.locator('[data-testid="usb-miners-indicator"]:visible').first();
  const indicatorState = async () => {
    if (!(await indicator().count())) return null;
    const text = await indicator().innerText().catch(() => '');
    const bg = await indicator().evaluate((e) => getComputedStyle(e).backgroundColor).catch(() => '');
    return { count: U.leadingInt(text), orange: U.isOrange(bg) };
  };
  const tooltip = async () => {
    await indicator().hover();
    const tip = j.page.locator('[role="tooltip"]').first();
    await tip.waitFor({ state: 'visible', timeout: 5000 });
    const text = await tip.innerText();
    await j.page.mouse.move(0, 0);
    return text;
  };
  const navMiner = () => j.page.locator('a[href$="/miner"]:visible');
  const btn = (name) => j.page.getByRole('button', { name: new RegExp(`^${name}$`) });
  // The tags and the "Active a/t" badge sit in the Hashboards card; if the tags are
  // not on the page itself, the drawer behind "Show all data" is read as well.
  const boardsUi = async () => {
    const read = async () => ({
      // The board tags are Chakra Tags, but this build renders them without the
      // `chakra-tag` class: read every span whose whole text is a tag word.
      tags: await j.page.locator('span:visible').evaluateAll((els) =>
        els.map((e) => (e.innerText || '').trim()).filter((t) => /^(USB|Internal|Disconnected)$/.test(t))),
      text: await j.page.locator('body').innerText(),
    });
    let r = await read();
    if (!r.tags.some((t) => /^(USB|Internal)$/.test(t))) {
      const open = j.page.getByRole('button', { name: /Show all data/ });
      if (await open.count()) {
        await open.first().click();
        await j.page.waitForTimeout(800);
        r = await read();
        await j.page.keyboard.press('Escape');
        await j.page.waitForTimeout(400);
      }
    }
    return { ...r, badges: U.activeBadges(r.text), hashboards: U.hashboardsBadge(r.text) };
  };
  const waitUi = async (name, probe, timeoutMs, everyMs = 1000) => {
    let last;
    const r = await j.waitUntil(async () => { last = await probe(); return !!last; }, { timeoutMs, everyMs });
    j.must(r.ok, `${name} did not happen within ${timeoutMs / MS} s`);
    return last;
  };

  // The internal board of an Apollo II: its process and the miner unit must be the
  // same ones before and after (a gpio reset would restart both).
  let internalBefore = null;
  const internalSnapshot = async () => ({
    pids: U.internalProcs(await procs()).map((p) => p.pid).sort(),
    unit: await minerShow(),
  });
  const assertInternalUntouched = async () => {
    const now = await internalSnapshot();
    j.must(JSON.stringify(now.pids) === JSON.stringify(internalBefore.pids),
      `the internal miner process changed: ${internalBefore.pids} -> ${now.pids}`);
    j.must(now.unit.ActiveEnterTimestampMonotonic === internalBefore.unit.ActiveEnterTimestampMonotonic,
      'apollo-miner was restarted (ActiveEnterTimestampMonotonic moved)');
    const b = (await readBoards()).boards.find((x) => x.kind === 'internal');
    j.must(b && b.status === 'active' && b.mining, `the internal board is ${describe(b)}`);
    return `pids ${now.pids.join(',') || '-'}, apollo-miner MainPID ${now.unit.MainPID}`;
  };

  try {
    // ---------------------------------------------------------------- precondition
    await j.step('make sure the USB board is mining', async () => {
      if (chosen.mining) return;
      await j.gqlWrite('mutation { Miner { start { error { message } } } }');
      const r = await waitBoard((b) => !!b && b.status === 'active' && b.mining, { timeoutMs: 240 * MS, everyMs: 4000 });
      j.must(r.ok, `precondition not met: after Miner.start the USB board is ${describe(r.last)} (not a build failure)`);
    });
    await j.verify('the board is mining on the device: one instance, one process, no strays', async () => {
      return expectRunning(await activeUsbCount(), 'at the start');
    });
    if (expectInternal) {
      await j.verify('the API lists the internal board, mining (an Apollo II must have one)', async () => {
        // Its stat file appears ~35 s after a start: wait, then fail, never skip.
        const r = await j.waitUntil(async () => {
          try {
            const b = (await readBoards()).boards.find((x) => x.kind === 'internal');
            return !!b && b.status === 'active' && b.mining;
          } catch (err) { if (U.isTransient(err)) return false; throw err; }
        }, { timeoutMs: 150 * MS, everyMs: 4000 });
        j.must(r.ok, 'an Apollo II must list an active, mining internal board and the API does not');
        internalBefore = await internalSnapshot();
        j.must(internalBefore.pids.length >= 1, 'the API lists an internal board but no futurebit-miner runs on it');
        return `pids ${internalBefore.pids.join(',')}`;
      });
    }

    // ---------------------------------------------------------------- 1: the UI
    await j.step('sign in', () => j.signIn());
    if (solo) {
      await j.step('Settings: a Miner tab, no Pools tab', async () => {
        await j.page.goto('/settings/system');
        await j.page.getByRole('tab', { name: /System/ }).waitFor({ timeout: 30000 });
        // The Miner tab follows the live board list, which lands a moment after
        // the first paint (right after sign-in it is not there yet).
        await j.page.getByRole('tab', { name: /^Miner$/ }).waitFor({ timeout: 30000 }).catch(() => {});
        const names = (await j.page.getByRole('tab').allInnerTexts()).map((t) => t.trim());
        await j.shot('settings-tabs');
        j.must(names.some((t) => /^Miner$/.test(t)), `no Miner tab (tabs: ${names.join(', ')})`);
        j.must(!names.some((t) => /^Pools$/.test(t)), `a Solo Node shows a Pools tab (tabs: ${names.join(', ')})`);
      });
    }
    await j.step('open the Miner page and wait for the live board list', async () => {
      await j.page.goto('/miner');
      await waitUi('the USB indicator', async () => (await indicator().count()) > 0, 45 * MS);
    });
    await j.step('the nav has Miner, the indicator counts the board, the board is tagged USB', async () => {
      j.must((await navMiner().count()) > 0, 'no Miner item in the navigation');
      const st = await indicatorState();
      j.must(st && st.count >= 1, `the USB indicator reads ${st?.count}`);
      j.must(!st.orange, 'the indicator is in the warning state with the board plugged in');
      const ui = await boardsUi();
      await j.shot('miner-page');
      j.must(ui.tags.includes('USB'), `no USB tag (tags: ${ui.tags.join(' | ')})`);
      // Plugged in: the Hashboards card reads Active n/n, n >= 1.
      j.must(ui.hashboards && ui.hashboards.active === ui.hashboards.total && ui.hashboards.total >= 1,
        `the Hashboards badge reads ${JSON.stringify(ui.hashboards)}, expected Active n/n with the board plugged in`);
      if (expectInternal) j.must(ui.tags.includes('Internal'), `no Internal tag (tags: ${ui.tags.join(' | ')})`);
      j.must(!ui.tags.includes('Disconnected'), 'a Disconnected tag with the board plugged in');
    });

    // ---------------------------------------------------------------- 2: unplug
    await j.verify('the board is in its miner firmware (SLV) and stable', () => settled(Date.now(), 0));
    let at = 0;
    let since = 0;
    await j.step('unplug: cdc_acm unbind of the board interface', async () => {
      since = j.toastCount();
      at = Date.now();
      const dir = await rig.unplug(tty, serial);
      j.note('unboundInterface', dir);
    });
    await j.verify('the tty is gone: the driver let go of the board', async () => {
      const gone = await j.waitUntil(async () => !(await boardOnBus()), { timeoutMs: 15 * MS, everyMs: 1000 });
      j.must(gone.ok, `/dev/${tty} is still there 15 s after the unbind`);
      return `/dev/${tty} gone after ${Math.round(gone.waitedMs / MS)} s`;
    });
    await j.verify('the API lists the board as disconnected, expiring in ~15 minutes', async () => {
      const r = await waitBoard((b) => !!b && b.status === 'disconnected', { timeoutMs: 20 * MS, everyMs: 1000 });
      j.must(r.ok, `20 s after the unplug the API says ${describe(r.last)}`);
      const now = Number(await j.ssh('date +%s')) * MS;
      j.must(U.expiresAround(r.last, now), `expiresAt ${r.last.expiresAt} is ${Math.round((U.msUntilExpiry(r.last, now) ?? NaN) / 60000)} min away, not ~15`);
      return `disconnected after ${Math.round((Date.now() - at) / MS)} s, expires in ${Math.round(U.msUntilExpiry(r.last, now) / 60000)} min`;
    });
    await j.step('UI: toast, warning indicator with the detail, Disconnected tag, Active 0/n', async () => {
      await j.waitForToast(/USB miner was disconnected/i, { since, timeoutMs: 20 * MS });
      const st = await waitUi('the warning indicator', async () => {
        const s = await indicatorState();
        return s && s.orange ? s : null;
      }, 20 * MS);
      const tip = await tooltip();
      await j.shot('unplugged');
      j.must(/USB miners? disconnected/.test(tip) && /disconnected since/.test(tip), `the tooltip does not list the board: ${JSON.stringify(tip)}`);
      const ui = await boardsUi();
      j.must(ui.tags.includes('Disconnected'), `no Disconnected tag (tags: ${ui.tags.join(' | ')})`);
      // Disconnected boards stay in the denominator: Active 0/1 (Solo Node), 1/2 (Apollo II).
      j.must(ui.hashboards && ui.hashboards.active < ui.hashboards.total,
        `the Hashboards badge reads ${JSON.stringify(ui.hashboards)}, expected a < t (all badges: ${JSON.stringify(ui.badges)})`);
      return st;
    });
    if (solo) {
      await j.step('Solo Node, no other board: Start is disabled and says why', async () => {
        const start = btn('Start');
        await start.waitFor({ state: 'visible', timeout: 60 * MS });
        j.must(await start.isDisabled(), 'Start is enabled with no USB miner connected');
        await start.locator('xpath=..').hover();
        await j.page.getByText('No USB miner connected', { exact: true }).first().waitFor({ state: 'visible', timeout: 5000 });
        await j.page.mouse.move(0, 0);
        await j.shot('start-disabled');
      });
    }
    await j.verify('device: instance gone, apollo-miner still active, no miner on any USB port', async () => {
      j.must((await minerUnit()) === 'active', `apollo-miner is ${await minerUnit()}`);
      return expectRunning(await activeUsbCount(), 'after the unplug');
    });
    if (expectInternal) {
      await j.verify('the internal board kept mining, process and unit untouched', assertInternalUntouched);
    }

    // ---------------------------------------------------------------- 3: replug
    await j.step('replug: cdc_acm bind of the board interface', async () => {
      const back = await rig.replug();
      j.must(back.errors.length === 0, back.errors.join('; '));
      j.must(back.restored, 'nothing was recorded as unbound');
    });
    await j.verify('the API: active and mining again within 60 s', async () => {
      const r = await waitBoard((b) => !!b && b.status === 'active' && b.mining, { timeoutMs: 60 * MS, everyMs: 2000 });
      j.must(r.ok, `60 s after the replug the API says ${describe(r.last)}`);
      return `${describe(r.last)} after ${Math.round(r.waitedMs / MS)} s`;
    });
    await j.verify('the device: one instance, one process, none left on the old port name', async () => {
      j.must((await unitActive()) === 'active', `${unit()} is ${await unitActive()}`);
      return expectRunning(await activeUsbCount(), 'after the replug');
    });
    await j.step('UI: the indicator is back to normal, no Disconnected tag', async () => {
      await waitUi('the indicator back to normal', async () => {
        const s = await indicatorState();
        return s && !s.orange && s.count >= 1 ? s : null;
      }, 30 * MS);
      const ui = await boardsUi();
      await j.shot('replugged');
      j.must(!ui.tags.includes('Disconnected'), 'the Disconnected tag is still there');
      j.must(ui.tags.includes('USB'), `no USB tag after the replug (tags: ${ui.tags.join(' | ')})`);
    });
    if (expectInternal) {
      await j.verify('the internal board is still untouched after the replug', assertInternalUntouched);
    }

    // ---------------------------------------------------------------- 4: stopped
    let stopAt = 0;
    await j.step('Stop from the UI', async () => {
      stopAt = Date.now();
      await btn('Stop').click();
    });
    await j.verify('the instance and the miner stop', async () => {
      const r = await j.waitUntil(async () => { const x = await running(); return x.units.length === 0 && x.procs.length === 0; },
        { timeoutMs: 60 * MS, everyMs: 2000 });
      j.must(r.ok, `after Stop: ${JSON.stringify((await running()).units)} still active, ${(await running()).procs.length} process(es)`);
      const m = await j.waitUntil(async () => ['inactive', 'failed'].includes(await minerUnit()), { timeoutMs: 120 * MS, everyMs: 3000 });
      j.must(m.ok, `apollo-miner is ${await minerUnit()} after Stop`);
    });
    // The stop reset the board: IAP now, SLV in ~30 s. Unplugging inside that
    // window leaves it wedged until it is physically replugged.
    await j.verify('the board finished the reset the stop caused (SLV, stable, ~35 s after the stop)', () => settled(stopAt, 35 * MS));
    // NOT an unbind: toggling an idle board (miner stopped, after miner_stop's reset)
    // wedges it until a physical replug, a simulation artifact.
    // The plug is simulated for udev only: the tty's add event is emitted again.
    await j.step('a plug event while stopped (udev add re-emitted for the board)', async () => {
      await refreshTty();
      await rig.reemit(tty, serial);
    });
    await j.verify('the plug event does NOT start the board (Requisite): 45 s with no instance and no process', async () => {
      const t0 = Date.now();
      let reads = 0;
      while (Date.now() - t0 < 45 * MS) {
        reads += 1;
        // `failed` is fine (a Requisite refusal can leave it so): active/activating is not.
        // Any USB instance or process, on any port name: none may exist.
        const x = await running();
        const at2 = Math.round((Date.now() - t0) / MS);
        j.must(x.units.length === 0, `${x.units.join(', ')} became active ${at2} s after the plug event`);
        j.must(x.procs.length === 0, `${x.procs.length} futurebit-miner process(es) on a USB port ${at2} s after the plug event`);
        await new Promise((r) => setTimeout(r, 3000));
      }
      return `${reads} reads, never active`;
    });
    await j.verify('the API: the board is active and not mining', async () => {
      const r = await waitBoard((b) => !!b && b.status === 'active' && !b.mining, { timeoutMs: 60 * MS, everyMs: 3000 });
      j.must(r.ok, `the API says ${describe(r.last)}, expected active and not mining`);
      return describe(r.last);
    });
    let startedAt = 0;
    await j.step('Start from the UI', async () => {
      const start = btn('Start');
      await start.waitFor({ state: 'visible', timeout: 60 * MS });
      j.must(await start.isEnabled(), 'Start is disabled with the board plugged in');
      await j.shot('before-start');
      startedAt = Math.floor(Date.now() / MS);
      await start.click();
    });
    // Mining is judged by the API; when it does not come, the journal says why
    // (apollo-helper "Unknown board", instance exit 64) and goes in the message.
    const mustMine = async (epoch, timeoutMs, what) => {
      const t0 = Date.now();
      const r = await waitBoard((b) => !!b && b.status === 'active' && b.mining, { timeoutMs, everyMs: 3000 });
      if (r.ok) {
        // `mining` can still be true from the stat file the stop left behind (fresh
        // for 15 s), while the new instance sits in its settle: wait for the process.
        const expected = await activeUsbCount();
        const left = Math.max(timeoutMs - (Date.now() - t0), 15 * MS);
        await j.waitUntil(async () => !U.instanceMismatch({ ...(await running()), expected }), { timeoutMs: left, everyMs: 3000 });
      }
      if (!r.ok) {
        throw new Error(`${what}: not mining after ${timeoutMs / MS} s (API: ${describe(r.last)}; ${unit()} ${await unitActive()}); journal: ${await journalSince(epoch)}`);
      }
      j.must((await unitActive()) === 'active', `${unit()} is ${await unitActive()}`);
      return `mining after ${Math.round(r.waitedMs / MS)} s; ${await expectRunning(await activeUsbCount(), what)}`;
    };
    await j.verify('the board mines again: one instance, one process', () =>
      mustMine(startedAt, solo ? 60 * MS : 150 * MS, 'after Start'));

    // ---- 4b: Stop, then Start at once. The stop resets the board (IAP for ~30 s);
    // with apollo-miner active again, udev starts the instance on the SLV add.
    let quickEpoch = 0;
    let stopClickedAt = 0;
    await j.step('Stop, then Start within a few seconds (the board is still in its bootloader)', async () => {
      stopClickedAt = Date.now();
      await btn('Stop').click();
      const start = btn('Start');
      // A UI that is slow to flip is not a board that fails: say which it was.
      const shown = await start.waitFor({ state: 'visible', timeout: 15 * MS }).then(() => true).catch(() => false);
      j.must(shown, "the UI's Start button did not appear within 15 s of Stop (UI / service-monitor timing, not the board)");
      const enabled = await j.waitUntil(async () => start.isEnabled(), { timeoutMs: 15 * MS, everyMs: 500 });
      // The board's state at the moment of the click: sysfs product and the API.
      const port = await readPort().catch(() => null);
      const b = await board().catch(() => null);
      const info = `sysfs ${port ? port.product || port.state : 'not on the bus'}, API ${describe(b)}`;
      j.note('quickStartAt', info);
      j.finding(`Start pressed ${Math.round((Date.now() - stopClickedAt) / MS)} s after Stop, board: ${info}`);
      j.must(enabled.ok, `the UI's Start button stayed disabled for 15 s after Stop (UI timing, not the board; ${info})`);
      quickEpoch = Math.floor(Date.now() / MS) - 20;
      await start.click({ timeout: 5000 });
    });
    await j.verify('it still ends up mining within 90 s (a failure here is a product defect)', () =>
      mustMine(quickEpoch, 90 * MS, 'Stop then quick Start'));

    // ---------------------------------------------------------------- 5: expiry
    if (longStep) {
      let overviewHadMiner = false;
      await j.step('go to the overview (client-side, no reload) and look at the layout', async () => {
        await j.page.locator('a[href$="/overview"]:visible').first().click();
        await j.page.waitForURL(/\/overview/, { timeout: 15000 });
        await j.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        overviewHadMiner = /Miner hashrate|Miner temperature/.test(await j.page.locator('body').innerText());
        await j.shot('overview-with-miner');
        if (solo) j.must(overviewHadMiner, 'the overview of a Solo Node with a miner shows no miner cards: the "gone" check below would prove nothing');
      });
      await j.verify('the board is in its miner firmware (SLV) and stable', () => settled(Date.now(), 0));
      await j.step('unplug and leave it unplugged until it expires', async () => {
        await rig.unplug(tty, serial);
      });
      await j.verify('the board is listed disconnected, then removed after ~15 minutes', async () => {
        const gone = await j.waitUntil(async () => (await board()) === null, { timeoutMs: 17 * 60 * MS, everyMs: 15 * MS });
        j.must(gone.ok, 'the board is still listed 17 minutes after the unplug');
        return `removed after ${Math.round(gone.waitedMs / 60000 * 10) / 10} min`;
      });
      await j.step('UI: the layout follows without a reload', async () => {
        if (solo) {
          await waitUi('the Miner item leaving the navigation', async () => (await navMiner().count()) === 0, 30 * MS);
          const text = await j.page.locator('body').innerText();
          j.must(!/Miner hashrate|Miner temperature/.test(text), 'the overview still shows miner cards');
        } else {
          await waitUi('the USB indicator leaving the bar', async () => (await indicator().count()) === 0, 30 * MS);
        }
        await j.shot('expired');
      });
      await j.step('replug after the expiry', async () => {
        const back = await rig.replug();
        j.must(back.errors.length === 0 && back.restored, back.errors.join('; ') || 'nothing was recorded as unbound');
      });
      await j.verify('the board comes back and mines (the miner was running)', async () => {
        const r = await waitBoard((b) => !!b && b.status === 'active' && b.mining, { timeoutMs: 120 * MS, everyMs: 3000 });
        j.must(r.ok, `the API says ${describe(r.last)}`);
        return expectRunning(await activeUsbCount(), 'after the expiry replug');
      });
      await j.step('UI: the Miner item and the indicator are back, still without a reload', async () => {
        await waitUi('the indicator', async () => (await indicator().count()) > 0, 45 * MS);
        if (solo) await waitUi('the Miner item', async () => (await navMiner().count()) > 0, 30 * MS);
        await j.shot('back');
      });
    }
  } finally {
    // Whatever happened above, the board is bound again. The round's restore
    // does the same from the marker file if this process did not get here.
    if (!j.local) {
      try {
        const back = await rig.replug();
        if (back.errors.length) j.note('undoFailed', back.errors.join('; '));
        else if (back.restored) j.note('reboundInFinally', true);
      } catch (err) {
        j.note('undoFailed', err.message);
      }
    }
  }
});
