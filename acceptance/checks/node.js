const { sshExec } = require('../lib/ssh');
const { gql } = require('../lib/api');
const { waitUntil } = require('../lib/wait');

const isActive = (profile, unit) => async () =>
  (await sshExec(profile, `systemctl is-active ${unit} || true`)).stdout === 'active';

// Stopping and starting bitcoind. Slower than the miner and more disruptive —
// a node that comes back has to re-establish its peers — so it sits after it.
module.exports = {
  name: 'node',
  risk: 3,
  async run({ profile, token, assert, skip }) {
    const active = isActive(profile, 'node');

    // A device with no blockchain drive keeps the node deliberately stopped —
    // that is a supported configuration, not a fault, and failing here would
    // also abort every riskier check behind it.
    if (!(await active())) {
      return skip('the node is not running — expected on a device with no blockchain drive');
    }
    assert(true, 'the node is running before we touch it');

    await gql(profile, token, `mutation { Node { stop { error { message } } } }`);
    const stopped = await waitUntil(async () => !(await active()), { timeoutMs: 120000, everyMs: 5000 });
    // bitcoind flushes on the way down and can take a while; the window is
    // generous so that an expiry means something.
    assert(stopped.ok, `systemd reports the node stopped (${Math.round(stopped.waitedMs / 1000)}s)`);

    await gql(profile, token, `mutation { Node { start { error { message } } } }`);
    const started = await waitUntil(active, { timeoutMs: 180000, everyMs: 5000 });
    assert(started.ok, `systemd reports the node running again (${Math.round(started.waitedMs / 1000)}s)`);

    // Running is not the same as answering: the UI reads the node through RPC,
    // and a bitcoind still loading the block index answers nothing.
    const answering = await waitUntil(async () => {
      try {
        const data = await gql(
          profile,
          token,
          `{ Node { stats { result { stats { blockchainInfo { blocks headers } } } error { message } } } }`
        );
        return (data.Node.stats.result?.stats?.blockchainInfo?.blocks ?? 0) > 0;
      } catch (err) {
        // Only a device that is not ready yet is worth waiting for.
        if (err.malformed) throw err;
        return false;
      }
    }, { timeoutMs: 240000, everyMs: 10000 });
    assert(answering.ok, `the node answers RPC again (${Math.round(answering.waitedMs / 1000)}s)`);

    return { restored: true };
  },
};
