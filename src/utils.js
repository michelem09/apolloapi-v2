const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const config = require('config');
const log = require('./logger')('utils');
const { assertPasswordSafe } = require('./passwordPolicy');

const isProduction = () => process.env.NODE_ENV === 'production';

module.exports.auth = {
  hashPassword(password) {
    return bcrypt.hash(password, 12);
  },

  comparePassword(password, hash) {
    if (!password || !hash) return false;
    return bcrypt.compare(password, hash);
  },

  async changeSystemPassword(password) {
    // Defence in depth: the auth service already refuses these, but this is the
    // function that writes to chpasswd, so it must not trust its callers.
    assertPasswordSafe(password);
    if (!isProduction()) {
      log.debug("[dev] would change system password for user 'futurebit'");
      return;
    }

    await new Promise((resolve, reject) => {
      // chpasswd reads one "user:password" entry per LINE from stdin. No shell, so quotes cannot inject
      // commands, but a line break WOULD inject a second entry (e.g. "root:..."): assertPasswordSafe above
      // refuses \n, \r and NUL before we get here.
      const child = spawn('sudo', ['chpasswd'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stderr = '';

      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `chpasswd exited with code ${code}`));
        } else {
          resolve();
        }
      });
      child.stdin.write(`futurebit:${password}\n`);
      child.stdin.end();
    });
  },

  generateAccessToken() {
    return {
      accessToken: jwt.sign({}, config.get('server.secret'), {
        subject: 'apollouser',
        audience: 'auth',
      }),
    };
  },
};
