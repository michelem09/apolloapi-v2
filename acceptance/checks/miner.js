const { sshExec } = require('../lib/ssh');
const { gql } = require('../lib/api');
const { waitUntil } = require('../lib/wait');

const isActive = (profile, unit) => async () =>
  (await sshExec(profile, `systemctl is-active ${unit} || true`)).stdout === 'active';

// Stops and starts the thing the device exists to do. Reversible, but it costs
// real hashrate while it runs, so it sits after the cheap checks.
module.exports = {
  name: 'miner',
  risk: 2,
  async run({ profile, token, assert, skip, device }) {
    if (!device.hasInternalMiner) {
      return skip(`a ${device.kind} has no internal miner to stop`);
    }

    const active = isActive(profile, 'apollo-miner');
    assert(await active(), 'the miner is running before we touch it');

    // A query, not a mutation: Miner.start/stop/restart are still under Query,
    // unlike wifi* and setTimezone. Noted, not worked around — the suite drives
    // the schema the device actually serves.
    await gql(profile, token, `{ Miner { stop { error { message } } } }`);
    const stopped = await waitUntil(async () => !(await active()), { timeoutMs: 60000 });
    assert(stopped.ok, 'systemd reports the miner stopped');

    await gql(profile, token, `{ Miner { start { error { message } } } }`);
    // miner_start.sh enumerates boards and waits on them: ~35 s on an Apollo III,
    // measured, so the window is minutes rather than seconds.
    const started = await waitUntil(active, { timeoutMs: 180000, everyMs: 5000 });
    assert(started.ok, `systemd reports the miner running again (${Math.round(started.waitedMs / 1000)}s)`);

    // Running is not the same as mining: the proof is a live connection to the
    // pool. Which port that is comes from the device's own configuration —
    // hardcoding 3333/3334 would fail every device pointed at a pool on 443 or
    // 21496, and fail it for three minutes before saying so.
    const pools = await gql(profile, token, `{ Pool { list { result { pools { url enabled } } error { message } } } }`);
    const ports = (pools.Pool.list.result?.pools ?? [])
      .filter((p) => p.enabled)
      .map((p) => (String(p.url).match(/:(\d+)\s*$/) || [])[1])
      .filter(Boolean);

    if (!ports.length) {
      return skip('no enabled pool with a port in its URL — nothing to watch for');
    }

    const pattern = ports.map((p) => `:${p}`).join('\\|');
    const pool = await waitUntil(async () => {
      const { stdout } = await sshExec(
        profile,
        `sudo ss -tn state established 2>/dev/null | grep -c "${pattern}" || true`
      );
      return Number(stdout) > 0;
    }, { timeoutMs: 180000, everyMs: 5000 });
    assert(pool.ok, `the miner reconnected to its pool on ${ports.join('/')} (${Math.round(pool.waitedMs / 1000)}s)`);

    return { restored: true };
  },
};
