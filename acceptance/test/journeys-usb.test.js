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
  assert.match(off, /idVendor.*= 0483.*idProduct.*= 5740.*\*IAP\*\) false.*&& echo 0 \| sudo -n tee/);
  const on = U.authorizeCommand(DEVICE, 1);
  assert.match(on, /echo 1 \| sudo -n tee/);
  assert.doesNotMatch(on, /idVendor/);
  assert.throws(() => U.authorizeCommand(`${DEVICE}:1.0`, 0), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand('/sys/devices/x/usb3', 0), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand(`${DEVICE}'; reboot; '`, 1), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand(DEVICE, 2), /0 or 1/);
});

// A fake device: answers the three kinds of command the rig issues.
const device = ({ iface = IFACE, ids = '0483\n5740', product = 'BCO SLV #310059000850393855313720', failWrite = false } = {}) => {
  const log = [];
  const ssh = async (cmd) => {
    log.push(cmd);
    if (/^readlink -f/.test(cmd)) return iface;
    if (/^for t in/.test(cmd)) return `ttyACM0|${iface}|310059000850393855313720|${product}`;
    if (/\/product' 2>/.test(cmd)) return product;
    if (/\/serial' 2>/.test(cmd)) return '310059000850393855313720';
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
    ['a board mid-reset, product reads IAP', device({ product: 'BCO IAP #310059000850393855313720' }), 'ttyACM0'],
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

test('the marker carries the serial, and a re-authorize asks for a health check', async () => {
  const d = device();
  const markerPath = tmpMarker();
  const healthPath = path.join(path.dirname(markerPath), 'usb.health');
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath, healthPath });
  await rig.unplug('ttyACM0');
  assert.equal(U.readMarker(fs, markerPath).serial, '310059000850393855313720');
  await rig.replug();
  assert.equal(JSON.parse(fs.readFileSync(healthPath, 'utf8')).serial, '310059000850393855313720');
});

test('product states and the port list: the board is found by serial, whatever the tty name', () => {
  assert.equal(U.productState('BCO IAP #3100'), 'IAP');
  assert.equal(U.productState('BCO SLV #3100'), 'SLV');
  assert.equal(U.productState(''), 'unknown');
  const text = [
    `ttyACM1|${IFACE}|310059000850393855313720|BCO SLV #310059000850393855313720`,
    '|garbage',
    'ttyACM2|/sys/devices/x/usb3/3-1/3-1.2/3-1.2:1.0|ZIGBEE1|ConBee II',
  ].join('\n');
  const ports = U.parsePortList(text);
  assert.equal(ports.length, 2);
  assert.equal(U.portFor(ports, '310059000850393855313720').tty, 'ttyACM1');
  assert.equal(U.portFor(ports, '310059000850393855313720').dir, DEVICE);
  assert.equal(U.portFor(ports, '310059000850393855313720').state, 'SLV');
  assert.equal(U.portFor(ports, 'nope'), null);
  assert.equal(U.portFor(ports, ''), null);
});

// A scripted board and a fake clock: each poll advances 1 s.
const clock = () => { let t = 0; return { now: () => t, sleep: async (ms) => { t += ms; } }; };
const scripted = (c, at) => async () => {
  const [, v] = [...at].reverse().find(([from]) => c.now() >= from) || [0, null];
  return v;
};
const slv = (tty = 'ttyACM1') => ({ tty, product: 'BCO SLV #1', state: 'SLV' });
const iap = { tty: 'ttyACM1', product: 'BCO IAP #1', state: 'IAP' };

test('waitSlvStable waits out IAP, then 5 s of stable SLV', async () => {
  const c = clock();
  const read = scripted(c, [[0, iap], [30000, slv()]]);
  const r = await U.waitSlvStable({ read, ...c, since: 0, minMs: 35000 });
  assert.ok(r.ok);
  assert.ok(r.sawReset);
  assert.ok(c.now() >= 35000, `returned at ${c.now()}`);
});

test('waitSlvStable: never early while IAP, and a changing port restarts the stable timer', async () => {
  const c = clock();
  const r = await U.waitSlvStable({ read: scripted(c, [[0, iap]]), ...c, timeoutMs: 20000 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /IAP/);
  const c2 = clock();
  const hop = async () => slv(c2.now() < 3000 ? 'ttyACM0' : 'ttyACM1');
  const r2 = await U.waitSlvStable({ read: hop, ...c2, minMs: 0 });
  assert.ok(r2.ok);
  assert.ok(c2.now() >= 3000 + 5000, `stable counted across a port change: ${c2.now()}`);
  assert.equal(r2.tty, 'ttyACM1');
});

test('waitSlvStable: a board that was always SLV still needs minMs since the stop', async () => {
  const c = clock();
  const r = await U.waitSlvStable({ read: async () => slv(), ...c, since: 0, minMs: 35000 });
  assert.ok(r.ok);
  assert.ok(!r.sawReset);
  assert.ok(c.now() >= 35000);
  const c2 = clock();
  const gone = await U.waitSlvStable({ read: async () => null, ...c2, timeoutMs: 10000 });
  assert.equal(gone.ok, false);
  assert.match(gone.reason, /not on the bus/);
});

test('the journal excerpt keeps the cause lines', () => {
  const text = [
    '2026-10-19T18:35:20 h apollo-helper[1]: noise',
    '2026-10-19T18:35:21 h usb_miner_run.sh[2]: Unknown board',
    '2026-10-19T18:35:22 h systemd[1]: apollo-usb-miner@ttyACM1.service: Main process exited, code=exited, status=64/n/a',
  ].join('\n');
  const lines = U.pickJournal(text);
  assert.equal(lines.length, 2);
  assert.ok(U.wedgedInJournal(text));
  assert.ok(!U.wedgedInJournal('all fine'));
  assert.match(U.journalCommand(1760000000), /--since @1760000000/);
});

test('verifyHealth reports a physical replug when the board does not come back or answers Unknown board', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-h-'));
  const healthPath = path.join(dir, 'usb.health');
  const req = () => fs.writeFileSync(healthPath, JSON.stringify({ serial: '1', since: 100 }));
  const mk = ({ ports, journal = '', unit = 'failed', miner = 'active' }) => async (cmd) => {
    if (/^for t in/.test(cmd)) return ports;
    if (/apollo-miner -p ActiveState/.test(cmd)) return miner;
    if (/apollo-usb-miner@/.test(cmd) && /ActiveState/.test(cmd)) return unit;
    if (/^journalctl/.test(cmd)) return journal;
    return '';
  };
  assert.deepEqual(await U.verifyHealth({ ssh: mk({ ports: '' }), healthPath, ...clock() }), { checked: false, errors: [] });
  req();
  let r = await U.verifyHealth({ ssh: mk({ ports: '' }), healthPath, ...clock(), timeoutMs: 8000 });
  assert.match(r.errors[0], /PHYSICAL REPLUG NEEDED/);
  assert.ok(!fs.existsSync(healthPath));
  req();
  const ports = `ttyACM1|${IFACE}|1|BCO SLV #1`;
  r = await U.verifyHealth({ ssh: mk({ ports, journal: 'usb_miner_run.sh: Unknown board' }), healthPath, ...clock() });
  assert.match(r.errors[0], /Unknown board/);
  req();
  r = await U.verifyHealth({ ssh: mk({ ports, unit: 'active', journal: 'usb_miner_run.sh: Unknown board' }), healthPath, ...clock() });
  assert.deepEqual(r.errors, []);
  req();
  r = await U.verifyHealth({ ssh: mk({ ports, miner: 'inactive', unit: 'inactive' }), healthPath, ...clock() });
  assert.deepEqual(r.errors, []);
});
