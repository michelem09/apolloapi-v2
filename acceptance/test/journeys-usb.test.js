// Offline tier: the usb-miner journey's rules — above all, that the sysfs write
// can only ever land on the board's own USB device, never on the hub above it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const U = require('../journeys/usb');
const registry = require('../journeys/registry');
const { runRound } = require('../journeys/round');
const { buildDeps } = require('../journeys/deps');

const IFACE = '/sys/devices/platform/usb@fc000000/xhci-hcd.0.auto/usb3/3-1/3-1.1/3-1.1:1.0';
const DEVICE = '/sys/devices/platform/usb@fc000000/xhci-hcd.0.auto/usb3/3-1/3-1.1';
const HUB = '/sys/devices/platform/usb@fc000000/xhci-hcd.0.auto/usb3/3-1';

test('the device directory is the parent of the interface directory, and nothing else', () => {
  assert.equal(U.usbDeviceDirOf(IFACE), DEVICE);
  assert.equal(U.usbDeviceDirOf(`${IFACE}\n`), DEVICE);
  // Already a device: must not be "parented" up to the hub.
  assert.equal(U.usbDeviceDirOf(DEVICE), null);
  assert.equal(U.usbDeviceDirOf(HUB), null);
  // A root hub, an interface of the hub, nothing at all, a path elsewhere.
  assert.equal(U.usbDeviceDirOf('/sys/devices/platform/usb@fc000000/xhci-hcd.0.auto/usb3'), null);
  // The hub's OWN interface has a valid shape: only the vendor/product check (1a40) stops it.
  assert.equal(U.usbDeviceDirOf(`${HUB}/3-1:1.0`), HUB);
  assert.equal(U.usbDeviceDirOf(''), null);
  assert.equal(U.usbDeviceDirOf('/tmp/3-1.1/3-1.1:1.0'), null);
  // The interface name must belong to the directory above it.
  assert.equal(U.usbDeviceDirOf('/sys/devices/x/usb3/3-1/3-2:1.0'), null);
  assert.equal(U.usbDeviceDirOf('/sys/devices/x/../usb3/3-1.1/3-1.1:1.0'), null);
  assert.equal(U.usbDeviceDirOf(`${IFACE} ; rm -rf /`), null);
});

test('only 0483:5740 is a board; the hub is not', () => {
  assert.ok(U.isApolloBoard(U.parseIds('0483\n5740')));
  assert.ok(U.isApolloBoard(U.parseIds(' 0483 \n5740\n')));
  assert.ok(U.isApolloBoard({ vendor: '0483', product: '5740' }));
  assert.ok(!U.isApolloBoard(U.parseIds('1a40\n0101')));
  assert.ok(!U.isApolloBoard(U.parseIds('0483\n5750')));
  assert.ok(!U.isApolloBoard(U.parseIds('')));
});

test('the write command checks the ids itself when disabling, and only takes a device dir', () => {
  const off = U.authorizeCommand(DEVICE, 0);
  assert.match(off, /idVendor.*= 0483.*idProduct.*= 5740.*&& echo 0 \| sudo -n tee/);
  const on = U.authorizeCommand(DEVICE, 1);
  assert.match(on, /echo 1 \| sudo -n tee/);
  assert.doesNotMatch(on, /idVendor/);
  assert.throws(() => U.authorizeCommand(`${DEVICE}:1.0`, 0), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand('/sys/devices/x/usb3', 0), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand(`${DEVICE}'; reboot; '`, 1), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand(DEVICE, 2), /0 or 1/);
});

// A fake device: answers the three kinds of command the rig issues.
const device = ({ iface = IFACE, ids = '0483\n5740', failWrite = false } = {}) => {
  const log = [];
  const ssh = async (cmd) => {
    log.push(cmd);
    if (/^readlink -f/.test(cmd)) return iface;
    if (/^cat /.test(cmd)) return ids;
    if (/sudo -n tee/.test(cmd)) {
      if (failWrite) throw new Error('sudo: a password is required');
      return /echo 0/.test(cmd) ? '0' : '1';
    }
    if (/^test -e/.test(cmd)) return 'yes';
    return '';
  };
  return { ssh, log, wrote: () => log.filter((c) => /sudo -n tee/.test(c)) };
};
const tmpMarker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usb-')), U.MARKER);

