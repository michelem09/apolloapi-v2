const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const probes = require('./probes');
const { takeStateSnapshot, restoreState, capture, describeDrift } = require('./state');
const { ensureMinerOff, ensurePassword, JOURNAL } = require('./finalize');

const LOGIN = `query($input: AuthLoginInput!) {
  Auth { login(input: $input) { result { accessToken } error { message } } }
}`;
const CHANGE = `mutation($input: AuthChangePasswordInput!) {
  Auth { changePassword(input: $input) { error { message } } }
}`;

const PLAYWRIGHT = path.join(__dirname, '..', 'node_modules', '.bin', 'playwright');
const CONFIG = path.join(__dirname, 'playwright.config.js');

// Wires the real device, API and browser into the collaborators runRound takes.
// Everything that touches the world comes in as an argument (`io`), so this file
// stays the only place that knows how the pieces connect.
const buildDeps = ({ profile, io, out, ctxFile, uiBase, original, wifi, spawnImpl = spawn, state = {} }) => {
  const { ssh, gql, gqlWrite, waitUntil, base } = io;
  const marker = path.join(out, 'password.touched');

  const login = async (pw) => !!(await gql(LOGIN, { input: { password: pw } })).Auth.login.result?.accessToken;

  return {
    snapshot: async () => {
      // The journal is read from here on: a stop that skipped its script
      // anywhere in the round is found at the end, whichever journey caused it.
      state.roundSince = Number(await ssh('date +%s'));
      return takeStateSnapshot({ profile, ssh, gql, base });
    },

    runJourney: async (journey) => {
      const record = path.join(out, `${journey.id}.json`);
      fs.rmSync(record, { force: true });
      const started = Date.now();
      const code = await new Promise((resolve) => {
        const child = spawnImpl(PLAYWRIGHT, ['test', '--config', CONFIG, journey.file], {
          stdio: 'inherit',
          env: {
            ...process.env,
            ACCEPTANCE_JOURNEY_CTX: ctxFile,
            ACCEPTANCE_UI_BASE: uiBase,
            ACCEPTANCE_PW_OUT: path.join(out, 'pw', journey.id),
          },
        });
        state.child = child;
        child.on('exit', (c) => resolve(c));
        child.on('error', () => resolve(-1));
      });
      state.child = null;
      if (!fs.existsSync(record)) {
        return { id: journey.id, name: journey.name, ok: false, durationMs: Date.now() - started, error: `no record written (playwright exit ${code}): the spec did not start` };
      }
      const rec = JSON.parse(fs.readFileSync(record, 'utf8'));
      // A zero exit with a skipped record is a skip; a non-zero one never is.
      return { ...rec, ok: code === 0 && !!rec.ok && !rec.skipped, skipped: code === 0 ? rec.skipped : null, journeyExit: code };
    },

    restore: (snap) => restoreState({ profile, ssh, gql, gqlWrite, snap, base, waitUntil, wifi }),

    password: () =>
      ensurePassword({
        touched: fs.existsSync(marker),
        login: () => login(original),
        change: async () => {
          const out2 = await gqlWrite(CHANGE, { input: { password: original } });
          const err = out2.Auth.changePassword.error?.message;
          if (err) throw new Error(err);
        },
        linuxMatches: () => probes.linuxPasswordMatches(ssh, original),
      }),

    minerOff: () =>
      ensureMinerOff({
        state: () => probes.unitState(ssh, 'apollo-miner'),
        stop: async () => {
          const r = await gqlWrite('mutation { Miner { stop { error { message } } } }');
          const err = r?.Miner?.stop?.error?.message;
          if (err) throw new Error(err);
        },
        waitUntil,
        deviceEpoch: () => ssh('date +%s'),
        journal: (since) => ssh(JOURNAL(since)),
        roundSince: state.roundSince ?? null,
        runStopScript: () => ssh('sudo /opt/apolloapi/backend/apollo-miner/miner_stop.sh', { timeoutMs: 120000 }),
      }),

    finalCheck: async (snap) => {
      const errors = [];
      const after = await capture({ ssh, gql });
      const minerNow = after.services['apollo-miner'];
      if (minerNow !== 'inactive' && minerNow !== 'failed') errors.push(`the miner is ${minerNow} at the end of the round`);
      try {
        if (!(await login(original))) errors.push('final check: the original password does not log in');
      } catch (err) {
        errors.push(`final check: ${err.message}`);
      }
      return { errors, drift: describeDrift(snap.before, after), minerNow };
    },
  };
};

// For --local: nothing on a device to snapshot, restore or verify.
const localDeps = ({ ctxFile, uiBase, out, spawnImpl = spawn, state = {} }) => {
  const real = buildDeps({ profile: {}, io: {}, out, ctxFile, uiBase, original: null, spawnImpl, state });
  const none = async () => ({ errors: [], notes: ['local run: no device, nothing to restore or verify'] });
  return {
    snapshot: async () => ({}),
    runJourney: real.runJourney,
    restore: none,
    password: none,
    minerOff: async () => ({ errors: [], off: null }),
    finalCheck: async () => ({ errors: [], drift: [] }),
  };
};

module.exports = { buildDeps, localDeps };
