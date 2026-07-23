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

    // bitcoind travels in the release now, so its absence is a broken artifact,
    // not a device that never had it. Without this the wholesale replacement of
    // backend/ would leave the device with no node at all.
    //
    // The invariant is the flavour the device is CONFIGURED to run, read from
    // settings. Keying on the device's own directory listing instead demanded
    // every future artifact be a superset of what was already on disk: retiring
    // a flavour bricked the OTA channel of every device on the previous release,
    // permanently, because the only thing that could fix it was the release it
    // refused — and a stray file in that directory did the same. It also
    // contradicted step 6, whose artifact carries no bitcoind at all.
    expect(script).toMatch(/SELECT COALESCE\(node_software/);
    expect(script).toMatch(/the flavour this device runs/);
    expect(script).not.toMatch(/for flavour in \$\(ls "\$APOLLO_DIR\/backend\/node\/bin"/);
    // Skipped, not failed, when the artifact ships no bin/ directory — that is
    // what a step-6 release looks like.
    const check = script.slice(script.indexOf('if [ -d "$STAGING/backend/node/bin" ]; then'));
    expect(check.slice(0, 1200)).toContain('resolve_database_url');
    expect(script).toMatch(/Artifact is missing the \$unit unit/);
    // The updater's own runtime dependencies, which the `backend/` existence
    // test cannot see: version.sh is sourced before the ERR trap is armed, so a
    // release that lost it installs cleanly and then kills every FUTURE update
    // on that device with no record of why.
    expect(script).toMatch(/Artifact is missing \$f — refusing to install/);
    expect(script).toContain('backend/lib/version.sh backend/utils/install-update-deps.sh');
    // And the source itself refuses rather than aborting silently.
    expect(script).toMatch(/if \[ ! -r "\$VERSION_LIB" \]; then/);

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

    // Every hard dependency the gate checks must be one the installer provisions,
    // or a device without it dies at the gate with nothing left to install it —
    // the installer IS the self-provision step. sqlite3 was the gap: required by
    // the gate, absent from the apt list.
    const gateLine = script.match(/for t in ([a-z0-9 ]+); do\s*\n\s*have "\$t" \|\| die "Missing dependency/);
    expect(gateLine).not.toBeNull();
    const required = gateLine[1].trim().split(/\s+/);
    const deps = fs.readFileSync(
      path.join(__dirname, '..', 'backend', 'utils', 'install-update-deps.sh'),
      'utf8'
    );
    const aptList = deps.match(/for p in ([a-z0-9 ]+); do have/)[1].trim().split(/\s+/);
    // cosign is fetched separately (pinned sha), not from apt; everything else
    // the gate needs must be in the apt list or already a coreutil.
    const coreutils = ['curl', 'sha256sum', 'tar'];
    for (const dep of required) {
      if (dep === 'cosign' || coreutils.includes(dep)) continue;
      expect(aptList).toContain(dep);
    }
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
    const written = [...beforeGate.matchAll(/progress "[^"]+" (-?\d+)/g)].map((m) =>
      parseInt(m[1], 10)
    );
    expect(written.length).toBeGreaterThan(0);
    for (const value of written) {
      expect(value).toBeLessThan(90);
    }

    // And the terminal state is recorded past the gate.
    expect(script.slice(healthGate)).toMatch(/write_state succeeded "done" 100/);
  });

  it('records the outcome where the UI can read it after reconnecting', () => {
    const script = readBackendScript('update');

    // Progress is polled through apollo-api, which this script stops — so the UI
    // is blind for the window that matters and reconnects with no memory. The
    // record lives in the state dir, not /tmp, so it survives a reboot too.
    expect(script).toMatch(/LAST_UPDATE_FILE="\$\{STATE_DIR\}\/last-update\.json"/);
    expect(script).toMatch(/write_state succeeded "done" 100/);

    // Four terminal states, because "modified and put back" and "modified and
    // NOT put back" are different things to tell a user — the second means SSH.
    const cleanup = script.match(/^cleanup\(\) \{[\s\S]*?\n\}/m)[0];
    for (const state of ['aborted', 'rolled-back', 'recovery-failed']) {
      expect(cleanup).toContain(`result='${state}'`);
    }
  });

  it('reaches a terminal state on every exit path, including the no-op', () => {
    const script = readBackendScript('update');

    // "Already on <version>" is the most easily reached path in the script, and
    // it used to exit through cleanup's FAILURE branch: COMPLETED was still 0
    // when its `exit 0` fired the EXIT trap, so an up-to-date device recorded a
    // failure and exited 1. It has to record a terminal state of its own, or a
    // client waiting for an outcome waits for one that never comes.
    const alreadyOn = script.match(/if \[ "\$CURRENT" = "\$VERSION" \]; then[\s\S]*?\n  fi/);
    expect(alreadyOn).not.toBeNull();
    expect(alreadyOn[0]).toContain('COMPLETED=1');
    expect(alreadyOn[0]).toContain('write_state succeeded');
    expect(alreadyOn[0].indexOf('COMPLETED=1')).toBeLessThan(alreadyOn[0].indexOf('exit 0'));

    // And cleanup always records one, so no exit leaves the record on "running".
    const cleanup = script.match(/^cleanup\(\) \{[\s\S]*?\n\}/m)[0];
    expect(cleanup).toMatch(/write_state "\$result"/);
  });

  it('does not leave a terminal value in the progress file', () => {
    const script = readBackendScript('update');

    // A leftover terminal value is what made a finished run read as a live one:
    // serviceMonitor stopped restarting crashed services, and the modal offered
    // "Reload App" instead of the update, so the device could never take another.
    const cleanup = script.match(/^cleanup\(\) \{[\s\S]*?\n\}/m)[0];
    expect(cleanup).toMatch(/rm -f "\$TMPFILE"/);
    expect(cleanup).not.toMatch(/echo "-?\d+" > "\$TMPFILE"/);
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
