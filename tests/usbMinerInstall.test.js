// Static checks over the install/update scripts: every path that lays down the
// systemd units must also lay down the USB miner hotplug unit and udev rule.
// A path that forgets one fails silently on the device (no hotplug), nowhere else.
const fs = require('fs');
const path = require('path');

const backend = path.join(__dirname, '..', 'backend');
const read = (f) => fs.readFileSync(path.join(backend, f), 'utf8');

const INSTALL_PATHS = ['update_system', 'install-v2', 'utils/image_install', 'utils/image_install_solo-node', 'utils/image_update', 'utils/image_update_solo-node'];

// Code lines only: a comment mentioning the unit must not satisfy the check.
const code = (f) =>
  read(f)
    .split('\n')
    .filter((l) => !/^\s*#/.test(l));

describe.each(INSTALL_PATHS)('%s', (file) => {
  const lines = code(file);
  const idx = (re) => lines.findIndex((l) => re.test(l));

  it('copies the USB miner unit and the udev rule', () => {
    expect(idx(/(cp|copy_or_fail) \$APOLLO_DIR\/backend\/systemd\/apollo-usb-miner@\.service \/etc\/systemd\/system\//)).toBeGreaterThan(-1);
    expect(idx(/(cp|copy_or_fail) \$APOLLO_DIR\/backend\/udev\/99-apollo-usb-miner\.rules \/etc\/udev\/rules\.d\//)).toBeGreaterThan(-1);
  });

  it('never enables the template unit (udev and miner_start.sh start it)', () => {
    expect(lines.filter((l) => /systemctl enable.*apollo-usb-miner/.test(l))).toEqual([]);
  });

  it('reloads udev rules after the copies and after daemon-reload', () => {
    const rule = idx(/99-apollo-usb-miner\.rules/);
    const reload = idx(/udevadm control --reload-rules/);
    const daemon = idx(/^systemctl daemon-reload/);
    expect(reload).toBeGreaterThan(rule);
    expect(reload).toBeGreaterThan(daemon);
  });
});

describe('uninstall-v2', () => {
  const lines = code('uninstall-v2');
  it('removes the unit and the rule, then reloads udev', () => {
    expect(lines).toContain('rm -f /etc/systemd/system/apollo-usb-miner@.service');
    const rm = lines.indexOf('rm -f /etc/udev/rules.d/99-apollo-usb-miner.rules');
    expect(rm).toBeGreaterThan(-1);
    expect(lines.indexOf('udevadm control --reload-rules')).toBeGreaterThan(rm);
  });
});

describe('set_UI_mode.sh', () => {
  const lines = code('utils/set_UI_mode.sh');
  it('no longer probes ttyACM ports or runs apollo-helper at boot', () => {
    expect(lines.filter((l) => /ttyACM|apollo-helper/.test(l))).toEqual([]);
  });
  it('never writes NEXT_PUBLIC_USB_MINERS, only removes it', () => {
    expect(lines.filter((l) => /set_env_var\s+"NEXT_PUBLIC_USB_MINERS"/.test(l))).toEqual([]);
    expect(lines).toContain('remove_env_var "NEXT_PUBLIC_USB_MINERS"');
  });
  it('removes the stale NEXT_PUBLIC_DEVICE_TYPE and keeps the chassis logic', () => {
    expect(lines).toContain('remove_env_var "NEXT_PUBLIC_DEVICE_TYPE"');
    expect(lines.some((l) => /set_env_var "NEXT_PUBLIC_CHASSIS" "solo-node"/.test(l))).toBe(true);
    expect(lines.some((l) => /set_env_var "NEXT_PUBLIC_CHASSIS" "apollo-iii"/.test(l))).toBe(true);
  });
});
