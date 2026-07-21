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

    // Every unit the release owns has to be stopped, not just the ones reading
    // from the checkout: `systemctl start` on an already-active unit is a no-op,
    // so anything left running never picks up the new release. apollo-miner kept
    // executing the old binary, and apollo-bootstrap — oneshot with
    // RemainAfterExit — never re-ran its migrations.
    // The whole stop region, not one command: bootstrap is stopped separately
    // and last, because everything else declares Requires= on it and stopping it
    // in the same transaction races their ExecStop.
    const stop = script.match(/log "Stopping services"[\s\S]*?verify_all_stopped/);
    expect(stop).not.toBeNull();
    for (const unit of [
      'ckpool.service',
      'node.service',
      'apollo-miner.service',
      'apollo-ui-v2.service',
      'apollo-api.service',
      'apollo-bootstrap.service',
    ]) {
      expect(stop[0]).toContain(unit);
    }
    // ckpool releases the RPC before the node goes; bootstrap goes last because
    // node and miner declare Requires= on it.
    expect(stop[0].indexOf('ckpool.service')).toBeLessThan(stop[0].indexOf('node.service'));
    expect(stop[0].indexOf('apollo-bootstrap.service')).toBeGreaterThan(
      stop[0].indexOf('apollo-api.service')
    );

    // The exit code of `systemctl stop` is ignored on purpose — it reports unit
    // state, not whether the shutdown worked, and a clean bitcoind shutdown can
    // still leave node.service "failed" because of its screen wrapper. What
    // replaces it is stronger: every unit is verified inactive afterwards.
    expect(script).toContain('verify_all_stopped');
    const verifyLoop = script.match(/for u in ([^;]+); do\n\s*if systemctl is-active --quiet/);
    expect(verifyLoop).not.toBeNull();
    for (const unit of [
      'ckpool',
      'node',
      'apollo-miner',
      'apollo-ui-v2',
      'apollo-api',
      'apollo-bootstrap',
    ]) {
      expect(verifyLoop[1]).toContain(unit);
    }

    // Both residual process checks: a unit can report inactive while its daemon
    // survives. ckpool_stop.sh ends in `|| true` and ckpool backgrounds itself.
    expect(script).toContain('pgrep -u futurebit -x bitcoind');
    expect(script).toContain('pgrep -u futurebit -x ckpool');

    // bootstrap must come back up before the units that Require it.
    const startBootstrap = script.indexOf('systemctl start apollo-bootstrap.service\n');
    const startNode = script.indexOf('systemctl start node.service ||');
    expect(startBootstrap).toBeGreaterThan(-1);
    expect(startNode).toBeGreaterThan(startBootstrap);
  });

  it('leaves the caller cgroup before stopping the service it was spawned from', () => {
    const script = readBackendScript('update');

    // src/services/mcu.js spawns this as a plain child of apollo-api, so without
    // detaching it sits in apollo-api's cgroup and `systemctl stop
    // apollo-api.service` takes it down mid-swap.
    const reexec = script.indexOf('exec systemd-run --quiet --collect --unit=');
    const stop = script.indexOf('systemctl stop ');
    expect(reexec).toBeGreaterThan(-1);
    expect(stop).toBeGreaterThan(reexec);

    // Specifically NOT `--scope`, and this is a regression guard rather than a
    // style preference. A scope moves the process out of the cgroup but leaves it
    // a child of sudo, which sits in apollo-api's cgroup and relays the SIGTERM
    // to it. That version failed on hardware twice, dying at "Stopping services"
    // with no error message. Only a transient service reparents to systemd.
    expect(script).not.toMatch(/systemd-run[^\n]*--scope/);

    // The inherited stdout belongs to the process being stopped, so it must not
    // still be in use once that happens.
    expect(script).toMatch(/exec >>"\$LOG_FILE" 2>&1/);
  });

  it('refuses an incomplete artifact before touching the device copy', () => {
    const script = readBackendScript('update');

    // The install loop skips anything missing, so without this an artifact built
    // without backend/ completed "successfully" with backend/ simply gone — the
    // health probe passes, because the API and UI start fine from src/.
    expect(script).toMatch(/Artifact is missing \$d/);
    expect(script).toMatch(/Artifact is missing \$f/);

    const assertion = script.indexOf('Artifact is missing $d');
    const backup = script.indexOf('backup_code\n');
    expect(assertion).toBeGreaterThan(-1);
    expect(backup).toBeGreaterThan(assertion);
  });

  it('provisions its own dependencies instead of refusing to run', () => {
    const script = readBackendScript('update');

    // Nothing in the repo installed jq, zstd or cosign, so the hard gate made the
    // OTA channel inert on every fielded device.
    expect(script).toContain('backend/utils/install-update-deps.sh');
    const provision = script.indexOf('install-update-deps.sh');
    const gate = script.indexOf('Missing dependency');
    expect(gate).toBeGreaterThan(provision);
  });

  it('reports failure to the UI rather than deleting the progress file', () => {
    const script = readBackendScript('update');

    // A missing file reads as progress 0 through Mcu.updateProgress, which the
    // modal cannot tell apart from a fresh start — it hid its own close button
    // and sat at "Updating... 0%" until the page was reloaded.
    expect(script).toMatch(/echo "-1" > "\$TMPFILE"/);
    const failureWrite = script.indexOf('echo "-1" > "$TMPFILE"');
    const failureMsg = script.indexOf('Update failed; the previous version');
    expect(failureWrite).toBeGreaterThan(-1);
    expect(failureMsg).toBeGreaterThan(failureWrite);
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
