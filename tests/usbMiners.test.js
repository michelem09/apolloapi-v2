const fs = require('fs');
const os = require('os');
const path = require('path');
const { hasUsbMiners, resetUsbMinersCache, GRACE_MS } = require('../src/usbMiners');

describe('usbMiners (delegates to the board registry)', () => {
  let dir;
  let env;
  beforeEach(() => {
    resetUsbMinersCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usbm-'));
    fs.mkdirSync(path.join(dir, 'dev'));
    env = {
      APOLLO_USB_DEV_DIR: path.join(dir, 'dev'),
      APOLLO_USB_SYS_DIR: path.join(dir, 'nosys'),
      APOLLO_MINER_STATS_DIR: path.join(dir, 'nostats'),
      ARMBIAN_RELEASE_FILE: path.join(dir, 'none'),
    };
  });
  afterEach(() => {
    resetUsbMinersCache();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('false without ttyACM, true with one', () => {
    const t = Date.now();
    expect(hasUsbMiners(env, t)).toBe(false);
    fs.writeFileSync(path.join(dir, 'dev', 'ttyACM0'), '');
    expect(hasUsbMiners(env, t)).toBe(true);
  });

  test('ttyS / other nodes do not count', () => {
    fs.writeFileSync(path.join(dir, 'dev', 'ttyS1'), '');
    expect(hasUsbMiners(env, Date.now())).toBe(false);
  });

  test('a short unplug keeps the answer true; 15 min later it is false', () => {
    const t = Date.now();
    const node = path.join(dir, 'dev', 'ttyACM0');
    fs.writeFileSync(node, '');
    expect(hasUsbMiners(env, t)).toBe(true);
    fs.rmSync(node);
    expect(hasUsbMiners(env, t + 1000)).toBe(true);
    expect(hasUsbMiners(env, t + 60000)).toBe(true); // disconnected board still counts
    expect(hasUsbMiners(env, t + 16 * 60000)).toBe(false);
  });

  test('keeps the v2.2 export', () => {
    expect(GRACE_MS).toBe(60000);
  });
});