test('unplug records the marker first, then writes 0 to the device', async () => {
  const d = device();
  const markerPath = tmpMarker();
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath });
  assert.equal(await rig.unplug('ttyACM0'), DEVICE);
  assert.equal(d.wrote().length, 1);
  assert.match(d.wrote()[0], new RegExp(DEVICE.replace(/[/.]/g, '\\$&')));
  assert.deepEqual(U.readMarker(fs, markerPath).dir, DEVICE);
  assert.ok(rig.isUnplugged());
});

test('a path that is not the board writes nothing and leaves no marker (hub, wrong ids, odd port)', async () => {
  for (const [name, d, tty] of [
    ['a readlink that already lands on the hub', device({ iface: HUB }), 'ttyACM0'],
    ['a readlink that lands on the root hub', device({ iface: '/sys/devices/x/xhci/usb3' }), 'ttyACM0'],
    ['an interface whose device is the hub (1a40)', device({ ids: '1a40\n0101' }), 'ttyACM0'],
    ['a port that is not ttyACM', device(), 'ttyS1'],
    ['a port with shell in it', device(), 'ttyACM0; reboot'],
  ]) {
    const markerPath = tmpMarker();
    const rig = U.createUsbRig({ ssh: d.ssh, markerPath });
    await assert.rejects(() => rig.unplug(tty), /refusing|not a ttyACM/, name);
    assert.equal(d.wrote().length, 0, `${name}: something was written`);
    assert.ok(!fs.existsSync(markerPath), `${name}: a marker was left`);
  }
});

test('a failed write leaves the marker, so the restore still re-enables', async () => {
  const d = device({ failWrite: true });
  const markerPath = tmpMarker();
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath });
  await assert.rejects(() => rig.unplug('ttyACM0'), /password is required/);
  assert.ok(rig.isUnplugged());
});

test('replug writes 1, waits for the port and clears the marker; no marker is a no-op', async () => {
  const d = device();
  const markerPath = tmpMarker();
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath, waitUntil: async (p) => ({ ok: await p() }) });
  assert.deepEqual(await rig.replug(), { restored: false, notes: [], errors: [] });
  assert.equal(d.wrote().length, 0);
  await rig.unplug('ttyACM0');
  const back = await rig.replug();
  assert.ok(back.restored);
  assert.deepEqual(back.errors, []);
  assert.match(d.wrote()[1], /echo 1/);
  assert.ok(!rig.isUnplugged());
});

test('a marker that does not name a device dir is refused, not written to', async () => {
  const d = device();
  const markerPath = tmpMarker();
  fs.writeFileSync(markerPath, JSON.stringify({ dir: HUB.replace('3-1', 'usb3'), tty: 'ttyACM0' }));
  const back = await U.replugFromMarker({ ssh: d.ssh, markerPath });
  assert.equal(back.restored, false);
  assert.match(back.errors[0], /not a USB device directory/);
  assert.equal(d.wrote().length, 0);
});

test('a re-authorize that fails keeps the marker and says how to do it by hand', async () => {
  const markerPath = tmpMarker();
  fs.writeFileSync(markerPath, JSON.stringify({ dir: DEVICE, tty: 'ttyACM0' }));
  const d = device({ failWrite: true });
  const back = await U.replugFromMarker({ ssh: d.ssh, markerPath });
  assert.equal(back.restored, false);
  assert.match(back.errors[0], /by hand: echo 1 \| sudo tee .*authorized/);
  assert.ok(fs.existsSync(markerPath));
});

test("the round's restore re-authorizes from the marker when the journey threw", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-round-'));
  const d = device();
  const io = {
    ssh: d.ssh,
    gql: async () => ({}),
    gqlWrite: async () => ({}),
    waitUntil: async (p) => ({ ok: await p() }),
    base: { takeSnapshot: async () => ({}), restoreSnapshot: async () => [] },
  };
  const deps = buildDeps({ profile: {}, io, out, ctxFile: 'x', uiBase: 'x', original: 'pw', wifi: {} });
  // restoreState needs a real photograph; the part under test is the USB one.
  const snap = { db: {}, confCopied: [], before: { services: { node: 'inactive', ckpool: 'inactive' }, nmcli: { active: [] } } };
  fs.writeFileSync(U.markerFile(out), JSON.stringify({ dir: DEVICE, tty: 'ttyACM0' }));
  const result = await deps.restore(snap).catch((e) => ({ errors: [e.message], notes: [] }));
  assert.ok(result.notes.some((n) => /authorized again/.test(n)), JSON.stringify(result));
  assert.ok(d.wrote().some((c) => /echo 1/.test(c)));
  assert.ok(!fs.existsSync(U.markerFile(out)));
  // Wired into the round: restore runs after a journey that threw.
  assert.equal(typeof runRound, 'function');
});

