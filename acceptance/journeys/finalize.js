// The two things a round owes the device, however it went: the miner OFF, and
// the original password WORKING. Both take their collaborators as arguments, so the order and the
// "even when everything before it blew up" property can be tested without a
// device (test/journeys-round.test.js).
const { analyseStops } = require('./probes');

const JOURNAL = (since) => `journalctl -u apollo-miner --since @${since} -o cat --no-pager 2>/dev/null || true`;

// Off means off all the way, not "systemctl stopped asking".
//
// A unit still `activating` is the trap: systemd does not run ExecStop for it,
// so miner_stop.sh — the hashboard gpio reset on an Apollo II, the clean SIGTERM
// on an Apollo III — is skipped, and the hardware is left half-way. miner_start.sh
// sleeps ~35 s before it starts anything, so a stop request ~10 s after a start
// lands exactly there. So: wait until it is no longer activating, stop through the
// API (which also records that offline was requested, so the service monitor does
// not fight it), wait for inactive, and read the journal since `roundSince` (or
// since this stop): if the LAST stop of the round never printed the script's
// closing line, the board was not reset — run the script by hand and say so.
const ensureMinerOff = async ({
  state, stop, waitUntil, deviceEpoch, journal, runStopScript, roundSince = null,
  activatingMs = 150000, stopMs = 120000,
}) => {
  const result = { was: await state(), stopped: false, scriptRan: null, remedied: false, notes: [], errors: [] };

  if (result.was === 'activating' || result.was === 'reloading') {
    const settled = await waitUntil(async () => !['activating', 'reloading'].includes(await state()), {
      timeoutMs: activatingMs,
      everyMs: 3000,
    });
    if (!settled.ok) {
      result.notes.push(`still activating after ${activatingMs / 1000} s; stopping anyway`);
    }
  }

  const since = roundSince ?? (await deviceEpoch());
  let off;
  const now = await state();
  if (now === 'inactive' || now === 'failed') {
    result.notes.push(`already ${now}`);
    off = true;
  } else {
    try {
      const how = await stop();
      if (typeof how === 'string') result.notes.push(how);
    } catch (err) {
      result.errors.push(`Miner.stop: ${err.message}`);
    }
    const down = await waitUntil(async () => ['inactive', 'failed'].includes(await state()), {
      timeoutMs: stopMs,
      everyMs: 3000,
    });
    result.stopped = down.ok;
    if (!down.ok) result.errors.push(`the miner is still ${await state()} ${stopMs / 1000} s after the stop`);
    off = down.ok;
  }

  if (off) {
    const seen = analyseStops(await journal(since));
    result.stopsSeen = seen.stops;
    if (seen.stops > 0) {
      result.scriptRan = !seen.lastSkipped;
      if (seen.lastSkipped) {
        const what = 'the last stop skipped miner_stop.sh (a stop of a unit that was still activating, or the journal is gone)';
        if (runStopScript) {
          try {
            await runStopScript();
            result.remedied = true;
            result.notes.push(`${what}: ran miner_stop.sh by hand, the board is reset`);
          } catch (err) {
            result.errors.push(`${what}; running it by hand failed: ${err.message}`);
          }
        } else {
          result.errors.push(`miner_stop.sh did not log its closing "Stopped": ${what}`);
        }
      }
    }
  }
  return { ...result, off };
};

// The original password has to work in BOTH places: the dashboard (a hash in the
// database) and the Linux user (what ssh and sudo check). Restoring the database
// puts back the first and not the second, so a round that touched the password
// sets it again through the API unconditionally rather than trusting that a login
// check — which only reads the database — tells the whole story.
const ensurePassword = async ({ touched, login, change, linuxMatches }) => {
  const result = { touched, reset: false, loginOk: false, linuxOk: null, errors: [] };

  let needs = touched;
  if (!needs) {
    try { needs = !(await login()); } catch (err) { result.errors.push(`login check: ${err.message}`); needs = true; }
  }
  if (needs) {
    try {
      await change();
      result.reset = true;
    } catch (err) {
      result.errors.push(`changePassword(original): ${err.message}`);
    }
  }

  try { result.loginOk = !!(await login()); } catch (err) { result.errors.push(`final login: ${err.message}`); }
  if (!result.loginOk) result.errors.push('the original password does not log in');

  if (linuxMatches) {
    try {
      result.linuxOk = !!(await linuxMatches());
      if (!result.linuxOk) result.errors.push('the Linux user does not have the original password');
    } catch (err) {
      result.errors.push(`linux password check: ${err.message}`);
    }
  }
  return { ...result, ok: result.errors.length === 0 };
};

module.exports = { ensureMinerOff, ensurePassword, JOURNAL };
