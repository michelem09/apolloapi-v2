const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { defaultDatabaseUrl } = require('./paths');

function ensureEnvFile() {
  // The .env is device state, not code, so it must resolve to a fixed device
  // path — not one relative to __dirname, which moves when the code is installed
  // under releases/<version>/current. Without this, running from current/ created
  // a stray current/.env with a fresh APP_SECRET. APOLLO_ENV_FILE is set by the
  // systemd units; dev falls back to the repo-root .env.
  const envPath = process.env.APOLLO_ENV_FILE || path.join(__dirname, '..', '.env');
  if (!fs.existsSync(envPath)) {
    const contents = [
      `DATABASE_URL=${defaultDatabaseUrl()}`,
      `APP_SECRET=${crypto.randomBytes(64).toString('hex')}`,
      '',
    ].join('\n');

    fs.writeFileSync(envPath, contents, { encoding: 'utf8', mode: 0o600 });
  }

  fs.chmodSync(envPath, 0o600);
  require('dotenv').config({ path: envPath });
  return envPath;
}

module.exports = { ensureEnvFile };
