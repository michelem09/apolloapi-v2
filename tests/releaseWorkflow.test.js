const fs = require('fs');
const path = require('path');
// The suite mocks child_process globally (tests/setup.js), and this test has to
// actually run bash — the whole point is executing the comparator rather than
// reading it.
const { execFileSync } = jest.requireActual('child_process');

const repo = path.join(__dirname, '..');
const workflow = fs.readFileSync(
  path.join(repo, '.github', 'workflows', 'release.yml'),
  'utf8'
);

// The pipeline decides what every device is offered. A mistake here is invisible
// on a green workflow: the artifact is built, signed and published, and simply
// never reaches anyone.
describe('release workflow', () => {
  it('publishes only on a tag push', () => {
    // A workflow_dispatch dry run created the git tag at the branch head plus a
    // public Release, and `gh release create` is not idempotent — so the real tag
    // push was then rejected, and re-running the failed job died here, leaving a
    // signed release the channel permanently did not point at.
    const guard = "if: github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v')";
    const publish = workflow.indexOf('- name: Publish the Release');
    const channel = workflow.indexOf('- name: Point the channel at this release');
    expect(publish).toBeGreaterThan(-1);
    expect(channel).toBeGreaterThan(publish);
    expect(workflow.slice(publish, channel)).toContain(guard);
    expect(workflow.slice(channel)).toContain(guard);
  });

  it('runs one release per tag rather than cancelling queued ones', () => {
    // A shared group keeps at most one PENDING run and cancels the previous one,
    // so the middle of three quick releases produced nothing at all — and a
    // cancelled run is not a failed run, so nothing alerted.
    expect(workflow).toMatch(/group: release-\$\{\{ github\.ref \}\}/);
  });

  describe('the channel pointer', () => {
    const step = workflow.slice(workflow.indexOf('- name: Point the channel at this release'));

    it('compares versions with the updater\'s own function', () => {
      // Not a second comparator written to agree with it. This guard shipped
      // using `sort -V`, which ranks a prerelease ABOVE its release, under a
      // comment asserting parity — so the first rc→final sequence would have
      // frozen the channel silently.
      expect(step).toContain('source backend/lib/version.sh');
      // NOT backend/update: sourcing that applied its `set -Eeuo pipefail` to the
      // rest of the CI step and executed its top-level code on the runner.
      expect(step).not.toContain('source backend/update');
      expect(step).toContain('version_gt "$VERSION" "$CURRENT_POINTER"');
      expect(step).not.toMatch(/sort -V[^\n]*tail/);
    });

    it('agrees with the updater on the case sort -V gets wrong', () => {
      // Executed, not asserted on text: this is the property that matters, and
      // the reason the two must be the same function.
      const ask = (a, b) =>
        execFileSync(
          'bash',
          ['-c', `source backend/lib/version.sh; version_gt "${a}" "${b}" && echo yes || echo no`],
          { cwd: repo, encoding: 'utf8' }
        ).trim();

      expect(ask('2.3.0', '2.3.0-rc1')).toBe('yes'); // sort -V says no
      expect(ask('2.3.0-rc1', '2.3.0')).toBe('no');
      expect(ask('2.2.10', '2.2.9')).toBe('yes');
      expect(ask('2.2.1-rc10', '2.2.1-rc9')).toBe('yes');
      expect(ask('2.2.0', '2.2.0')).toBe('no');
    });

    it('does not read an unreadable pointer as an absent one', () => {
      // Swallowing every failure meant a rate limit or a 5xx yielded an empty
      // version and skipped the guard entirely — disabling it on exactly the
      // runs where two releases are in flight.
      expect(step).toContain('gh release view "$POINTER"');
      expect(step).toMatch(/could not read the current \$\{CHANNEL\} pointer/);
    });

    it('re-reads after writing, because releases run concurrently', () => {
      // Per-tag serialisation means two tags a minute apart run at once, and
      // --clobber is last-writer-wins: a check before the upload cannot stop an
      // older run overwriting a newer one afterwards.
      expect(step).toContain('--clobber');
      expect(step).toMatch(/SETTLED="\$\(read_pointer\)"/);
      expect(step).toMatch(/for attempt in/);
    });
  });
});

