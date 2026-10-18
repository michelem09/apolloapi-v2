#!/usr/bin/env node
// User journeys on a real device, through the real UI. Development only — see
// acceptance/README.md and docs-ai/DEVICE_UI_JOURNEYS.md.
//
//   node acceptance/journeys.js --profile acceptance/profiles/apollo2.json
//   node acceptance/journeys.js --profile … --only solo,password
//   node acceptance/journeys.js --list
//   node acceptance/journeys.js --local http://127.0.0.1:48811 --api http://127.0.0.1:47811
//
// A round: refuse unless the device carries ACCEPTANCE_OK; photograph it; run each
// journey in a browser; put everything back, even after a failure; and leave the
// two things this procedure owes the device — the miner OFF, and the original
// password working. The report (report.md, report.json, a screenshot per step)
// lands in acceptance/journeys/out/<timestamp>/.

const fs = require('fs');
const path = require('path');
const registry = require('./journeys/registry');
const { runRound } = require('./journeys/round');
const report = require('./journeys/report');
const defaults = require('./journeys/defaults');
const { buildDeps, localDeps } = require('./journeys/deps');
const { devicePassword, howToStore } = require('./lib/secrets');

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

const main = async () => {
  const all = registry.list();
  if (flag('list')) {
    all.forEach((j) => console.log(`${j.id}`));
    return 0;
  }
  const journeys = registry.select(all, arg('only'));
  const started = Date.now();
  const out = path.resolve(arg('out', path.join(__dirname, 'journeys', 'out', stamp())));
  fs.mkdirSync(out, { recursive: true });

  const bin = path.join(__dirname, 'node_modules', '.bin', 'playwright');
  if (!fs.existsSync(bin)) {
    throw new Error('run `yarn --cwd acceptance install` first — playwright is not installed here');
  }

  // Interrupts end the browser, not the round: the finally in runRound still runs.
  const state = { child: null, interrupted: false };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      if (state.interrupted) process.exit(130);
      state.interrupted = true;
      console.log(`\n${signal} — stopping the browser, then putting the device back…`);
      state.child?.kill();
    });
  }

  let deps;
  let meta;
  let closers = [];

  if (flag('local')) {
    // ---- local: a dev backend and UI, no device. Device checks are recorded as skipped.
    const uiBase = arg('local');
    const apiBase = arg('api');
    if (!uiBase || !apiBase) throw new Error('--local needs the UI base and --api the backend base');
    const password = devicePassword();
    const { gql } = require('./lib/api');
    const probe = { apiBase };
    let token = '';
    if (password) {
      const r = await gql(probe, '', `query($input: AuthLoginInput!){ Auth { login(input:$input) { result { accessToken } } } }`, { input: { password } }).catch(() => null);
      token = r?.Auth?.login?.result?.accessToken || '';
    }
    const ctx = { local: true, profile: probe, token, out, deviceKind: 'apollo-legacy', journeys: defaults('local', {}) };
    const ctxFile = path.join(out, 'context.json');
    fs.writeFileSync(ctxFile, JSON.stringify(ctx));
    deps = localDeps({ ctxFile, uiBase, out, state });
    meta = { host: `local (${uiBase})`, local: true };
  } else {
    // ---- device
    const profilePath = arg('profile', path.join(__dirname, 'profile.json'));
    if (!fs.existsSync(profilePath)) throw new Error(`no profile at ${profilePath} — see acceptance/profiles/ or profile.example.json`);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
    profile.user = profile.user || 'futurebit';
    profile.apiPort = profile.apiPort || 5000;

    const original = devicePassword();
    if (!original) {
      throw new Error(`the journeys sign in and must hand the password back: store it first\n  ${howToStore('device-password')}`);
    }

    const { assertDeviceIsDisposable } = require('./lib/guard');
    const { describeDevice } = require('./lib/device');
    const { sshExec } = require('./lib/ssh');
    const api = require('./lib/api');
    const { openTunnel } = require('./lib/tunnel');
    const { waitUntil } = require('./lib/wait');
    const snapshotLib = require('./lib/snapshot');
    const { wifiPassphrase } = require('./lib/secrets');
    const { openUiBase } = require('./journeys/ui-base');

    const { hostname } = await assertDeviceIsDisposable(profile);
    const device = await describeDevice(profile);
    console.log(`device:   ${hostname} (${profile.host}) — ${device.kind}`);

    const tunnel = await openTunnel(profile, profile.apiPort);
    closers.push(() => tunnel.close());
    profile.apiBase = `http://127.0.0.1:${tunnel.port}`;

    const token = await api.mintToken(profile);
    const ui = await openUiBase(profile);
    closers.push(() => ui.close());
    console.log(`ui:       ${ui.base}`);
    console.log(`journeys: ${journeys.map((j) => j.name).join(', ')}\n`);

    const ctx = {
      local: false,
      profile: { ...profile, wifi: { ssid: profile.wifi?.ssid } }, // never the passphrase
      token,
      out,
      deviceKind: device.kind,
      journeys: defaults(hostname, profile.journeys),
    };
    const ctxFile = path.join(out, 'context.json');
    fs.writeFileSync(ctxFile, JSON.stringify(ctx), { mode: 0o600 });

    const io = {
      ssh: async (command, opts) => (await sshExec(profile, command, opts)).stdout,
      gql: (doc, vars) => api.gql(profile, token, doc, vars),
      gqlWrite: (doc, vars) => api.gqlWrite(profile, token, doc, vars),
      waitUntil,
      base: snapshotLib,
    };
    deps = buildDeps({
      profile, io, out, ctxFile, uiBase: ui.base, original,
      wifi: { passphrase: wifiPassphrase() }, state,
    });
    meta = { host: `${hostname} (${profile.host})`, kind: device.kind };
  }

  // An interrupt skips the journeys not yet started; the device is still restored.
  const guarded = {
    ...deps,
    runJourney: async (j) =>
      state.interrupted
        ? { id: j.id, name: j.name, ok: false, durationMs: 0, error: 'interrupted before it started' }
        : deps.runJourney(j),
  };

  let result;
  try {
    result = await runRound({ journeys, deps: guarded, bail: flag('bail'), log: (m) => console.log(m) });
  } finally {
    closers.forEach((c) => { try { c(); } catch { /* already gone */ } });
  }

  meta = { ...meta, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started };
  // A local run proved nothing about a device, whatever passed in the browser.
  if (meta.local && result.exitCode === 0) result.exitCode = 3;
  const files = report.write(out, result, meta);
  console.log(`\n${fs.readFileSync(files.md, 'utf8').split('\n').slice(0, 14).join('\n')}`);
  console.log(`report:   ${files.md}\n          ${files.json}`);
  return result.exitCode;
};

main().then((code) => process.exit(code)).catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(2);
});
