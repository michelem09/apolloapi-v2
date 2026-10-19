// Offline tier: the usb-miner journey's rules — above all, that the driver unbind
// can only ever land on the board's own USB interface, never on the hub above it,
// and that `authorized` is never written to 0.
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

test('authorized can only be enabled; a deauthorize is not expressible', () => {
  const on = U.authorizeCommand(DEVICE, 1);
  assert.match(on, /echo 1 \| sudo -n tee/);
  require('child_process').execFileSync('sh', ['-n', '-c', on]);
  assert.throws(() => U.authorizeCommand(DEVICE, 0), /never writes authorized=0/);
  assert.throws(() => U.authorizeCommand(`${DEVICE}:1.0`, 1), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand('/sys/devices/x/usb3', 1), /not a USB device directory/);
  assert.throws(() => U.authorizeCommand(`${DEVICE}'; reboot; '`, 1), /not a USB device directory/);
  // Nothing the journey builds can write a 0.
  for (const cmd of [on, U.bindCommand('3-1.1:1.0'), U.unbindCommand('3-1.1:1.0', { serial: 'S' })]) {
    assert.doesNotMatch(cmd, /echo 0 \|/);
  }
});

test('the unbind command checks, in the shell, everything the JS checked; bind is idempotent', () => {
  const off = U.unbindCommand('3-1.1:1.0', { serial: '3100' });
  assert.match(off, /apollo-miner -p ActiveState.*= active \].*not active.*idVendor.*0483:5740.*\*SLV\*\) ;;.*not SLV.*\[ "\$sn" = '3100' \].*is not bound to cdc_acm.*cdc_acm\/unbind/);
  assert.doesNotMatch(U.unbindCommand('3-1.1:1.0'), /\$sn" =/);
  const on = U.bindCommand('3-1.1:1.0');
  assert.match(on, /\[ -e \/sys\/bus\/usb\/drivers\/cdc_acm\/\$i \] && \{ echo bound; exit 0; \}/);
  assert.match(on, /0483:5740/);
  // Syntax of what is sent to the device's shell, refusal messages included.
  for (const cmd of [off, on, U.unbindCommand('3-1.1:1.0'), U.IFACE_SCAN_CMD, U.USB_SCAN_CMD, U.PORT_LIST_CMD, U.MANUAL_RESTORE]) {
    require('child_process').execFileSync('sh', ['-n', '-c', cmd]);
  }
  // Only an interface name goes in: not a device, a hub, a path, shell.
  for (const bad of ['3-1.1', 'usb3', '3-1.1:1.0; reboot', '../3-1:1.0', '', '3-1.1:1']) {
    assert.throws(() => U.unbindCommand(bad), /not a USB interface name/, bad);
    assert.throws(() => U.bindCommand(bad), /not a USB interface name/, bad);
  }
  assert.ok(U.isIfaceName('3-1.1:1.0'));
  assert.ok(U.isIfaceName('12-3.4.5:1.1'));
});

// A fake device: answers the commands the rig issues.
const IFNAME = '3-1.1:1.0';
const device = ({ iface = IFACE, ids = '0483\n5740', product = 'BCO SLV #310059000850393855313720', failWrite = false, minerState = 'active', bound = true } = {}) => {
  const log = [];
  const ssh = async (cmd) => {
    log.push(cmd);
    if (/^readlink -f/.test(cmd)) return iface;
    if (/^for t in/.test(cmd)) return `ttyACM0|${iface}|310059000850393855313720|${product}`;
    if (/^systemctl show apollo-miner/.test(cmd)) return minerState;
    if (/udevadm trigger/.test(cmd)) return '';
    if (/\/product' 2>/.test(cmd)) return product;
    if (/\/serial' 2>/.test(cmd)) return '310059000850393855313720';
    if (/^cat /.test(cmd)) return ids;
    if (/cdc_acm\/unbind/.test(cmd)) {
      if (failWrite) throw new Error('sudo: a password is required');
      return 'unbound';
    }
    if (/cdc_acm\/bind/.test(cmd)) {
      if (failWrite) throw new Error('sudo: a password is required');
      return 'bound';
    }
    if (/sudo -n tee/.test(cmd) && /authorized/.test(cmd)) {
      if (failWrite) throw new Error('sudo: a password is required');
      return '1';
    }
    if (/^test -e .*cdc_acm/.test(cmd)) return bound ? 'yes' : 'no';
    if (/^test -e/.test(cmd)) return 'yes';
    return '';
  };
  return {
    ssh,
    log,
    // Writes that cut a board off, or enable a device (never a bind).
    wrote: () => log.filter((c) => /cdc_acm\/unbind|\/authorized/.test(c)),
    unbinds: () => log.filter((c) => /cdc_acm\/unbind/.test(c)),
    binds: () => log.filter((c) => /cdc_acm\/bind/.test(c)),
    authorizes: () => log.filter((c) => /sudo -n tee/.test(c) && /\/authorized/.test(c)),
  };
};
const tmpMarker = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'usb-')), U.MARKER);

