const path = require('path');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const { openTunnel } = require('../lib/tunnel');
const { devicePassword, howToStore } = require('../lib/secrets');

const reachable = (host, port, timeoutMs = 3000) =>
  new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => done(true));
    sock.on('timeout', () => done(false));
    sock.on('error', () => done(false));
  });

// The browser tier, run as one check so a release has a single gate.
//
// It prefers the device's own address, because that is what a user's browser
// does and it needs no plumbing. A tunnel is the fallback for an operator who
// cannot route to the LAN — and then the API has to arrive on local port 5000,
// since the page asks for GraphQL at its own hostname on that fixed port
// (apolloClient.js uses window.location.hostname). If something else holds 5000
// — on macOS the AirPlay receiver does — there is no honest way to run this, and
// saying so is better than a run that fails for plumbing.
module.exports = {
  name: 'browser',
  risk: 2,
  async run({ profile, assert, skip }) {
    if (!devicePassword()) {
      return skip(`store the device password to drive the UI:\n      ${howToStore('device-password')}`);
    }

    const bin = path.join(__dirname, '..', 'node_modules', '.bin', 'playwright');
    if (!fs.existsSync(bin)) {
      return skip('run `yarn --cwd acceptance install` first — playwright is not installed here');
    }

    const uiPort = profile.uiPort || 3000;
    const close = [];
    let base;

    if (await reachable(profile.host, uiPort)) {
      base = `http://${profile.host}:${uiPort}`;
    } else {
      if (await reachable('127.0.0.1', profile.apiPort)) {
        return skip(
          `cannot route to ${profile.host}:${uiPort}, and local port ${profile.apiPort} is ` +
          'already taken — the page would ask that port for GraphQL. On macOS it is usually ' +
          'the AirPlay receiver (System Settings → General → AirDrop & Handoff).'
        );
      }
      const api = await openTunnel(profile, profile.apiPort, profile.apiPort);
      const ui = await openTunnel(profile, uiPort);
      close.push(api, ui);
      base = `http://127.0.0.1:${ui.port}`;
    }

    try {
      const code = await new Promise((resolve) => {
        const child = spawn(
          bin,
          ['test', '--config', path.join(__dirname, '..', 'browser', 'playwright.config.js')],
          {
            stdio: 'inherit',
            env: { ...process.env, ACCEPTANCE_UI_BASE: base, ACCEPTANCE_REAL_DEVICE: '1' },
          }
        );
        child.on('exit', resolve);
      });

      assert(code === 0, `the browser specs passed (against ${base})`);
    } finally {
      close.forEach((t) => t.close());
    }

    return { base };
  },
};
