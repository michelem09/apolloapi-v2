const net = require('net');
const { openTunnel } = require('../lib/tunnel');

const reachable = (host, port, timeoutMs = 3000) =>
  new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });

// Where the browser should point. Straight at the device when the LAN is
// reachable, as a user's browser does. Otherwise through ssh — and then the API
// has to arrive on its own local port, because the page asks for GraphQL at its
// own hostname on the port baked into the build (see checks/browser.js).
const openUiBase = async (profile) => {
  const uiPort = profile.uiPort || 3000;
  if (await reachable(profile.host, uiPort)) {
    return { base: `http://${profile.host}:${uiPort}`, close: () => {} };
  }
  if (await reachable('127.0.0.1', profile.apiPort)) {
    throw new Error(
      `cannot route to ${profile.host}:${uiPort}, and local port ${profile.apiPort} is already taken — ` +
      'the page would ask that port for GraphQL (on macOS usually the AirPlay receiver)'
    );
  }
  const tunnels = [];
  tunnels.push(await openTunnel(profile, profile.apiPort, profile.apiPort));
  const ui = await openTunnel(profile, uiPort);
  tunnels.push(ui);
  return { base: `http://127.0.0.1:${ui.port}`, close: () => tunnels.forEach((t) => t.close()) };
};

module.exports = { openUiBase, reachable };
