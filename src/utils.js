const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const config = require('config');
const log = require('./logger')('utils');
const { assertPasswordSafe } = require('./passwordPolicy');

const CHPASSWD_TIMEOUT_MS = 30000;
const CHPASSWD_KILL_GRACE_MS = 5000;

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
      let settled = false;
      let killTimer = null;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };
      // A chpasswd that never exits would hold the auth lock (and with it every
      // later setup and password change) for ever. `child` is sudo, which runs as
      // root: a signal sent from here (we are `futurebit`) would be refused, so the
      // signal goes through `sudo kill` (sudoers lets the service user do that).
      // SIGTERM first, SIGKILL if that is not enough. Whether the password changed
      // is not known at that point, and the message says so.
      const signal = (name) => {
        if (!child.pid) return;
        const killer = spawn('sudo', ['kill', `-${name}`, String(child.pid)], { stdio: 'ignore' });
        // No sudo, no such process: nothing more can be done about it, and an
        // unhandled 'error' event would take the whole API down.
        killer.on('error', (error) => log.error({ err: error }, `could not send ${name} to chpasswd`));
      };
      const timer = setTimeout(() => {
        signal('TERM');
        killTimer = setTimeout(() => signal('KILL'), CHPASSWD_KILL_GRACE_MS);
        finish(
          reject,
          new Error(
            `chpasswd did not finish within ${CHPASSWD_TIMEOUT_MS / 1000}s: the system password may or may not have changed. Repeat the change.`
          )
        );
      }, CHPASSWD_TIMEOUT_MS);
      child.on('exit', () => clearTimeout(killTimer));
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', (error) => finish(reject, error));
      // EPIPE when chpasswd dies before reading its input.
      child.stdin.on('error', (error) => finish(reject, error));
      child.on('close', (code) => {
        if (code !== 0) {
          // What chpasswd said is for the log, not for the screen (it can quote the
          // command, the account, PAM's reasons).
          log.error({ code, stderr: stderr.trim() }, 'chpasswd failed');
          finish(reject, new Error('Could not change the system password'));
        } else {
          finish(resolve);
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
