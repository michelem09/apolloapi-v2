const { sshExec, sshWait } = require('../lib/ssh');
const { gql } = require('../lib/api');
const { waitUntil } = require('../lib/wait');

const uptimeOf = async (profile) =>
  Number((await sshExec(profile, 'cut -d. -f1 /proc/uptime')).stdout);

// Last, and on purpose: it is the only check that takes the device away, and
// everything before it has already proven the parts it will need on the way up.
module.exports = {
  name: 'reboot',
  risk: 5,
  async run({ profile, token, assert, reopenTunnel }) {
    const before = await uptimeOf(profile);
    assert(before > 0, `the device has been up ${Math.round(before / 60)} min`);

    await gql(profile, token, `mutation { Mcu { reboot { error { message } } } }`);

    // It has to actually go away: a reboot that returns a clean answer and
    // leaves the device untouched would pass every check below.
    const went = await waitUntil(
      async () => {
        try {
          return (await uptimeOf(profile)) < before;
        } catch {
          return true; // unreachable: it is on its way down
        }
      },
      { timeoutMs: 120000, everyMs: 5000 }
    );
    assert(went.ok, 'the device went down');

    const attempts = await sshWait(profile, { attempts: 60, everyMs: 5000 });
    assert(attempts > 0, `ssh answered again after ~${attempts * 5}s`);

    const after = await uptimeOf(profile);
    assert(after < before, `uptime restarted (${after}s)`);

    // The old tunnel went down with the device.
    const port = await reopenTunnel();
    assert(!!port, `the tunnel is back on 127.0.0.1:${port}`);

    // Coming back is not the same as coming back working.
    const services = ['apollo-api', 'apollo-ui-v2', 'node'];
    for (const unit of services) {
      const up = await waitUntil(
        async () => (await sshExec(profile, `systemctl is-active ${unit} || true`)).stdout === 'active',
        { timeoutMs: 180000, everyMs: 5000 }
      );
      assert(up.ok, `${unit} came back (${Math.round(up.waitedMs / 1000)}s)`);
    }

    const health = await waitUntil(
      async () => {
        try {
          const r = await fetch(`${profile.apiBase}/health`).then((x) => x.json());
          return r.status === 'OK';
        } catch {
          return false;
        }
      },
      { timeoutMs: 120000, everyMs: 5000 }
    );
    assert(health.ok, '/health answers again');

    return { rebooted: true };
  },
};
