const log = require('./logger')('init');
const { ensureEnvFile } = require('./env');
const {
  ensureDbLocation,
  ensureMinerRuntimeDir,
  ensureCkpoolRuntimeDir,
} = require('./paths');

async function initializeApp() {
  ensureEnvFile();
  ensureDbLocation(); // relocate the DB out of the checkout before ./db is required
  ensureMinerRuntimeDir(); // relocate miner runtime files out of the checkout
  ensureCkpoolRuntimeDir(); // relocate ckpool logs out of the checkout

  if (process.env.APOLLO_BOOTSTRAPPED !== '1') {
    // Manual and development launches do not have the systemd prerequisite.
    const { bootstrap } = require('./bootstrap');
    await bootstrap();
  }
  return require('./server');
}

initializeApp().catch(error => {
  log.error({ err: error }, 'failed to initialize app');
  process.exit(1);
});