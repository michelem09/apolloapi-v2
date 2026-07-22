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
    // The stop lives in one function, used by both the main path and the
    // rollback, so the two cannot drift. bootstrap is stopped separately and
    // last, because everything else declares Requires= on it and stopping it in
    // the same transaction races their ExecStop.
    const stop = script.match(/stop_services\(\) \{[\s\S]*?\n\}/);
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

  it('never reports success before the gates that can still roll back', () => {
    const script = readBackendScript('update');

    // Two gates come after "Starting services" — the node failing to start, and
    // the health check timing out — and either triggers a full rollback. Writing
    // 95 before them told the user the update had worked while the device was
    // reverting, and the modal treated anything >= 90 as done.
    // lastIndexOf: cleanup carries a comment mentioning the `health_ok || die`
    // path, and indexOf found that instead of the gate itself.
    const startPhase = script.lastIndexOf('log "Starting services"');
    const healthGate = script.lastIndexOf('health_ok || die');
    expect(startPhase).toBeGreaterThan(-1);
    expect(healthGate).toBeGreaterThan(startPhase);

    // The window that matters runs from the stop — the point after which a
    // rollback is possible — to the health gate. Anything written there that
    // reads as success is a lie the user acts on. The 100 on the "Already on"
    // path is outside it and legitimate: nothing is being installed.
    const pointOfNoReturn = script.lastIndexOf('log "Stopping services"');
    expect(pointOfNoReturn).toBeGreaterThan(-1);
    expect(healthGate).toBeGreaterThan(pointOfNoReturn);
    const beforeGate = script.slice(pointOfNoReturn, healthGate);
    const written = [...beforeGate.matchAll(/echo "(-?\d+)" > "\$TMPFILE"/g)].map((m) =>
      parseInt(m[1], 10)
    );
    expect(written.length).toBeGreaterThan(0);
    for (const value of written) {
      expect(value).toBeLessThan(90);
    }

    // And 100 is written past the gate.
    expect(script.slice(healthGate)).toMatch(/echo "100" > "\$TMPFILE"/);
  });

  it('records the outcome where the UI can read it after reconnecting', () => {
    const script = readBackendScript('update');

    // Progress is polled through apollo-api, which this script stops — so the UI
    // is blind for the window that matters and reconnects with no memory. The
    // record lives in the state dir, not /tmp, so it survives a reboot too.
    expect(script).toMatch(/LAST_UPDATE_FILE="\$\{STATE_DIR\}\/last-update\.json"/);
    expect(script).toContain('write_last_update success');
    expect(script).toMatch(/write_last_update "\$result"/);

    // 'failed' and 'rolled-back' are different things to tell a user: one means
    // the device was never touched.
    const cleanup = script.match(/^cleanup\(\) \{[\s\S]*?\n\}/m);
    expect(cleanup[0]).toContain("result='failed'");
    expect(cleanup[0]).toContain("result='rolled-back'");
  });

  it('leaves a terminal progress value on every exit path', () => {
    const script = readBackendScript('update');

    // Deleting the file on success made a completed update look identical to one
    // that never started: Mcu.updateProgress reports a missing file as 0, and the
    // modal renders "Updating... 0%" with no close button, forever.
    const success = script.slice(script.indexOf('COMPLETED=1\n\n# The verified'));
    expect(success).not.toMatch(/rm -f "\$TMPFILE"/);

    // "Already on <version>" is the most easily reached path in the script, and
    // it used to exit through cleanup's FAILURE branch: the flag was still 0, so
    // an up-to-date device wrote -1, printed "Update failed" and exited 1.
    const alreadyOn = script.match(/if \[ "\$CURRENT" = "\$VERSION" \]; then[\s\S]*?\n  fi/);
    expect(alreadyOn).not.toBeNull();
    expect(alreadyOn[0]).toContain('COMPLETED=1');
    expect(alreadyOn[0].indexOf('COMPLETED=1')).toBeLessThan(alreadyOn[0].indexOf('exit 0'));
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
    // Whole-value, not line-oriented: `grep` tests each line, so a multi-line
    // value passed as long as ONE line matched, and the other line reached the
    // arithmetic expansion and executed. The guards must reject embedded
    // newlines outright — see single_line / valid_number.
    const guard = script.indexOf('valid_number "$SIZE"');
    const use = script.indexOf('NEED_KB=$((');
    expect(guard).toBeGreaterThan(-1);
    expect(use).toBeGreaterThan(guard);
    expect(script).toMatch(/single_line\(\) \{ \[\[ "\$1" != \*\$'\\n'\* \]\]; \}/);
    // Every value read out of the manifest goes through a single-line check.
    for (const helper of ['valid_version()', 'valid_url()', 'valid_number()']) {
      const body = script.slice(script.indexOf(helper), script.indexOf(helper) + 220);
      expect(body).toContain('single_line');
    }
    expect(script).toContain('single_line "$SHA"');

    // The channel URL is built from source.conf, which the app user can write.
    const urlGuard = script.indexOf('valid_url "$CHANNEL_URL"');
    const fetchUrl = script.indexOf('fetch "$CHANNEL_URL"');
    expect(urlGuard).toBeGreaterThan(-1);
    expect(fetchUrl).toBeGreaterThan(urlGuard);
  });
});
