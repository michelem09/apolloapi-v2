const fs = require('fs');
const path = require('path');

const read = (...parts) =>
  fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');

// Two files, two lifetimes, on purpose.
//
// They were one for a while, and every consumer inferred something different
// from the same number. Making /tmp/update_progress keep a terminal value — so
// an outcome would survive the window where the updater stops the API — is what
// made a leftover 100 read as a fresh success: serviceMonitor stopped restarting
// crashed services, and the modal replaced the Update button with "Reload App",
// leaving the device unable to take another update through the only path a user
// has.
//
//   /tmp/update_progress   live progress, transient, for older UI bundles only
//   last-update.json       what a run is doing and how it ended, in the state dir
describe('update state — the contract its consumers share', () => {
  const script = read('backend', 'update');

  it('writes a terminal value on success and none on failure', () => {
    // The pre-update bundle completes on `value >= 90` and the run stops at 88,
    // because two gates that can still roll everything back come after it. The
    // updater is the only thing that knows the run finished AND that the release
    // was kept, so it says so here rather than the API inferring it — four
    // attempts at inferring it each traded one defect for another.
    //
    // Safe to leave behind now in a way it was not: the next run truncates it
    // first, and the consumers that made a leftover dangerous are gone —
    // serviceMonitor asks systemd, the current bundle reads the record. What is
    // left is a tab on the PRE-update bundle, for which it is true.
    const success = script.slice(script.indexOf('write_state succeeded "done"'));
    expect(success).toMatch(/echo 100 > "\$TMPFILE"/);

    // Not on failure: that bundle cannot render one, and 100 would read as Done.
    const cleanup = script.match(/^cleanup\(\) \{[\s\S]*?\n\}/m)[0];
    expect(cleanup).toMatch(/rm -f "\$TMPFILE"/);
    expect(cleanup).not.toMatch(/echo \d+ > "\$TMPFILE"/);

    // And truncated at the start of every run, so nothing reads the last one's.
    const start = script.indexOf('progress "starting" 5');
    expect(script.slice(0, start)).toMatch(/rm -f "\$TMPFILE"/);
  });

  it('does not try to release the pre-update bundle from the API', () => {
    // That bundle completes on `value >= 90`; the updater stops at 88 because
    // two gates that still roll everything back come after it. Four rounds were
    // spent closing that gap inside getUpdateProgress and every shape traded one
    // failure for another — the last gated the value on a flag only the NEW
    // protocol sets, which the old bundle does not know exists, so the path was
    // closed entirely while two assertions here pinned it by name and passed.
    //
    // It reports live progress and nothing else now. A pre-update browser needs
    // one reload after the first tarball update, once per device.
    const mcu = read('src', 'services', 'mcu.js');
    const method = mcu.match(/async getUpdateProgress\(\) \{[\s\S]*?\n {2}\}/)[0];
    expect(method).not.toContain('_readUpdateRecord');
    // Exactly one definition, in a class body where the last one wins.
    expect(mcu.match(/async getUpdateProgress\(/g)).toHaveLength(1);
    expect(mcu.match(/async update\(/g)).toHaveLength(1);
  });

  it('records outcomes in the state dir, not in /tmp', () => {
    // The record has to survive both the API restart and a reboot.
    expect(script).toMatch(/LAST_UPDATE_FILE="\$\{STATE_DIR\}\/last-update\.json"/);
    expect(script).not.toMatch(/LAST_UPDATE_FILE=.*\/tmp\//);
  });

  it('writes the record atomically', () => {
    // A reader polling every few seconds must never see half a file.
    const writer = script.match(/write_state\(\) \{[\s\S]*?\n\}/)[0];
    expect(writer).toMatch(/mktemp/);
    expect(writer).toMatch(/mv -f "\$tmp" "\$LAST_UPDATE_FILE"/);
  });

  it('gives every run an identity', () => {
    // What lets a client recognise its own update without comparing its clock to
    // the device's — these boards have no RTC.
    expect(script).toMatch(/^RUN_ID=/m);
    const writer = script.match(/write_state\(\) \{[\s\S]*?\n\}/)[0];
    expect(writer).toContain('--arg run_id "$RUN_ID"');
  });

  it('has a state for a rollback that failed', () => {
    // The one outcome that means SSH is required. Without it, a half-failed
    // rollback was recorded as "rolled-back" and the banner said the device had
    // been restored.
    const cleanup = script.match(/^cleanup\(\) \{[\s\S]*?\n\}/m)[0];
    expect(cleanup).toContain("result='recovery-failed'");
    expect(cleanup).toContain("result='rolled-back'");
    expect(cleanup).toContain("result='aborted'");
    // And it is chosen from whether the restore worked, not from MUTATED alone.
    expect(cleanup).toMatch(/if restore_code; then restored=1; else restored=0; fi/);
  });

  it('asks systemd whether an update is running', () => {
    const monitor = read('src', 'services', 'serviceMonitor.js');
    // Never from a file: both file-based versions latched, and nothing clears
    // that file except the next update. Asserted on the code, not on the prose —
    // the comment explaining why is worth keeping.
    expect(monitor).not.toMatch(/(readFileSync|existsSync)\([^)]*update_progress/);
    expect(monitor).toContain('is-active');
    expect(monitor).toContain('apollo-update.service');
  });
});
