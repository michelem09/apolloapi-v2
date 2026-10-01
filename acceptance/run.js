#!/usr/bin/env node
// Pre-release acceptance run against a real device.
//
// Development only: this directory is never packaged (the release workflow
// stages an allow-list) and carries no dependencies, so nothing here can reach
// a device through an install. See docs-ai/ACCEPTANCE_SUITE.md.
//
//   node acceptance/run.js --profile acceptance/profile.json [--only timezone]
//
// Checks run in order of increasing risk, so a failure early costs little and
// leaves the device in a sane state. Whatever happens, the snapshot is restored.

const fs = require('fs');
const path = require('path');
const { assertDeviceIsDisposable } = require('./lib/guard');
const { takeSnapshot, restoreSnapshot } = require('./lib/snapshot');
const { mintToken } = require('./lib/api');
const { describeDevice } = require('./lib/device');
const { wifiPassphrase } = require('./lib/secrets');
const { openTunnel } = require('./lib/tunnel');

const CHECKS = [
  require('./checks/preflight'),
  require('./checks/timezone'),
  require('./checks/miner'),
  require('./checks/browser'),
  require('./checks/node'),
  require('./checks/password'),
  require('./checks/wifi'),
  require('./checks/reboot'),
].sort((a, b) => a.risk - b.risk);

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const main = async () => {
  const profilePath = arg('profile', path.join(__dirname, 'profile.json'));
  if (!fs.existsSync(profilePath)) {
    throw new Error(`no profile at ${profilePath} — copy profile.example.json and edit it`);
  }
  const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8'));
  profile.user = profile.user || 'futurebit';
  profile.apiPort = profile.apiPort || 5000;

  // The passphrase never lives in the profile: a file gets committed by accident,
  // and a command line ends up in shell history and in logs.
  profile.wifi = { ...(profile.wifi || {}), passphrase: wifiPassphrase() };

  const only = arg('only');
  if (only && !CHECKS.some((c) => c.name === only)) {
    throw new Error(`no check named "${only}" — try one of: ${CHECKS.map((c) => c.name).join(', ')}`);
  }
  const started = Date.now();

  const { hostname } = await assertDeviceIsDisposable(profile);
  const device = await describeDevice(profile);
  console.log(`device:   ${hostname} (${profile.host}) — ${device.kind}, BOARD_NAME ${device.board}`);

  const snapshot = await takeSnapshot(profile);

  // Ctrl-C is the likeliest way a long run ends early, and it must not be the
  // one path that leaves a device with a stopped miner and a foreign timezone.
  let interrupted = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, async () => {
      if (interrupted) process.exit(130); // insisting ends it now
      interrupted = true;
      console.log(`\n${signal} — restoring before leaving…`);
      try {
        const n = await restoreSnapshot(profile, snapshot);
        n.forEach((note) => console.log(`  · ${note}`));
      } catch (err) {
        console.error(`  ! restore failed: ${err.message}`);
      }
      process.exit(130);
    });
  }
  console.log(`snapshot: db + timezone ${snapshot.timezone}`);

  let tunnel = await openTunnel(profile, profile.apiPort);
  profile.apiBase = `http://127.0.0.1:${tunnel.port}`;
  console.log(`tunnel:   127.0.0.1:${tunnel.port} → ${profile.host}:${profile.apiPort}\n`);

  // A reboot takes the tunnel with it, so a check that restarts the device has
  // to be able to build it again — otherwise everything after the reboot fails
  // for want of a pipe rather than for anything about the product.
  const reopenTunnel = async () => {
    try { tunnel.close(); } catch { /* already gone */ }
    tunnel = await openTunnel(profile, profile.apiPort);
    profile.apiBase = `http://127.0.0.1:${tunnel.port}`;
    return tunnel.port;
  };

  // From here on the device may have been changed, so every exit path goes
  // through the restore — including one where a check never got to run.
  const results = [];
  let failed = false;
  try {
    const token = await mintToken(profile);
    failed = await runChecks({ profile, token, only, results, reopenTunnel, device });
  } catch (err) {
    console.log(`\n! ${err.message}`);
    failed = true;
  }

  try { tunnel.close(); } catch { /* already gone */ }

  console.log('\nrestoring…');
  const notes = await restoreSnapshot(profile, snapshot);
  notes.forEach((n) => console.log(`  · ${n}`));

  const mins = ((Date.now() - started) / 60000).toFixed(1);
  const passed = results.filter((r) => r.ok).length;
  const skipped = results.filter((r) => r.skipped);

  // Skips are not passes. A gate that answers "8/8 passed" after testing nothing
  // — no keychain entry, no SSID, no playwright — is worse than one that fails:
  // it is a green light nobody earned.
  console.log(
    `\n${passed}/${results.length} checks passed in ${mins} min` +
    (skipped.length ? `, ${skipped.length} skipped: ${skipped.map((s) => s.check).join(', ')}` : '')
  );
  if (skipped.length) {
    console.log('skipped checks proved nothing — exit code 3');
  }
  process.exit(failed ? 1 : skipped.length ? 3 : 0);
};

const runChecks = async ({ profile, token, only, results, reopenTunnel, device }) => {
  let failed = false;

  for (const check of CHECKS) {
    if (only && check.name !== only) continue;
    if (profile.allow && !profile.allow.includes(check.name)) continue;

    const lines = [];
    const assert = (ok, what) => {
      lines.push(`    ${ok ? '✓' : '✗'} ${what}`);
      if (!ok) throw new Error(`${check.name}: ${what}`);
    };
    const skip = (why) => ({ skipped: why });

    process.stdout.write(`${check.name}\n`);
    try {
      const out = await check.run({ profile, token, assert, skip, reopenTunnel, device });
      lines.forEach((l) => console.log(l));
      if (out?.skipped) {
        console.log(`    – skipped: ${out.skipped}`);
        results.push({ check: check.name, skipped: true });
      } else {
        results.push({ check: check.name, ok: true });
      }
    } catch (err) {
      lines.forEach((l) => console.log(l));
      console.log(`    ! ${err.message}`);
      results.push({ check: check.name, ok: false, error: err.message });
      failed = true;
      break; // ordered by risk: do not run riskier checks past a failure
    }
  }

  return failed;
};

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(2);
});