test('unplug records the marker first, then unbinds cdc_acm from the board interface', async () => {
  const d = device();
  const markerPath = tmpMarker();
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath });
  assert.equal(await rig.unplug('ttyACM0'), IFNAME);
  assert.equal(d.unbinds().length, 1);
  assert.match(d.unbinds()[0], /i='3-1\.1:1\.0'/);
  assert.equal(d.authorizes().length, 0, 'authorized must never be written');
  const m = U.readMarker(fs, markerPath);
  assert.equal(m.iface, IFNAME);
  assert.equal(m.serial, '310059000850393855313720');
  assert.ok(rig.isUnplugged());
});

test('a path that is not the board writes nothing and leaves no marker (hub, wrong ids, odd port)', async () => {
  for (const [name, d, tty] of [
    ['a readlink that already lands on the hub', device({ iface: HUB }), 'ttyACM0'],
    ['a readlink that lands on the root hub', device({ iface: '/sys/devices/x/xhci/usb3' }), 'ttyACM0'],
    ['an interface whose device is the hub (1a40)', device({ ids: '1a40\n0101' }), 'ttyACM0'],
    ['a board mid-reset, product reads IAP', device({ product: 'BCO IAP #310059000850393855313720' }), 'ttyACM0'],
    ['an interface that is not bound to cdc_acm', device({ bound: false }), 'ttyACM0'],
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

test('a failed unbind leaves the marker, so the restore still binds', async () => {
  const d = device({ failWrite: true });
  const markerPath = tmpMarker();
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath });
  await assert.rejects(() => rig.unplug('ttyACM0'), /password is required/);
  assert.ok(rig.isUnplugged());
});

test('replug binds the interface, waits for the port and clears the marker; no marker is a no-op', async () => {
  const d = device();
  const markerPath = tmpMarker();
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath, waitUntil: async (p) => ({ ok: await p() }) });
  assert.deepEqual(await rig.replug(), { restored: false, notes: [], errors: [] });
  assert.equal(d.binds().length, 0);
  await rig.unplug('ttyACM0');
  const back = await rig.replug();
  assert.ok(back.restored);
  assert.deepEqual(back.errors, []);
  assert.equal(d.binds().length, 1);
  assert.match(d.binds()[0], /i='3-1\.1:1\.0'/);
  assert.equal(d.authorizes().length, 0);
  assert.ok(!rig.isUnplugged());
});

test('a marker that does not name an interface is refused, nothing is written', async () => {
  const d = device();
  const markerPath = tmpMarker();
  for (const m of [{ iface: '../../usb3', tty: 'ttyACM0' }, { iface: '3-1.1', tty: 'ttyACM0' }, { dir: '/sys/devices/x/usb3', tty: 'ttyACM0' }]) {
    fs.writeFileSync(markerPath, JSON.stringify(m));
    const back = await U.replugFromMarker({ ssh: d.ssh, markerPath });
    assert.equal(back.restored, false);
    assert.match(back.errors[0], /not a USB interface or device/);
  }
  assert.equal(d.binds().length + d.authorizes().length, 0);
});

test('a marker of an older run (authorized=0) is still put back, with authorized=1', async () => {
  const d = device();
  const markerPath = tmpMarker();
  fs.writeFileSync(markerPath, JSON.stringify({ dir: DEVICE, tty: 'ttyACM0' }));
  const back = await U.replugFromMarker({ ssh: d.ssh, markerPath });
  assert.ok(back.restored);
  assert.equal(d.authorizes().length, 1);
  assert.match(back.notes[0], /authorized again/);
});

