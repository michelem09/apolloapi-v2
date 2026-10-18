// Journeys: a real user's paths through the real UI, one spec per path.
//
// Not run with `playwright test` directly: the parent (acceptance/journeys.js)
// takes the snapshot, opens the tunnel, mints the token, and — whatever happens in
// a spec — puts the device back afterwards. Run bare, a spec has no context file
// and refuses to start.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname + '/specs',
  testMatch: '*.spec.js',
  // A path is long by nature: the node one restarts bitcoind three times.
  timeout: 25 * 60 * 1000,
  expect: { timeout: 15000 },
  // One worker, one device. Two paths racing on the same settings would make
  // every failure unreadable.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.ACCEPTANCE_PW_OUT || undefined,
  use: {
    baseURL: process.env.ACCEPTANCE_UI_BASE,
    headless: true,
    viewport: { width: 1280, height: 900 },
    screenshot: 'off', // the journeys take their own, at every step
    video: 'off',
    actionTimeout: 15000,
  },
});
