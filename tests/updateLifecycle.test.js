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
});