test('a bind that fails keeps the marker and says how to do it by hand', async () => {
  const markerPath = tmpMarker();
  fs.writeFileSync(markerPath, JSON.stringify({ iface: IFNAME, tty: 'ttyACM0' }));
  const d = device({ failWrite: true });
  const back = await U.replugFromMarker({ ssh: d.ssh, markerPath });
  assert.equal(back.restored, false);
  assert.match(back.errors[0], /by hand: for d in \/sys\/bus\/usb\/devices/);
  assert.match(back.errors[0], /cdc_acm\/bind/);
  assert.ok(fs.existsSync(markerPath));
});

test("the round's restore binds the interface back from the marker when the journey threw", async () => {
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
  // No serial: a serial would also ask for the health check, which waits in real time.
  fs.writeFileSync(U.markerFile(out), JSON.stringify({ iface: IFNAME, tty: 'ttyACM0' }));
  const result = await deps.restore(snap).catch((e) => ({ errors: [e.message], notes: [] }));
  assert.ok(result.notes.some((n) => /bound to cdc_acm again/.test(n)), JSON.stringify(result));
  assert.equal(d.binds().length, 1);
  assert.ok(!fs.existsSync(U.markerFile(out)));
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

test('verifyHealth: waits out the instance settle, then spots "unknown USB board" / status=64', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-h-'));
  const healthPath = path.join(dir, 'usb.health');
  const req = () => fs.writeFileSync(healthPath, JSON.stringify({ serial: '1', since: 100 }));
  const ports = `ttyACM1|${IFACE}|1|BCO SLV #1`;
  const PS_OK = '  7 futurebit-miner ./futurebit-miner -comport /dev/ttyACM1 -ao_mode 1';
  // `script(c)` decides what the device says as the fake clock advances.
  const mk = (c, { ports: p = ports, journalAfterMs = 0, journal = '', ps = () => '', miner = 'active', unit = 'active' }) => async (cmd) => {
    if (/^for t in/.test(cmd)) return p;
    if (/apollo-miner -p ActiveState/.test(cmd)) return miner;
    if (/apollo-usb-miner@/.test(cmd) && /ActiveState/.test(cmd)) return unit;
    if (/^ps -eo/.test(cmd)) return ps(c.now());
    if (/^journalctl/.test(cmd)) return c.now() >= journalAfterMs ? journal : '';
    return '';
  };
  assert.deepEqual(await U.verifyHealth({ ssh: async () => '', healthPath, ...clock() }), { checked: false, errors: [] });

  // never on the bus
  req();
  let c = clock();
  let r = await U.verifyHealth({ ssh: mk(c, { ports: '' }), healthPath, ...c, timeoutMs: 8000 });
  assert.match(r.errors[0], /PHYSICAL REPLUG NEEDED/);
  assert.ok(!fs.existsSync(healthPath));

  // SLV, the instance is 'active' (Type=simple, still in its 8 s settle): the old
  // check saw "active" and stopped. Now it waits, and the script's line arrives late.
  req();
  c = clock();
  r = await U.verifyHealth({
    ssh: mk(c, { journalAfterMs: 14000, journal: 'usb_miner_run.sh[9]: unknown USB board on /dev/ttyACM1', unit: 'active' }),
    healthPath, ...c,
  });
  assert.match(r.errors[0], /PHYSICAL REPLUG NEEDED/);
  assert.match(r.errors[0], /unknown USB board/);
  assert.ok(c.now() >= 14000, 'it must have waited for the settle, not judged at the first SLV');

  // exit 64 alone is enough
  req();
  c = clock();
  r = await U.verifyHealth({ ssh: mk(c, { journal: 'apollo-usb-miner@ttyACM1.service: Main process exited, code=exited, status=64/n/a' }), healthPath, ...c });
  assert.match(r.errors[0], /PHYSICAL REPLUG NEEDED/);

  // a miner is running on the board: healthy
  req();
  c = clock();
  r = await U.verifyHealth({ ssh: mk(c, { ps: (t) => (t >= 12000 ? PS_OK : '') }), healthPath, ...c });
  assert.deepEqual(r.errors, []);
  assert.ok(r.judged);

  // apollo-miner stopped: nothing starts on purpose, nothing is judged
  req();
  c = clock();
  r = await U.verifyHealth({ ssh: mk(c, { miner: 'inactive', unit: 'inactive', journal: 'unknown USB board' }), healthPath, ...c });
  assert.deepEqual(r.errors, []);
  assert.equal(r.judged, false);

  // active, no miner, no sign of why, for the whole window: reported (not as a replug)
  req();
  c = clock();
  r = await U.verifyHealth({ ssh: mk(c, {}), healthPath, ...c, probeMs: 9000 });
  assert.match(r.errors[0], /no miner runs on it/);
  assert.doesNotMatch(r.errors[0], /PHYSICAL/);
});

test('unplug refuses a board that is not SLV, or not the chosen serial, and says why', async () => {
  for (const [name, d, serial, re] of [
    ['unknown product', device({ product: '' }), undefined, /not SLV/],
    ['another board', device(), '999', /not the chosen board/],
  ]) {
    const markerPath = tmpMarker();
    await assert.rejects(() => U.createUsbRig({ ssh: d.ssh, markerPath }).unplug('ttyACM0', serial), re, name);
    assert.equal(d.wrote().length, 0, name);
    assert.ok(!fs.existsSync(markerPath), name);
  }
  // The same serial in other case is the board.
  const d = device();
  await U.createUsbRig({ ssh: d.ssh, markerPath: tmpMarker() }).unplug('ttyACM0', '310059000850393855313720');
  assert.equal(d.wrote().length, 1);
  assert.match(d.wrote()[0], /\[ "\$sn" = '310059000850393855313720' \]/);
});

test("the shell's own refusal reaches the report", async () => {
  const markerPath = tmpMarker();
  const ssh = async (cmd) => {
    if (/^systemctl show apollo-miner/.test(cmd)) return 'active';
    if (/^readlink/.test(cmd)) return IFACE;
    if (/\/product' 2>/.test(cmd)) return 'BCO SLV #1';
    if (/^cat /.test(cmd)) return /serial/.test(cmd) ? '1' : '0483\n5740';
    if (/^test -e/.test(cmd)) return 'yes';
    throw Object.assign(new Error('Command failed: ssh'), { stderr: "refused: product reads 'BCO IAP #1', not SLV (mid board-reset?)" });
  };
  await assert.rejects(() => U.createUsbRig({ ssh, markerPath }).unplug('ttyACM0'), /refused: product reads 'BCO IAP #1'/);
  // The marker stays: the write may have happened before the failure was reported.
  assert.ok(fs.existsSync(markerPath));
});

test('orphans: a board found authorized=0 is enabled again; leftover markers are honoured; failure names the command', async () => {
  const scan = [
    `${DEVICE}|0483|5740|0|SER1`,
    `${HUB}|1a40|0101|0|`,           // the hub, also 0: never touched
    '/sys/devices/x/usb3/3-2|8087|0a2b|0|',
    '/sys/devices/x/usb3/3-3|0483|5740|1|SER2', // authorized: fine
  ].join('\n');
  const parsed = U.parseUsbScan(scan);
  assert.deepEqual(U.orphansIn(parsed).map((o) => o.serial), ['SER1']);

  const log = [];
  const ssh = async (cmd) => {
    log.push(cmd);
    if (cmd === U.USB_SCAN_CMD) return scan;
    if (/^for t in/.test(cmd)) return `ttyACM0|${IFACE}|SER1|BCO SLV #SER1`;
    if (/^test -d/.test(cmd)) return /GONE/.test(cmd) ? 'no' : 'yes';
    if (/sudo -n tee/.test(cmd)) return '1';
    return '';
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-orph-'));
  const healthPath = path.join(dir, 'usb.health');
  const stale = path.join(dir, 'old-run');
  fs.mkdirSync(stale);
  const staleMarker = path.join(stale, U.MARKER);
  fs.writeFileSync(staleMarker, JSON.stringify({ dir: '/sys/devices/GONE/usb3/3-9', serial: 'S9' }));
  const live = path.join(dir, 'old-run2');
  fs.mkdirSync(live);
  fs.writeFileSync(path.join(live, U.MARKER), JSON.stringify({ dir: DEVICE, serial: 'SER1' }));
  const mine = path.join(dir, 'this-run');
  fs.mkdirSync(mine);
  const markers = U.leftoverMarkers(mine);
  assert.equal(markers.length, 2);
  assert.ok(!markers.some((m) => m.startsWith(mine)));

  const r = await U.rescueOrphans({ ssh, markers, healthPath, waitUntil: async (p) => ({ ok: await p() }) });
  assert.deepEqual(r.errors, []);
  assert.ok(r.notes.some((n) => /GONE.*gone: dropped/.test(n)));
  assert.ok(!fs.existsSync(staleMarker));
  const writes = log.filter((c) => /sudo -n tee/.test(c));
  assert.ok(writes.every((c) => !new RegExp(HUB.replace(/[/.]/g, '\\$&') + "'").test(c)), 'the hub was written to');
  assert.ok(writes.length >= 1);
  assert.ok(fs.existsSync(healthPath), 'a health check was requested');

  const bad = await U.rescueOrphans({
    ssh: async (cmd) => { if (cmd === U.USB_SCAN_CMD) return scan; throw new Error('sudo: a password is required'); },
  });
  assert.match(bad.errors[0], /run: for d in \/sys\/bus\/usb\/devices/);
});

test('instance counts: a stray unit or process on the old port name is a mismatch', () => {
  const unit = (t) => `apollo-usb-miner@${t}.service loaded active running Apollo USB miner`;
  const names = U.activeUnitNames(`${unit('ttyACM1')}\n  ${unit('ttyACM0')}\nunrelated.service loaded active`);
  assert.deepEqual(names, ['apollo-usb-miner@ttyACM1.service', 'apollo-usb-miner@ttyACM0.service']);
  const proc = (t) => ({ pid: 1, comport: `/dev/${t}` });
  assert.equal(U.instanceMismatch({ units: ['apollo-usb-miner@ttyACM1.service'], procs: [proc('ttyACM1')], expected: 1 }), null);
  assert.equal(U.instanceMismatch({ units: [], procs: [], expected: 0 }), null);
  // moved from ttyACM0 to ttyACM1, old process still there
  assert.match(U.instanceMismatch({ units: ['apollo-usb-miner@ttyACM1.service'], procs: [proc('ttyACM1'), proc('ttyACM0')], expected: 1 }), /2 process/);
  // right counts, wrong ports
  assert.match(U.instanceMismatch({ units: ['apollo-usb-miner@ttyACM1.service'], procs: [proc('ttyACM0')], expected: 1 }), /expected 1/);
  // an unplugged board with a leftover unit
  assert.match(U.instanceMismatch({ units: ['apollo-usb-miner@ttyACM0.service'], procs: [], expected: 0 }), /expected 0/);
});

test('the Hashboards badge, not the Pools one; transient errors; journal wording', () => {
  const text = 'Miner\nHashboards\nActive 1/2\nrows\nPools\nActive 2/2';
  assert.deepEqual(U.hashboardsBadge(text), { active: 1, total: 2 });
  assert.deepEqual(U.hashboardsBadge('Active 0/1'), { active: 0, total: 1 });
  // A badge of another card ahead of the Hashboards one must not be taken.
  assert.deepEqual(U.hashboardsBadge('Pools\nActive 2/2\nHashboards\nActive 1/2'), { active: 1, total: 2 });
  assert.equal(U.hashboardsBadge('nothing'), null);
  assert.ok(U.isTransient(new Error('fetch failed')));
  assert.ok(U.isTransient(Object.assign(new Error('x'), { transport: true })));
  assert.ok(!U.isTransient(new Error('GraphQL: nope')));
  assert.ok(U.wedgedInJournal('usb_miner_run.sh[3]: unknown USB board on /dev/ttyACM1'));
  assert.ok(U.wedgedInJournal('code=exited, status=64/n/a'));
  assert.equal(U.pickJournal('unknown USB board on /dev/ttyACM1\nnoise').length, 1);
});

test('--with usb-expiry without usb-miner is an error, and is listed', () => {
  const all = registry.list();
  const pick = (only, extra) => registry.select(all, only, extra);
  assert.throws(() => registry.checkOptions(pick('solo'), ['usb-expiry']), /only applies to the usb-miner journey/);
  assert.throws(() => registry.checkOptions(pick(null, 'usb-expiry'), registry.optionsOf('usb-expiry')), /usb-miner/);
  assert.doesNotThrow(() => registry.checkOptions(pick('usb-miner'), ['usb-expiry']));
  assert.doesNotThrow(() => registry.checkOptions(pick(null, 'usb-miner,usb-expiry'), registry.optionsOf('usb-miner,usb-expiry')));
  assert.doesNotThrow(() => registry.checkOptions(pick('solo'), []));
  assert.ok(registry.OPTION_HELP['usb-expiry']);
});

test("the round's snapshot enables an orphaned board before photographing, and refuses to start if it cannot", async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-snap-'));
  const order = [];
  const mk = (failWrite) => ({
    ssh: async (cmd) => {
      if (cmd === U.USB_SCAN_CMD) return `${DEVICE}|0483|5740|0|SER1`;
      if (/sudo -n tee/.test(cmd) && /authorized/.test(cmd)) {
        order.push('write');
        if (failWrite) throw new Error('sudo: a password is required');
        return '1';
      }
      if (/^date \+%s/.test(cmd)) return '1000';
      return '';
    },
    gql: async () => ({ Pool: { list: { result: { pools: [] } } }, Settings: { list: { result: { settings: [] } } } }),
    gqlWrite: async () => ({}),
    waitUntil: async (p) => ({ ok: await p() }),
    base: { takeSnapshot: async () => { order.push('photo'); return {}; }, restoreSnapshot: async () => [] },
  });
  const deps = buildDeps({ profile: {}, io: mk(false), out, ctxFile: 'x', uiBase: 'x', original: 'pw', wifi: {} });
  await deps.snapshot();
  assert.deepEqual(order.slice(0, 2), ['write', 'photo']);
  const failing = buildDeps({ profile: {}, io: mk(true), out, ctxFile: 'x', uiBase: 'x', original: 'pw', wifi: {} });
  await assert.rejects(() => failing.snapshot(), /deauthorized and could not be re-enabled.*for d in \/sys\/bus\/usb/s);
});

test('no unbind while apollo-miner is not active (an idle board wedges), in JS and in the shell', async () => {
  for (const state of ['inactive', 'activating', 'failed', '']) {
    const d = device({ minerState: state });
    const markerPath = tmpMarker();
    await assert.rejects(() => U.createUsbRig({ ssh: d.ssh, markerPath }).unplug('ttyACM0', '310059000850393855313720'), /apollo-miner is .*not active/, state);
    assert.equal(d.wrote().length, 0, state);
    assert.ok(!fs.existsSync(markerPath), state);
  }
  assert.match(U.unbindCommand('3-1.1:1.0'), /systemctl show apollo-miner -p ActiveState --value.*= active/);
  // Binding is never refused for it: it is how a cut-off board comes back.
  assert.doesNotMatch(U.bindCommand('3-1.1:1.0'), /apollo-miner/);
});

test('reemit: a udev add for the board tty, after checking the tty is the board; never writes authorized', async () => {
  const d = device({ minerState: 'inactive' });
  const rig = U.createUsbRig({ ssh: d.ssh, markerPath: tmpMarker() });
  assert.equal(await rig.reemit('ttyACM0', '310059000850393855313720'), 'ttyACM0');
  const trig = d.log.filter((c) => /udevadm trigger/.test(c));
  assert.equal(trig.length, 1);
  assert.match(trig[0], /^sudo -n udevadm trigger --action=add --settle \/sys\/class\/tty\/ttyACM0$/);
  assert.equal(d.wrote().length, 0);
  // another tty / another board / bad names: no event
  for (const [tty, serial, re] of [['ttyACM1', '310059000850393855313720', /is not the board/], ['ttyACM0', '999', /is not the board/], ['ttyACM0; reboot', 'x', /not a ttyACM/], ['ttyACM0', '', /needs the board serial/]]) {
    const e = device();
    await assert.rejects(() => U.createUsbRig({ ssh: e.ssh, markerPath: tmpMarker() }).reemit(tty, serial), re);
    assert.equal(e.log.filter((c) => /udevadm trigger/.test(c)).length, 0);
  }
});

test('a failure-time restore error stays in LEFT TO DO BY HAND even if the final restore is clean', async () => {
  const report = require('../journeys/report');
  const deps = {
    snapshot: async () => ({}),
    runJourney: async (j) => ({ id: j.id, name: j.name, ok: false, durationMs: 1, error: 'boom' }),
    restore: (() => { let n = 0; return async () => (n++ === 0 ? { errors: ['usb: PHYSICAL REPLUG NEEDED — board 1'] } : { errors: [] }); })(),
    password: async () => ({ errors: [], loginOk: true }),
    minerOff: async () => ({ errors: [], off: true, scriptRan: true }),
    finalCheck: async () => ({ errors: [], drift: [] }),
  };
  const r = await runRound({ journeys: [{ id: '13-usb-miner', name: 'usb-miner' }], deps });
  assert.ok(r.errors.some((e) => /PHYSICAL REPLUG/.test(e)));
  const todo = report.leftToDo(r, { host: 'h' });
  assert.ok(todo.some((t) => /PHYSICAL REPLUG NEEDED/.test(t)), JSON.stringify(todo));
  assert.match(report.toMarkdown(r, { host: 'h' }), /LEFT TO DO BY HAND: .*PHYSICAL REPLUG NEEDED/);
  // and a clean round still says nothing
  const clean = await runRound({ journeys: [], deps: { ...deps, restore: async () => ({ errors: [] }) } });
  assert.deepEqual(report.leftToDo(clean, { host: 'h' }), []);
});

test('orphans: an interface left without a driver is bound to cdc_acm again, and only the board', async () => {
  const scan = [
    '3-1.1:1.0|0483|5740|SER1|02|0',   // the board, unbound: rescued
    '3-1.1:1.1|0483|5740|SER1|0a|0',   // its data interface: not touched (class 0a)
    '3-1:1.0|1a40|0101|HUB|09|1',      // the hub
    '3-2:1.0|0483|5740|SER2|02|1',     // another board, bound: fine
    '3-3:1.0|10c4|ea60|X|ff|0',        // a stranger without a driver
  ].join('\n');
  const parsed = U.parseIfaceScan(scan);
  assert.deepEqual(U.unboundIn(parsed).map((x) => x.iface), ['3-1.1:1.0']);
  const log = [];
  const ssh = async (cmd) => {
    log.push(cmd);
    if (cmd === U.IFACE_SCAN_CMD) return scan;
    if (/cdc_acm\/bind/.test(cmd)) return 'bound';
    return '';
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-unb-'));
  const healthPath = path.join(dir, 'usb.health');
  const r = await U.rescueOrphans({ ssh, healthPath });
  assert.deepEqual(r.errors, []);
  assert.match(r.notes[0], /3-1\.1:1\.0.*had no driver.*bound to cdc_acm/);
  const binds = log.filter((c) => /cdc_acm\/bind/.test(c));
  assert.equal(binds.length, 1);
  assert.match(binds[0], /i='3-1\.1:1\.0'/);
  assert.equal(JSON.parse(fs.readFileSync(healthPath, 'utf8')).serial, 'SER1');
  const bad = await U.rescueOrphans({ ssh: async (cmd) => { if (cmd === U.IFACE_SCAN_CMD) return scan; if (/cdc_acm\/bind/.test(cmd)) throw new Error('sudo: a password is required'); return ''; } });
  assert.match(bad.errors[0], /could not be bound.*run: for d in/);
  // Both names of leftover markers are looked for in earlier runs.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'usb-mk-'));
  for (const [d, n] of [['a', U.MARKER], ['b', U.LEGACY_MARKER], ['mine', U.MARKER]]) {
    fs.mkdirSync(path.join(base, d));
    fs.writeFileSync(path.join(base, d, n), '{}');
  }
  assert.deepEqual(U.leftoverMarkers(path.join(base, 'mine')).map((f) => path.basename(path.dirname(f))).sort(), ['a', 'b']);
});

test('the journey never emits a deauthorize anywhere: no builder in usb.js produces authorized=0', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'journeys', 'usb.js'), 'utf8');
  const spec = fs.readFileSync(path.join(__dirname, '..', 'journeys', 'specs', '13-usb-miner.spec.js'), 'utf8');
  assert.doesNotMatch(src, /echo 0 \|/);
  assert.doesNotMatch(spec, /authorizeCommand|echo 0/);
});
