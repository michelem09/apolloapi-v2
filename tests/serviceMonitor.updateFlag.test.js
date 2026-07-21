const fs = jest.requireActual('fs');
const os = require('os');
const path = require('path');

const { isUpdateRunning } = require('../src/services/serviceMonitor');

// The updater leaves a terminal value in the progress file on purpose — -1 when
// it failed, 100 when it succeeded — so the UI can report the outcome once the
// API is back up. serviceMonitor used to treat the file's mere EXISTENCE as "an
// update is in progress", which meant one failed update permanently suppressed
// manual-action detection AND the auto-restart of a crashed service: nothing
// clears that file until the next update runs, and devices do not reboot.
describe('serviceMonitor update-in-progress detection', () => {
  const file = path.join(os.tmpdir(), 'update_progress_test');
  let spy;

  const setProgress = (contents) => {
    if (contents === null) {
      try {
        fs.unlinkSync(file);
      } catch (err) {
        /* already absent */
      }
    } else {
      fs.writeFileSync(file, contents);
    }
  };

  beforeEach(() => {
    // isUpdateRunning reads a fixed path; point its reader at the fixture.
    spy = jest.spyOn(require('fs'), 'readFileSync').mockImplementation((p, enc) => {
      if (String(p).endsWith('update_progress')) return fs.readFileSync(file, enc);
      return jest.requireActual('fs').readFileSync(p, enc);
    });
  });

  afterEach(() => {
    spy.mockRestore();
    setProgress(null);
  });

  it.each([
    ['5', true],
    ['60', true],
    ['95', true],
  ])('reports an update in progress at %s%%', (value, expected) => {
    setProgress(value);
    expect(isUpdateRunning()).toBe(expected);
  });

  it('does not report an update in progress after a successful one', () => {
    setProgress('100');
    expect(isUpdateRunning()).toBe(false);
  });

  it('does not report an update in progress after a failed one', () => {
    // The regression: -1 lingers forever, and treating it as "in progress" left
    // a crashed bitcoind or miner never restarted.
    setProgress('-1');
    expect(isUpdateRunning()).toBe(false);
  });

  it('treats an unreadable or unparseable file as no update', () => {
    setProgress('not a number');
    expect(isUpdateRunning()).toBe(false);
  });

  it('treats an absent file as no update', () => {
    setProgress(null);
    expect(isUpdateRunning()).toBe(false);
  });
});