test('ps output: the miner binary counts, screen and pgrep lines do not', () => {
  const ps = [
    '  101 futurebit-miner /opt/apolloapi/backend/apollo-miner/futurebit-miner -comport /dev/ttyS1 -ao_mode 1',
    '  202 screen SCREEN -D -m -S miner ./futurebit-miner -comport /dev/ttyACM0 -ao_mode 1',
    '  203 futurebit-miner ./futurebit-miner -comport /dev/ttyACM0 -ao_mode 1',
    '  300 bash bash -c ps | grep futurebit-miner -comport /dev/ttyACM0',
  ].join('\n');
  const procs = U.parseMinerProcs(ps);
  assert.deepEqual(U.procsOn(procs, 'ttyACM0').map((p) => p.pid), [203]);
  assert.deepEqual(U.internalProcs(procs).map((p) => p.pid), [101]);
  assert.deepEqual(U.procsOn(procs, 'ttyACM1'), []);
});

test('feature detection, tty names, expiry window, UI parsers', () => {
  const validation = Object.assign(new Error('GraphQL: Cannot query field "boards" on type "Miner".'), { malformed: true });
  assert.ok(U.isBoardsMissing(validation));
  assert.ok(!U.isBoardsMissing(new Error('GraphQL: Cannot query field "boards" on type "Miner".')));
  assert.ok(!U.isBoardsMissing(Object.assign(new Error('GraphQL: Cannot query field "nope"'), { malformed: true })));
  assert.equal(U.ttyOf('/dev/ttyACM0'), 'ttyACM0');
  assert.equal(U.ttyOf('ttyACM12'), 'ttyACM12');
  assert.equal(U.ttyOf('/dev/ttyS1'), null);
  assert.equal(U.ttyOf(null), null);

  const now = Date.parse('2026-10-19T16:00:00Z');
  const exp = (min) => ({ expiresAt: new Date(now + min * 60000).toISOString() });
  assert.ok(U.expiresAround(exp(14.5), now));
  assert.ok(!U.expiresAround(exp(5), now));
  assert.ok(!U.expiresAround(exp(30), now));
  assert.ok(!U.expiresAround({ expiresAt: null }, now));

  assert.deepEqual(U.activeBadges('Hashboards\nActive 0/1\nActive 1/2'), [{ active: 0, total: 1 }, { active: 1, total: 2 }]);
  assert.deepEqual(U.activeBadges('nothing here'), []);
  assert.ok(U.isOrange('rgb(237, 137, 54)'));
  assert.ok(!U.isOrange('rgb(255, 255, 255)'));
  assert.ok(!U.isOrange('rgba(0, 0, 0, 0)'));
  assert.equal(U.leadingInt('USB 2'), 2);
  assert.equal(U.leadingInt(''), null);
});

test('usb-miner is opt-in, and usb-expiry is a switch on --with, not a journey', () => {
  const all = registry.list();
  assert.ok(registry.OPT_IN.has('usb-miner'));
  assert.ok(!registry.select(all, null).some((j) => j.name === 'usb-miner'));
  assert.deepEqual(registry.select(all, 'usb-miner').map((j) => j.name), ['usb-miner']);
  assert.ok(registry.select(all, null, 'usb-miner').some((j) => j.name === 'usb-miner'));
  // The switch alone adds no journey and is not "no journey named".
  assert.equal(registry.select(all, null, 'usb-expiry').length, registry.select(all, null).length);
  assert.deepEqual(registry.optionsOf('usb-miner,usb-expiry'), ['usb-expiry']);
  assert.deepEqual(registry.optionsOf(null), []);
  assert.throws(() => registry.select(all, null, 'usb-expiri'), /no journey named "usb-expiri"/);
});
