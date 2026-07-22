const fs = require('fs');
const path = require('path');

const read = (...parts) =>
  fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

// /tmp/update_progress has four consumers and they must agree on what a value
// means. It changed from a transient file (deleted at the end) to one that keeps
// its terminal value — 100 after a success, -1 after a failure — so the outcome
// survives the window where the updater stops the API.
//
// That change was shipped without auditing the readers, twice:
//
//   - serviceMonitor keyed off the file's EXISTENCE, so a leftover -1 disabled
//     manual-action detection and the auto-restart of crashed services forever.
//   - NavbarUpdateModal read progress on every mount, so a leftover 100 made
//     every later page load conclude an update had just finished. Five seconds
//     after opening, the Update button was replaced by "Reload App": the device
//     was no longer updatable from the UI at all, after exactly one successful
//     update, with nothing in any log to explain it.
//
// Neither was caught by a test. This one pins the contract in the repo that owns
// the writer.
describe('/tmp/update_progress — the contract its consumers share', () => {
  it('the updater keeps a terminal value instead of deleting the file', () => {
    const script = read('backend', 'update');
    // Success leaves 100 behind; the failure path leaves -1.
    expect(script).toMatch(/echo "100" > "\$TMPFILE"/);
    expect(script).toMatch(/echo "-1" > "\$TMPFILE"/);
    // And the next run truncates it before starting, so a stale value never
    // reads as progress of the run that is beginning.
    expect(script).toMatch(/rm -f "\$TMPFILE"; echo "5" > "\$TMPFILE"/);
  });

  it('serviceMonitor treats a terminal value as "no update running"', () => {
    const source = read('src', 'services', 'serviceMonitor.js');
    // Existence is not the signal — the value is. Keyed on existence, one failed
    // update suppressed service recovery until someone deleted the file by hand.
    expect(source).not.toMatch(/existsSync\(['"]\/tmp\/update_progress/);
    expect(source).toMatch(/value >= 0 && value < 100/);
  });

  it('the modal only interprets progress while following its own update', () => {
    const modal = read(
      'apolloui-v2',
      'src',
      'components',
      'navbar',
      'NavbarUpdateModal.js'
    );

    // The early return has to come before either terminal branch, or a leftover
    // value is read as live progress on a cold mount.
    const gate = modal.indexOf('if (!updateInProgress) return;');
    const failureBranch = modal.indexOf('if (remoteProgress < 0)');
    const doneBranch = modal.indexOf('if (remoteProgress >= 100)');

    expect(gate).toBeGreaterThan(-1);
    expect(failureBranch).toBeGreaterThan(gate);
    expect(doneBranch).toBeGreaterThan(gate);

    // 100 exactly, not >= 90: the updater writes 88 while starting services and
    // two gates that can still roll everything back come after it.
    expect(modal).not.toMatch(/remoteProgress >= 90/);
  });

  it('past outcomes are reported from a different file with a different lifetime', () => {
    const script = read('backend', 'update');
    // Keeping the two separate is what stops "an update is running" and "an
    // update finished" from being the same signal again.
    expect(script).toMatch(/LAST_UPDATE_FILE="\$\{STATE_DIR\}\/last-update\.json"/);
    expect(script).not.toMatch(/LAST_UPDATE_FILE=.*\/tmp\//);
  });
});