// backend/ is replaced wholesale by an update, so a binary the launcher calls but
// the artifact does not stage disappears from the device on the first OTA. That is
// how futurebit-miner-v3 went missing: the Apollo III's internal miner would not
// start again after updating.
describe('release artifact binaries', () => {
  const realFs = jest.requireActual('fs');
  const minerStart = realFs.readFileSync(
    path.join(repo, 'backend', 'apollo-miner', 'miner_start.sh'),
    'utf8'
  );

  const usbRun = realFs.readFileSync(
    path.join(repo, 'backend', 'apollo-miner', 'usb_miner_run.sh'),
    'utf8'
  );
  const launchedBy = (script) => [
    ...new Set([...script.matchAll(/"\$BIN_DIR"\/([\w.-]+)/g)].map((m) => m[1])),
  ];

  it('stages every binary miner_start.sh launches', () => {
    const launched = launchedBy(minerStart);
    expect(launched).toEqual(
      expect.arrayContaining(['futurebit-miner', 'futurebit-miner-v2', 'futurebit-miner-v3', 'apollo-helper'])
    );
    launched.forEach((bin) => {
      expect(workflow).toMatch(new RegExp(`"\\$m/${bin.replace(/[.-]/g, '\\$&')}"`));
    });
  });

  it('stages every binary usb_miner_run.sh launches', () => {
    // The USB instances run from the same BIN_DIR, so a binary missing from the
    // artifact stops every USB board on the first OTA, exactly like -v3 did.
    const launched = launchedBy(usbRun);
    expect(launched).toEqual(expect.arrayContaining(['futurebit-miner', 'futurebit-miner-v2', 'apollo-helper']));
    launched.forEach((bin) => {
      expect(workflow).toMatch(new RegExp(`"\\$m/${bin.replace(/[.-]/g, '\\$&')}"`));
    });
  });

  it('carries the USB hotplug unit, rule and instance script, and checks them in the stage', () => {
    // backend/ travels whole (tar of the directory), so these are not copied one
    // by one; the stage step verifies them, and the script keeps its execute bit.
    const stage = workflow.slice(workflow.indexOf('- name: Stage the release tree'));
    for (const f of [
      'backend/apollo-miner/usb_miner_run.sh',
      'backend/systemd/apollo-usb-miner@.service',
      'backend/udev/99-apollo-usb-miner.rules',
    ]) {
      expect(stage).toContain(f);
      expect(realFs.existsSync(path.join(repo, f))).toBe(true);
    }
    expect(stage).toContain('[ -x "$STAGE/backend/apollo-miner/usb_miner_run.sh" ]');
    expect(realFs.statSync(path.join(repo, 'backend/apollo-miner/usb_miner_run.sh')).mode & 0o111).not.toBe(0);
  });
});

