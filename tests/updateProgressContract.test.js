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

  it('keeps progress transient', () => {
    // Deleted on both terminal paths, so nothing can read a leftover as current.
    const success = script.slice(script.indexOf('write_state succeeded "done"'));
    expect(success).toMatch(/rm -f "\$TMPFILE"/);
    const cleanup = script.match(/^cleanup\(\) \{[\s\S]*?\n\}/m)[0];
    expect(cleanup).toMatch(/rm -f "\$TMPFILE"/);
    expect(cleanup).not.toMatch(/echo "-1" > "\$TMPFILE"/);
  });

  it('still lets the pre-update UI bundle finish', () => {
    // The assertion above, alone, certified a break. Deleting the file is right,
    // but the file's only consumer is the bundle loaded BEFORE the update — the
    // one this update replaces — and that bundle completes solely on
    // `value >= 90`. The updater stops at 88 on purpose (two gates that still
    // roll everything back come after it) and then removes the file, so that
    // browser watched 5 -> 88, lost the API, reconnected, read 0, and sat on
    // "Updating... 0%" after a SUCCESSFUL update with its close button hidden.
    //
    // The record closes it, because it knows the run ended AND how. Asserted on
    // the API, since that is where the compatibility now lives.
    const mcu = read('src', 'services', 'mcu.js');
    const method = mcu.match(/async getUpdateProgress\(\) \{[\s\S]*?\n {2}\}/)[0];
    expect(method).toContain('_readUpdateRecord');
    // The behaviour is covered by tests/mcu.updateProgress.test.js, which drives
    // the method instead of reading it. Two source-text assertions used to live
    // here pinning the gate by name; when that gate was changed to one the old
    // bundle can never satisfy — it polls updateProgress and knows nothing about
    // updateStatus — they kept passing, so CI certified the break.
    expect(method).toMatch(/state === 'succeeded'.*\{ value: 100 \}/s);
    // Only a success. Reporting 100 for a rollback would make that bundle render
    // "Done!" for an update that was reverted.
    expect(method).not.toMatch(/state !== 'succeeded'.*\{ value: 100 \}/s);
    // And exactly one definition of it, in a class body where the last wins.
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
