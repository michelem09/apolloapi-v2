// The browser tier. It exists because the API tier cannot see the class of bug
// that lives between React components and the Apollo cache — a save bar that
// never closes, a caption bound to the wrong value, a refetch that does not
// reach the panel reading it. Every one of those shipped green through the
// GraphQL tests, and only a browser would have caught them.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: __dirname,
  timeout: 60000,
  expect: { timeout: 15000 },
  // One worker: these drive a single real device, and two of them racing on the
  // same settings would make failures impossible to read.
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.ACCEPTANCE_UI_BASE,
    headless: true,
    screenshot: 'only-on-failure',
    video: 'off',
    actionTimeout: 15000,
  },
});
