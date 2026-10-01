const { sshExec } = require('../lib/ssh');
const { gql } = require('../lib/api');

// Reads only. If any of this is wrong, nothing after it is worth running.
module.exports = {
  name: 'preflight',
  risk: 0,
  async run({ profile, token, assert }) {
    const data = await gql(profile, token, `{
      Mcu { stats { result { stats { hostname } } error { message } } }
      Services { stats { result { data { serviceName status } } error { message } } }
    }`);

    const hostname = data.Mcu.stats.result?.stats?.hostname;
    assert(!!hostname, `the API reports a hostname (${hostname})`);

    const { stdout: real } = await sshExec(profile, 'hostname');
    assert(hostname === real, `the API and the device agree on the hostname (${real})`);

    const services = data.Services.stats.result?.data ?? [];
    assert(services.length > 0, `the API reports ${services.length} services`);

    // The API's view of a service and systemd's must agree — a divergence here
    // is the serviceMonitor losing track, which the UI then shows as fact.
    const api = services.find((s) => s.serviceName === 'apollo-api');
    assert(!!api, 'apollo-api is among the services the API knows about');

    // Second source, always: systemd, not the app's own opinion of itself.
    const { stdout: apiActive } = await sshExec(profile, 'systemctl is-active apollo-api');
    assert(apiActive === 'active', 'systemd agrees apollo-api is active');

    const health = await fetch(`${profile.apiBase}/health`).then((r) => r.json());
    assert(health.status === 'OK', `/health says ${health.status}`);
    assert(health.environment === 'production', `the device runs in production mode (${health.environment})`);

    return { hostname, services: services.length };
  },
};