// The artifact carries the Node its units run. Three things must stay true
// together, or a release builds green and fails on a device: the runtime reaches
// the tarball with its execute bit, the build ran on that same binary, and the
// units point at where it lands.
describe('release artifact Node runtime', () => {
  const realFs = jest.requireActual('fs');
  const read = (...p) => realFs.readFileSync(path.join(repo, ...p), 'utf8');
  const stepBody = (name) => {
    const from = workflow.indexOf(`- name: ${name}`);
    expect(from).toBeGreaterThan(-1);
    const next = workflow.indexOf('\n      - ', from + 1);
    return workflow.slice(from, next === -1 ? undefined : next);
  };

  it('builds on the runtime it ships, not on a setup-node install', () => {
    expect(workflow).not.toContain('actions/setup-node');
    const install = stepBody('Install the Node runtime');
    expect(install).toContain('bash backend/utils/install-node-runtime.sh');
    // First on PATH for every later step, which is also where yarn comes from.
    expect(install).toContain('backend/runtime/node/bin" >> "$GITHUB_PATH"');
    // Before anything that runs node or yarn.
    const at = workflow.indexOf('- name: Install the Node runtime');
    for (const later of ['Install dependencies', 'Lint', 'Test', 'Build the UI', 'Prune to production dependencies']) {
      expect(workflow.indexOf(`- name: ${later}`)).toBeGreaterThan(at);
    }
  });

  it('stages backend/ with the runtime in it, and does not exclude it', () => {
    const stage = stepBody('Stage the release tree');
    // tar, not cp -r: the runtime is full of symlinks (npm, yarn) and modes.
    expect(stage).toMatch(/tar -C backend --exclude='node\/bin\/\*\/x86_64' -cf - \. \| tar -C "\$STAGE\/backend" -xf -/);
    expect(stage).not.toMatch(/--exclude='?[^ ]*runtime/);
  });

  it('checks the staged binary: executable, aarch64 ELF, the version in .nvmrc', () => {
    const stage = stepBody('Stage the release tree');
    expect(stage).toContain('RT="$STAGE/backend/runtime/node/bin/node"');
    expect(stage).toContain('[ -x "$RT" ]');
    expect(stage).toContain('"${HDR:36:4}" = "b700"');
    expect(stage).toContain('WANT="v$(tr -d \'[:space:]\' < .nvmrc)"');
    expect(stage).toContain('"$RT" --version');
    // yarn is what the git-based paths run; a dangling symlink would only show up
    // on a device.
    expect(stage).toContain('backend/runtime/node/bin/yarn" --version');
  });

  it('checks the execute bit survives the tarball', () => {
    const pack = stepBody('Pack and hash');
    expect(pack).toContain('tar --zstd -tvf "$TARBALL"');
    expect(pack).toContain('./backend/runtime/node/bin/node$');
    // The check must read the archive that is hashed and signed, so it comes
    // after the tar that creates it and before the hash.
    expect(pack.indexOf('-tvf')).toBeGreaterThan(pack.indexOf('-cf "$TARBALL"'));
    expect(pack.indexOf('-tvf')).toBeLessThan(pack.indexOf('sha256sum'));
  });

  it('keeps .nvmrc exact and in step with engines, the pins and the lockfile', () => {
    const nvmrc = read('.nvmrc').trim();
    expect(nvmrc).toMatch(/^\d+\.\d+\.\d+$/);
    const major = nvmrc.split('.')[0];
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.engines.node).toBe(`>=${major}`);
    expect(pkg.scripts.build).toBeUndefined();
    expect(pkg.devDependencies.pkg).toBeUndefined();
    // sqlite3 is the only native addon, and the artifact is built on a 24.04 runner
    // but runs on jammy (glibc 2.35) and bookworm (2.36) devices too. The 5.1.7
    // prebuild needs only glibc 2.17; the 6.0.1 prebuild needs 2.38 and libstdc++
    // 3.4.31 and does not even load there. 5.1.7 fell back to compiling from source
    // on Node >= 22.14 only because prebuild-install 7.1.1 pulled napi-build-utils
    // 1.0.2, which compares N-API versions as strings (10 < 6): a source build on
    // the runner would carry the runner's glibc symbols to the device just the same.
    expect(pkg.dependencies.sqlite3).toMatch(/^\^5\.1\./);
    const lock = read('yarn.lock');
    expect(lock).toMatch(/^napi-build-utils@\^2\.0\.0:$/m);
    expect(lock).not.toMatch(/^napi-build-utils@\^1/m);
    expect(read('apolloui-v2', '.nvmrc').trim()).toBe(nvmrc);
    const pins = read('backend', 'utils', 'node-runtime.sha256');
    for (const arch of ['arm64', 'x64']) {
      expect(pins).toMatch(new RegExp(`^[0-9a-f]{64}  node-v${nvmrc.replace(/\./g, '\\.')}-linux-${arch}\\.tar\\.xz$`, 'm'));
    }
    // The exact version, not the floating major tag: the images must not move under .nvmrc.
    for (const f of [['Dockerfile.test'], ['Dockerfile.integration'], ['apolloui-v2', 'Dockerfile']]) {
      expect(read(...f)).toMatch(new RegExp(`^FROM node:${nvmrc.replace(/\./g, '\\.')}-`, 'm'));
    }
  });

  it('points every unit that runs node at the runtime, never at nvm', () => {
    const runtimeNode = '/opt/apolloapi/backend/runtime/node/bin/node';
    const code = (f) =>
      read('backend', 'systemd', f)
        .split('\n')
        .filter((l) => !l.trim().startsWith('#'))
        .join('\n');
    for (const unit of ['apollo-api.service', 'apollo-bootstrap.service', 'apollo-ui-v2.service']) {
      const body = code(unit);
      expect(body).toContain(`ExecStart=${runtimeNode} `);
      expect(body).not.toMatch(/nvm|v21/);
    }
    expect(code('apollo-ui-v2.service')).toMatch(/Environment=PATH=\/opt\/apolloapi\/backend\/runtime\/node\/bin:/);
    // And no other unit or launcher still names an nvm path.
    for (const f of realFs.readdirSync(path.join(repo, 'backend', 'systemd'))) {
      expect(code(f)).not.toContain('/usr/local/nvm');
    }
  });
});
