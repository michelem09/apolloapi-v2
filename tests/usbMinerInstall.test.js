// Static checks over the install/update scripts: every path that lays down the
// systemd units must also lay down the USB miner hotplug unit and udev rule.
// A path that forgets one fails silently on the device (no hotplug), nowhere else.
const fs = require('fs');
const path = require('path');

const backend = path.join(__dirname, '..', 'backend');
const read = (f) => fs.readFileSync(path.join(backend, f), 'utf8');

const INSTALL_PATHS = ['update_system', 'install-v2', 'utils/image_install', 'utils/image_install_solo-node', 'utils/image_update', 'utils/image_update_solo-node'];

// Code lines only: a comment mentioning the unit must not satisfy the check.
// Backslash continuations are joined and quoting/braces dropped, so `cp a b` and
// the multi-line `install -m 644 \ "${APOLLO_DIR}/a" \ b` read the same.
const code = (f) =>
  read(f)
    .replace(/\\\n\s*/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l));
const norm = (f) => code(f).map((l) => l.replace(/\$\{APOLLO_DIR\}/g, '$APOLLO_DIR').replace(/["']/g, '').replace(/\s+/g, ' ').trim());

describe.each(INSTALL_PATHS)('%s', (file) => {
  const lines = norm(file);
  const idx = (re) => lines.findIndex((l) => re.test(l));
  const COPY = '(cp|copy_or_fail|install -m 644)';

  it('copies the USB miner unit and the udev rule', () => {
    expect(idx(new RegExp(`${COPY} \\$APOLLO_DIR/backend/systemd/apollo-usb-miner@\\.service /etc/systemd/system/`))).toBeGreaterThan(-1);
    expect(idx(new RegExp(`${COPY} \\$APOLLO_DIR/backend/udev/99-apollo-usb-miner\\.rules /etc/udev/rules\\.d/`))).toBeGreaterThan(-1);
  });

  it('never enables the template unit (udev and miner_start.sh start it)', () => {
    expect(lines.filter((l) => /systemctl enable.*apollo-usb-miner/.test(l))).toEqual([]);
  });

  it('reloads udev rules after the copies and after daemon-reload', () => {
    const rule = idx(/99-apollo-usb-miner\.rules/);
    const reload = idx(/udevadm control --reload-rules/);
    const daemon = lines.map((l, i) => (/^systemctl daemon-reload/.test(l) ? i : -1)).filter((i) => i >= 0).pop();
    expect(reload).toBeGreaterThan(rule);
    expect(reload).toBeGreaterThan(daemon);
  });
});

// The tarball updater is the path every v2.2 device takes. It owns its unit list
// by name (UNITS) and backs the units up before overwriting them, so the pair has
// to be wired into each of those places, not just copied.
describe('backend/update (OTA)', () => {
  const lines = norm('update');
  const at = (re, from = 0) => lines.findIndex((l, i) => i >= from && re.test(l));

  it('names the pair once, outside the enabled-at-boot list', () => {
    expect(lines).toContain('USB_UNIT=apollo-usb-miner@.service');
    expect(lines).toContain('USB_RULE=99-apollo-usb-miner.rules');
    const units = lines.find((l) => l.startsWith('UNITS='));
    expect(units).not.toMatch(/usb/);
  });

  it('refuses an artifact that lacks the unit, the rule or the instance script', () => {
    const guard = lines.find((l) => /for f in backend\/systemd\/\$USB_UNIT backend\/udev\/\$USB_RULE backend\/apollo-miner\/usb_miner_run\.sh/.test(l));
    expect(guard).toBeDefined();
  });

  it('installs the pair after the units and before daemon-reload, then reloads udev', () => {
    const unit = at(/^install -m 644 \$APOLLO_DIR\/backend\/systemd\/\$USB_UNIT \$SYSTEMD_DIR\/\$USB_UNIT/);
    const rule = at(/^install -m 644 \$APOLLO_DIR\/backend\/udev\/\$USB_RULE \$UDEV_RULES_DIR\/\$USB_RULE/);
    expect(unit).toBeGreaterThan(-1);
    expect(rule).toBeGreaterThan(-1);
    const daemon = at(/^systemctl daemon-reload/, Math.max(unit, rule));
    expect(daemon).toBeGreaterThan(rule);
    expect(at(/^reload_udev_rules$/, daemon)).toBe(daemon + 1);
  });

  it('never enables the template', () => {
    expect(lines.filter((l) => /systemctl enable.*(usb|USB_UNIT)/.test(l))).toEqual([]);
  });

  it('backs the pair up and restores or removes it on rollback', () => {
    const body = (name) => {
      const from = at(new RegExp(`^${name}\\(\\) \\{`));
      expect(from).toBeGreaterThan(-1);
      return lines.slice(from, at(/^\}/, from)).join('\n');
    };
    expect(body('backup_units')).toMatch(/cp -p \$SYSTEMD_DIR\/\$USB_UNIT/);
    expect(body('backup_units')).toMatch(/cp -p \$UDEV_RULES_DIR\/\$USB_RULE/);
    expect(body('restore_units')).toMatch(/rm -f \$SYSTEMD_DIR\/\$USB_UNIT/);
    expect(body('restore_units')).toMatch(/rm -f \$UDEV_RULES_DIR\/\$USB_RULE/);
    expect(body('restore_units')).toMatch(/reload_udev_rules/);
  });

  it('re-announces the attached boards once the miner is started, before the health gate', () => {
    const miner = at(/systemctl start apollo-miner\.service/);
    const trigger = at(/^trigger_usb_miners$/, miner);
    const health = at(/^health_ok \|\| die/, miner);
    expect(trigger).toBeGreaterThan(miner);
    expect(health).toBe(trigger + 1);
    const def = lines.slice(at(/^trigger_usb_miners\(\) \{/)).join('\n');
    // One trigger per matching device: udevadm ORs property-matches, so those (and
    // a whole-subsystem trigger) re-add every STMicro tty. Behaviour: rollback.test.sh.
    expect(def).not.toMatch(/property-match|subsystem-match/);
    expect(def).toMatch(/idVendor/);
    expect(def).toMatch(/idProduct/);
  });
});

describe('update_system', () => {
  // set -Eeuo pipefail + ERR trap here (2.1.x update_system has no `set -e`, the guard is
  // harmless there): an unprotected udevadm failure would abort the update.
  it('never lets a failing udevadm reload abort the update', () => {
    const reloads = code('update_system').filter((l) => /udevadm control --reload-rules/.test(l));
    expect(reloads.length).toBeGreaterThan(0);
    for (const l of reloads) expect(l).toMatch(/\|\|\s*true\s*$/);
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
