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
      expect(step).toContain('APOLLO_UPDATE_LIB=1 source backend/update');
      expect(step).toContain('version_gt "$VERSION" "$CURRENT_POINTER"');
      expect(step).not.toMatch(/sort -V[^\n]*tail/);
    });

    it('agrees with the updater on the case sort -V gets wrong', () => {
      // Executed, not asserted on text: this is the property that matters, and
      // the reason the two must be the same function.
      const ask = (a, b) =>
        execFileSync(
          'bash',
          ['-c', `APOLLO_UPDATE_LIB=1 source backend/update; version_gt "${a}" "${b}" && echo yes || echo no`],
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
