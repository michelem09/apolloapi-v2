const fs = require('fs');
const path = require('path');

const readBackendScript = (name) =>
  fs.readFileSync(path.join(__dirname, '..', 'backend', name), 'utf8');

describe('update lifecycle contract', () => {
  it('makes update_system safe when launched by the pre-refactor updater', () => {
    const script = readBackendScript('update_system');
    const preserveIntent = script.indexOf('\npreserve_solo_intent\n');
    const installTransitionUnits = script.indexOf(
      '# The updater that launched this script may be from the pre-refactor release.'
    );
    const stopServices = script.indexOf('\nstop_runtime_services\n');
    const installDependencies = script.indexOf('\nyarn\n');
    const restoreIntent = script.lastIndexOf('\nrestore_solo_intent\n');

    expect(preserveIntent).toBeGreaterThan(-1);
    expect(installTransitionUnits).toBeGreaterThan(preserveIntent);
    expect(stopServices).toBeGreaterThan(installTransitionUnits);
    expect(installDependencies).toBeGreaterThan(stopServices);
    expect(restoreIntent).toBeGreaterThan(installDependencies);
  });

  it('does not ignore failed service shutdowns in the current updater', () => {
    const script = readBackendScript('update');

    // Asserted on intent and not on one service per line: the updater stops them
    // in a single `systemctl stop a b c` call, and the order within it is what
    // matters (ckpool before node, so the pool lets go of the RPC first).
    const stopLine = script.match(/^\s*systemctl stop .*$/m);
    expect(stopLine).not.toBeNull();
    for (const unit of ['ckpool.service', 'node.service', 'apollo-api.service']) {
      expect(stopLine[0]).toContain(unit);
    }
    expect(stopLine[0].indexOf('ckpool.service')).toBeLessThan(
      stopLine[0].indexOf('node.service')
    );

    expect(script).not.toMatch(/systemctl stop[^\n]*\|\| true/);
    expect(script).toContain('pgrep -u futurebit -x bitcoind');
  });

  it('validates every manifest field it consumes, before it consumes it', () => {
    const script = readBackendScript('update');

    // The manifest is attacker-controlled until cosign has verified the artifact,
    // so anything read out of it is untrusted input. SIZE is the dangerous one:
    // it reaches an arithmetic expansion, where bash re-evaluates the value as an
    // expression and expands array subscripts inside it — `x[$(cmd)]` runs cmd as
    // root, and it happens before the checksum and signature checks.
    const guard = script.indexOf("printf '%s' \"$SIZE\" | grep -qE '^[0-9]+$'");
    const use = script.indexOf('NEED_KB=$((');
    expect(guard).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(guard);

    // The channel URL is built from source.conf, which the app user can write.
    const urlGuard = script.indexOf('valid_url "$CHANNEL_URL"');
    const fetchUrl = script.indexOf('fetch "$CHANNEL_URL"');
    expect(urlGuard).toBeGreaterThan(-1);
    expect(fetchUrl).toBeGreaterThan(urlGuard);
  });
});
