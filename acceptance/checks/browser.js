const path = require('path');
const { spawn } = require('child_process');
const { openTunnel } = require('../lib/tunnel');

// The browser tier, run as one check so a release has a single gate.
//
// It needs the device password, because the UI is behind a login and signing in
// is itself part of what has to work. Without it there is nothing honest to run,
// so it skips.
module.exports = {
  name: 'browser',
  risk: 2,
  async run({ profile, assert, skip }) {
    if (!process.env.ACCEPTANCE_DEVICE_PASSWORD) {
      return skip('set ACCEPTANCE_DEVICE_PASSWORD to drive the UI in a browser');
    }

    const ui = await openTunnel(profile, profile.uiPort || 3000);
    try {
      const code = await new Promise((resolve) => {
        const child = spawn(
          'npx',
          ['playwright', 'test', '--config', path.join(__dirname, '..', 'browser', 'playwright.config.js')],
          {
            stdio: 'inherit',
            env: {
              ...process.env,
              ACCEPTANCE_UI_BASE: `http://127.0.0.1:${ui.port}`,
              ACCEPTANCE_REAL_DEVICE: '1',
            },
          }
        );
        child.on('exit', resolve);
      });

      assert(code === 0, 'the browser specs passed');
    } finally {
      ui.close();
    }

    return { via: `127.0.0.1:${ui.port}` };
  },
};
