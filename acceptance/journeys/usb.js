// Helpers for the usb-miner journey: simulating an unplug without touching the
// cable, and putting it back.
//
// An unplug is simulated by unbinding the cdc_acm driver from the board's USB
// INTERFACE (`echo 3-1.1:1.0 > /sys/bus/usb/drivers/cdc_acm/unbind`): the tty and
// the miner on it vanish in seconds, and `bind` brings them back, with the miner
// mining again ~20-30 s later. This replaces writing `authorized`, which wedged the
// board ("Unknown board") until a physical replug, on this hardware, more than once:
// the journey never writes `authorized` any more.
//
// Getting the interface wrong is not a failed test, it is damage, so every step is
// guarded: the name comes from `readlink -f /sys/class/tty/ttyACMn/device` and must
// look like `<bus>-<port>:<cfg>.<if>`; the PARENT device must be 0483:5740 (a level
// higher is the hub, 1a40, with the Bluetooth and Home Assistant sticks); its product
// must read SLV (not the bootloader), its serial must be the chosen board's,
// apollo-miner must be active (an idle board wedges when toggled) and the interface
// must currently be bound to cdc_acm. The shell command that writes checks the same
// again, at the moment of the write.
//
// Everything here is pure or takes its collaborators (`ssh`, `fs`), so the rules
// are tested with fixture paths (test/journeys-usb.test.js).

const fs = require('fs');
const path = require('path');

const BOARD = { vendor: '0483', product: '5740' };
// The state file the spec writes BEFORE it unbinds and the parent reads when
// it puts the board back (the spec runs in its own process: a file is the only
// shared state). It lives in the run's output directory.
const MARKER = 'usb.unplugged';
// The name of earlier versions (authorized=0): still looked for among old runs.
const LEGACY_MARKER = 'usb.deauthorized';
// Written when a board was re-authorized, read by the round's restore.
const HEALTH = 'usb.health';

const SYS = '/sys/devices/';
// A USB device directory: bus-port[.port…], no ':config.interface' suffix. The root
// hubs are `usbN`, which this does not match either.
const DEVICE_RE = /^\d+-\d+(?:\.\d+)*$/;
const INTERFACE_RE = /^(\d+-\d+(?:\.\d+)*):\d+\.\d+$/;
const SAFE_PATH_RE = /^[A-Za-z0-9_./:@-]+$/;

const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

// "/dev/ttyACM0" or "ttyACM0" -> "ttyACM0"; anything else -> null.
const ttyOf = (port) => /\b(ttyACM\d+)$/.exec(String(port || '').trim())?.[1] ?? null;

// The USB device directory behind the INTERFACE directory that readlink gave.
// Only the exact shape `<device>/<device>:<cfg>.<if>` is accepted, with the
// interface's own device name equal to its parent's: a path that is already a
// device, a hub, a root hub or anything else comes back null, never "one level up".
const usbDeviceDirOf = (realpath) => {
  const p = String(realpath || '').trim();
  if (!p.startsWith(SYS) || !SAFE_PATH_RE.test(p) || p.includes('..')) return null;
  const parts = p.split('/');
  const iface = INTERFACE_RE.exec(parts[parts.length - 1]);
  if (!iface) return null;
  const parent = parts[parts.length - 2];
  if (parent !== iface[1] || !DEVICE_RE.test(parent)) return null;
  return parts.slice(0, -1).join('/');
};

// Is this directory, as a string, one we would write `authorized` into?
const isDeviceDir = (dir) => {
  const p = String(dir || '');
  return p.startsWith(SYS) && SAFE_PATH_RE.test(p) && !p.includes('..') && DEVICE_RE.test(p.split('/').pop());
};

const parseIds = (text) => {
  const [vendor = '', product = ''] = String(text || '').split('\n').map((l) => l.trim().toLowerCase());
  return { vendor, product };
};
const isApolloBoard = ({ vendor, product } = {}) =>
  String(vendor || '').trim().toLowerCase() === BOARD.vendor && String(product || '').trim().toLowerCase() === BOARD.product;

// What to run by hand when a board was left unplugged by a run (driver unbound, or
// from an older version deauthorized) and nothing else will put it back: every
// 0483:5740 device on the bus enabled, every unbound communications interface bound
// to cdc_acm. Names no directory, because the port number changes.
const MANUAL_RESTORE =
  'for d in /sys/bus/usb/devices/*; do [ "$(cat $d/idVendor 2>/dev/null)" = 0483 ] && [ "$(cat $d/idProduct 2>/dev/null)" = 5740 ] || continue; ' +
  'echo 1 | sudo tee $d/authorized >/dev/null; ' +
  'for i in $d:*; do [ "$(cat $i/bInterfaceClass 2>/dev/null)" = 02 ] && [ ! -e $i/driver ] && echo ${i##*/} | sudo tee /sys/bus/usb/drivers/cdc_acm/bind; done; done';

// The journey never deauthorizes. Enabling a device (value 1) is what puts back a
// board an OLDER run left at authorized=0; it checks nothing, being never destructive.
const authorizeCommand = (dir, value) => {
  if (!isDeviceDir(dir)) throw new Error(`refusing to write: ${dir} is not a USB device directory`);
  if (value !== 1) throw new Error('the journey never writes authorized=0 (it wedges the board): only 1 is allowed');
  return `d=${shq(dir)}; echo 1 | sudo -n tee "$d/authorized" >/dev/null && cat "$d/authorized"`;
};

// An interface name: <bus>-<port[.port…]>:<config>.<interface>.
const IFACE_NAME_RE = /^[0-9]+-[0-9.]+:[0-9]+\.[0-9]+$/;
const isIfaceName = (n) => IFACE_NAME_RE.test(String(n || ''));
const CDC = '/sys/bus/usb/drivers/cdc_acm';

// Unbind cdc_acm from the board's interface. In the shell and at the moment of the
// write: apollo-miner active, the parent device 0483:5740, product SLV, the chosen
// serial, the interface bound to cdc_acm now. A mismatch prints why on stderr and
// writes nothing. Prints `unbound` on success.
const unbindCommand = (iface, { serial = null } = {}) => {
  if (!isIfaceName(iface)) throw new Error(`refusing: "${iface}" is not a USB interface name`);
  return `i=${shq(iface)}; d=$(dirname "$(readlink -f "/sys/bus/usb/devices/$i")"); ` +
    '[ "$(systemctl show apollo-miner -p ActiveState --value 2>/dev/null)" = active ] || { echo "refused: apollo-miner is not active (an idle board wedges when toggled)" >&2; exit 1; }; ' +
    'v=$(cat "$d/idVendor" 2>/dev/null); p=$(cat "$d/idProduct" 2>/dev/null); pr=$(cat "$d/product" 2>/dev/null); sn=$(cat "$d/serial" 2>/dev/null); ' +
    `[ "$v:$p" = ${BOARD.vendor}:${BOARD.product} ] || { echo "refused: the parent of $i is $v:$p, not ${BOARD.vendor}:${BOARD.product}" >&2; exit 1; }; ` +
    'case "$pr" in *SLV*) ;; *) { echo "refused: product reads \'$pr\', not SLV (mid board-reset?)" >&2; exit 1; };; esac; ' +
    (serial ? `[ "$sn" = ${shq(serial)} ] || { echo "refused: serial is '$sn', not the chosen board" >&2; exit 1; }; ` : '') +
    `[ -e ${CDC}/$i ] || { echo "refused: $i is not bound to cdc_acm" >&2; exit 1; }; ` +
    `echo "$i" | sudo -n tee ${CDC}/unbind >/dev/null; ` +
    `[ ! -e ${CDC}/$i ] && echo unbound`;
};

// Bind it back. Idempotent (already bound: nothing to do) and harmless, so it checks
// only that the interface exists and that its parent is the board. Prints `bound`.
const bindCommand = (iface) => {
  if (!isIfaceName(iface)) throw new Error(`refusing: "${iface}" is not a USB interface name`);
  return `i=${shq(iface)}; [ -e "/sys/bus/usb/devices/$i" ] || { echo "refused: no such interface $i" >&2; exit 1; }; ` +
    'd=$(dirname "$(readlink -f "/sys/bus/usb/devices/$i")"); ' +
    `[ "$(cat "$d/idVendor" 2>/dev/null):$(cat "$d/idProduct" 2>/dev/null)" = ${BOARD.vendor}:${BOARD.product} ] || { echo "refused: the parent of $i is not ${BOARD.vendor}:${BOARD.product}" >&2; exit 1; }; ` +
    `[ -e ${CDC}/$i ] && { echo bound; exit 0; }; ` +
    `echo "$i" | sudo -n tee ${CDC}/bind >/dev/null; ` +
    `for n in 1 2 3 4 5; do [ -e ${CDC}/$i ] && { echo bound; exit 0; }; sleep 1; done; exit 1`;
};

// A board reset (every miner_stop.sh does `apollo-helper -s <port> -r`) makes it
// re-enumerate at once as "BCO IAP #<serial>" (bootloader) and ~30 s later as
// "BCO SLV #<serial>" (the miner firmware). Cutting the board off inside the IAP
// window leaves it wedged ("Unknown board") until it is physically replugged. So:
// never while the product reads IAP, and wait for SLV before any simulated unplug.
const productState = (product) => {
  const p = String(product || '');
  if (/\bIAP\b/.test(p)) return 'IAP';
  if (/\bSLV\b/.test(p)) return 'SLV';
  return 'unknown';
};

// Port names are not stable (a probe holding ttyACM0 open made the board come
// back as ttyACM1): the board is found by its USB serial, in sysfs, every time.
const PORT_LIST_CMD =
  'for t in /sys/class/tty/ttyACM*; do [ -e "$t" ] || continue; d=$(readlink -f "$t/device"); p=$(dirname "$d"); ' +
  'echo "$(basename "$t")|$d|$(cat "$p/serial" 2>/dev/null)|$(cat "$p/product" 2>/dev/null)"; done; true';

const parsePortList = (text) =>
  String(text || '').split('\n').map((l) => l.split('|')).filter((f) => f.length >= 4 && /^ttyACM\d+$/.test(f[0])).map((f) => ({
    tty: f[0],
    dir: usbDeviceDirOf(f[1]),
    serial: f[2].trim(),
    product: f.slice(3).join('|').trim(),
    state: productState(f.slice(3).join('|')),
  }));

const portFor = (ports, serial) => {
  const s = String(serial || '').trim().toLowerCase();
  if (!s) return null;
  return ports.find((p) => p.serial.toLowerCase() === s || p.product.toLowerCase().endsWith(`#${s}`)) || null;
};

// Wait until the board has finished its reset cycle: it reads SLV, with the same
// port and product for `stableMs`, and either a non-SLV state (gone or IAP) was
// seen since the wait began or `minMs` have passed since `since`. `read()` gives
// the board's current port entry or null. Clock and sleep are injectable.
const waitSlvStable = async ({
  read, minMs = 0, stableMs = 5000, timeoutMs = 90000, everyMs = 1000, since = null,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) => {
  const t0 = now();
  const from = since ?? t0;
  let stableSince = null;
  let key = null;
  let sawReset = false;
  let last = null;
  for (;;) {
    last = await read();
    const t = now();
    if (!last || last.state !== 'SLV') {
      sawReset = true;
      stableSince = null;
      key = null;
    } else if (key !== `${last.tty}|${last.product}`) {
      key = `${last.tty}|${last.product}`;
      stableSince = t;
    }
    if (stableSince !== null && t - stableSince >= stableMs && (sawReset || t - from >= minMs)) {
      return { ok: true, tty: last.tty, product: last.product, sawReset, waitedMs: t - t0 };
    }
    if (t - t0 >= timeoutMs) {
      const what = !last ? 'the board is not on the bus' : `the board reads ${last.state} (${last.product || 'no product'}) on ${last.tty}`;
      return { ok: false, reason: `${what} ${Math.round((t - t0) / 1000)} s after the wait began`, waitedMs: t - t0 };
    }
    await sleep(everyMs);
  }
};

// The journal lines that explain a board that does not mine.
const pickJournal = (text, max = 12) =>
  String(text || '').split('\n').map((l) => l.trim())
    .filter((l) => /unknown\s+(USB\s+)?board|status=64|code=exited|Failed|Requisite|dependency|Started|Stopp(ed|ing)/i.test(l))
    .slice(-max);
const journalCommand = (epoch) =>
  `journalctl -u 'apollo-usb-miner@*' -u apollo-miner --since @${Number(epoch)} -o short-iso --no-pager 2>/dev/null || true`;
// usb_miner_run.sh logs "unknown USB board on <port>" and exits 64 (apollo-helper's own
// output goes to a variable, so the journal never has "Unknown board").
const wedgedInJournal = (text) => /status=64|unknown\s+USB\s+board|Unknown board/i.test(String(text || ''));

// ------------------------------------------------------------------ orphans

// A killed run (SIGKILL, a second Ctrl-C, the Mac asleep) leaves a board with
// authorized=0 and nothing that remembers it: the next run would "skip: no USB
// miner attached". Every USB device on the bus, with its authorized flag.
const USB_SCAN_CMD =
  'for d in /sys/bus/usb/devices/*; do [ -f "$d/idVendor" ] || continue; ' +
  'echo "$(readlink -f "$d")|$(cat "$d/idVendor" 2>/dev/null)|$(cat "$d/idProduct" 2>/dev/null)|$(cat "$d/authorized" 2>/dev/null)|$(cat "$d/serial" 2>/dev/null)"; done; true';
const parseUsbScan = (text) =>
  String(text || '').split('\n').map((l) => l.split('|')).filter((f) => f.length >= 5).map((f) => ({
    dir: f[0].trim(), vendor: f[1].trim().toLowerCase(), product: f[2].trim().toLowerCase(), authorized: f[3].trim(), serial: f[4].trim(),
  }));
// Unbound interfaces: a communications interface (class 02) of a 0483:5740 device
// with no driver is a board a killed run left unplugged.
const IFACE_SCAN_CMD =
  'for i in /sys/bus/usb/devices/*:*; do [ -e "$i" ] || continue; d=$(dirname "$(readlink -f "$i")"); ' +
  'echo "$(basename "$i")|$(cat "$d/idVendor" 2>/dev/null)|$(cat "$d/idProduct" 2>/dev/null)|$(cat "$d/serial" 2>/dev/null)|$(cat "$i/bInterfaceClass" 2>/dev/null)|$([ -e "$i/driver" ] && echo 1 || echo 0)"; done; true';
const parseIfaceScan = (text) =>
  String(text || '').split('\n').map((l) => l.split('|')).filter((f) => f.length >= 6).map((f) => ({
    iface: f[0].trim(), vendor: f[1].trim().toLowerCase(), product: f[2].trim().toLowerCase(), serial: f[3].trim(), cls: f[4].trim(), bound: f[5].trim() === '1',
  }));
const unboundIn = (ifaces) =>
  ifaces.filter((x) => isApolloBoard(x) && x.cls === '02' && !x.bound && isIfaceName(x.iface));
const orphansIn = (devices) =>
  devices.filter((d) => isApolloBoard(d) && d.authorized === '0' && isDeviceDir(d.dir));

// Boards found cut off by an earlier run: bound / authorized again (harmless), with a
// note. `markers` are leftover marker files of earlier runs. Returns notes and
// errors; an error carries the command to run by hand.
const rescueOrphans = async ({ ssh, markers = [], fsImpl = fs, waitUntil = null, healthPath = null }) => {
  const notes = [];
  const errors = [];
  for (const file of markers) {
    const m = readMarker(fsImpl, file);
    if (!m) continue;
    const exists = m.iface
      ? isIfaceName(m.iface) && (await ssh(`test -e ${shq(`/sys/bus/usb/devices/${m.iface}`)} && echo yes || echo no`).catch(() => 'no')).trim() === 'yes'
      : isDeviceDir(m.dir) && (await ssh(`test -d ${shq(m.dir)} && echo yes || echo no`).catch(() => 'no')).trim() === 'yes';
    if (!exists) {
      fsImpl.rmSync(file, { force: true });
      notes.push(`usb: leftover marker ${file} named ${m.iface || m.dir}, which is gone: dropped`);
      continue;
    }
    const r = await replugFromMarker({ ssh, markerPath: file, healthPath, fsImpl, waitUntil });
    notes.push(...r.notes.map((n) => `${n} (leftover of an earlier run, ${file})`));
    errors.push(...r.errors);
  }
  const ask = async (cmd) => ssh(cmd).catch(() => '');
  for (const d of orphansIn(parseUsbScan(await ask(USB_SCAN_CMD)))) {
    try {
      const out = await ssh(authorizeCommand(d.dir, 1));
      if (String(out).trim() !== '1') throw new Error(`authorized reads "${String(out).trim()}"`);
      notes.push(`usb: board ${d.serial || d.dir} was deauthorized (an older run): authorized it again`);
      if (healthPath && d.serial) fsImpl.writeFileSync(healthPath, JSON.stringify({ serial: d.serial, since: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
    } catch (err) {
      errors.push(`usb: board ${d.serial || d.dir} is deauthorized and could not be re-enabled: ${err.message} — run: ${MANUAL_RESTORE}`);
    }
  }
  for (const x of unboundIn(parseIfaceScan(await ask(IFACE_SCAN_CMD)))) {
    try {
      const out = await ssh(bindCommand(x.iface));
      if (String(out).trim() !== 'bound') throw new Error(`bind answered "${String(out).trim()}"`);
      notes.push(`usb: interface ${x.iface} of board ${x.serial || '?'} had no driver (a killed earlier run): bound to cdc_acm`);
      if (healthPath && x.serial) fsImpl.writeFileSync(healthPath, JSON.stringify({ serial: x.serial, since: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
    } catch (err) {
      errors.push(`usb: interface ${x.iface} is unbound and could not be bound: ${err.message} — run: ${MANUAL_RESTORE}`);
    }
  }
  return { notes, errors };
};

// Marker files that earlier runs left in their output directories.
const leftoverMarkers = (out, fsImpl = fs) => {
  const parent = path.dirname(out);
  try {
    return fsImpl.readdirSync(parent)
      .flatMap((d) => [MARKER, LEGACY_MARKER].map((n) => path.join(parent, d, n)))
      .filter((f) => path.resolve(path.dirname(f)) !== path.resolve(out) && fsImpl.existsSync(f));
  } catch {
    return [];
  }
};

// Both kinds of leftover, for a journey that is about to skip.
const findOrphans = async (ssh) => ({
  deauthorized: orphansIn(parseUsbScan(await ssh(USB_SCAN_CMD))),
  unbound: unboundIn(parseIfaceScan(await ssh(IFACE_SCAN_CMD))),
});

// ------------------------------------------------------------ what runs

// The instances and miner processes that run on USB ports right now, against the
// number the API says are active USB boards. A leftover instance or process on the
// OLD port name after a re-enumeration (ttyACM0 -> ttyACM1) is the real risk, and a
// count filtered on one unit name cannot see it. Returns null when it adds up.
const instanceMismatch = ({ units, procs, expected }) => {
  const unitPorts = units.map((u) => /^apollo-usb-miner@(ttyACM\d+)\.service$/.exec(u)?.[1]).filter(Boolean).sort();
  const procPorts = procs.map((p) => /(ttyACM\d+)$/.exec(p.comport || '')?.[1]).filter(Boolean).sort();
  const same = JSON.stringify(unitPorts) === JSON.stringify(procPorts);
  if (unitPorts.length === expected && procPorts.length === expected && same) return null;
  return `expected ${expected} USB miner instance(s) and process(es), found ${unitPorts.length} unit(s) [${unitPorts.join(', ') || '-'}] and ${procPorts.length} process(es) [${procPorts.join(', ') || '-'}]`;
};
const activeUnitNames = (text) => String(text || '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter((n) => /^apollo-usb-miner@/.test(n));
const USB_UNITS_CMD = "systemctl list-units --plain --no-legend --state=active,activating,reloading 'apollo-usb-miner@*' || true";

// ------------------------------------------------------------------- misc

// The "Active a/t" badge of the Hashboards card: on an Apollo II the Pools card
// has one too. The first badge after the word "Hashboards" (the first badge at all
// when the word is absent).
const hashboardsBadge = (text) => {
  const t = String(text || '');
  const at = t.indexOf('Hashboards');
  const found = activeBadges(at >= 0 ? t.slice(at) : t);
  return found[0] || null;
};

// A probe that polls must not read one dropped connection as "not yet".
const isTransient = (err) =>
  !!err && (err.transport === true || /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|UND_ERR/i.test(`${err.message} ${err.cause?.message || ''}`));

// ------------------------------------------------------------------ rig

const readMarker = (fsImpl, markerPath) => {
  try {
    const m = JSON.parse(fsImpl.readFileSync(markerPath, 'utf8'));
    return m && (typeof m.iface === 'string' || typeof m.dir === 'string') ? m : null;
  } catch {
    return null;
  }
};

// Put back what the marker says was cut off: an interface to bind (this version) or a
// device to authorize (an older run). Used by the journey's own `finally` and by the
// round's restore.
const replugFromMarker = async ({ ssh, markerPath, healthPath = null, fsImpl = fs, waitUntil = null, tty = null }) => {
  const m = readMarker(fsImpl, markerPath);
  if (!m) return { restored: false, notes: [], errors: [] };
  const notes = [];
  const errors = [];
  const target = m.iface || m.dir;
  if (m.iface ? !isIfaceName(m.iface) : !isDeviceDir(m.dir)) {
    errors.push(`usb: the marker names ${target}, which is not a USB interface or device: not touched`);
    return { restored: false, notes, errors };
  }
  try {
    if (m.iface) {
      const out = await ssh(bindCommand(m.iface), { timeoutMs: 30000 });
      if (String(out).trim() !== 'bound') throw new Error(`bind answered "${String(out).trim()}"`);
      notes.push(`usb: ${m.iface} bound to cdc_acm again`);
    } else {
      const out = await ssh(authorizeCommand(m.dir, 1));
      if (String(out).trim() !== '1') throw new Error(`authorized reads "${String(out).trim()}" after the write`);
      notes.push(`usb: ${m.dir} authorized again`);
    }
    fsImpl.rmSync(markerPath, { force: true });
    // The round's restore checks the board really came back (verifyHealth).
    if (healthPath && m.serial) {
      fsImpl.writeFileSync(healthPath, JSON.stringify({ serial: m.serial, since: Math.floor(Date.now() / 1000) }), { mode: 0o600 });
    }
  } catch (err) {
    errors.push(`usb: could not put ${target} back: ${err.message} — do it by hand: ${MANUAL_RESTORE}`);
    return { restored: false, notes, errors };
  }
  // The port may come back under another name: the board is looked up by serial.
  if (waitUntil && (m.serial || tty || m.tty)) {
    const back = await waitUntil(async () => {
      try {
        const ports = parsePortList(await ssh(PORT_LIST_CMD));
        return m.serial ? !!portFor(ports, m.serial) : ports.some((p) => p.tty === (tty || m.tty));
      } catch { return false; }
    }, { timeoutMs: 60000, everyMs: 3000 });
    if (!back.ok) errors.push('usb: the board did not come back on the bus within 60 s of the bind');
  }
  return { restored: true, notes, errors };
};

// After a re-authorize: is the board really back? SLV and stable within 90 s; then,
// when apollo-miner is active, the instance must leave usb_miner_run.sh's settle and
// probe (~8 s + up to 3 probes) and either run a miner on the board or fail:
// "unknown USB board" / status=64 in the journal means the board answers nothing
// and only a physical replug brings it back. With apollo-miner stopped nothing
// starts on purpose, and nothing is judged.
const verifyHealth = async ({ ssh, healthPath, fsImpl = fs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), timeoutMs = 90000, probeMs = 45000 }) => {
  let req;
  try { req = JSON.parse(fsImpl.readFileSync(healthPath, 'utf8')); } catch { return { checked: false, errors: [] }; }
  fsImpl.rmSync(healthPath, { force: true });
  const read = async () => portFor(parsePortList(await ssh(PORT_LIST_CMD)), req.serial);
  const r = await waitSlvStable({ read, timeoutMs, now, sleep });
  const errors = [];
  if (!r.ok) {
    errors.push(`usb: PHYSICAL REPLUG NEEDED — board ${req.serial} did not come back after the re-authorize: ${r.reason}`);
    return { checked: true, errors };
  }
  const minerActive = async () => (await ssh('systemctl show apollo-miner -p ActiveState --value || true')).trim() === 'active';
  if (!(await minerActive())) return { checked: true, errors, tty: r.tty, judged: false };
  const t0 = now();
  for (;;) {
    const port = (await read()) || { tty: r.tty };
    const running = procsOn(parseMinerProcs(await ssh('ps -eo pid=,comm=,args=')), port.tty).length > 0;
    if (running) return { checked: true, errors, tty: port.tty, judged: true };
    const journal = await ssh(journalCommand(req.since));
    if (wedgedInJournal(journal)) {
      const unit = (await ssh(`systemctl show 'apollo-usb-miner@${port.tty}' -p ActiveState --value || true`)).trim();
      errors.push(`usb: PHYSICAL REPLUG NEEDED — board ${req.serial} is back as SLV on ${port.tty} but the miner does not recognise it (instance ${unit}): ${pickJournal(journal, 3).join(' | ')}`);
      return { checked: true, errors, tty: port.tty, judged: true };
    }
    if (now() - t0 >= probeMs) {
      errors.push(`usb: board ${req.serial} is back as SLV on ${port.tty} and apollo-miner is active, but no miner runs on it ${Math.round(probeMs / 1000)} s later (journal: ${pickJournal(journal, 3).join(' | ') || 'nothing relevant'})`);
      return { checked: true, errors, tty: port.tty, judged: true };
    }
    await sleep(3000);
  }
};

const createUsbRig = ({ ssh, markerPath, healthPath = null, fsImpl = fs, waitUntil = null }) => {
  // Where the board really is, and proof that it is the board. Throws, writes nothing.
  const inspect = async (tty, expectSerial = null) => {
    if (!/^ttyACM\d+$/.test(tty)) throw new Error(`"${tty}" is not a ttyACM port`);
    const ifacePath = (await ssh(`readlink -f /sys/class/tty/${tty}/device`)).trim();
    const dir = usbDeviceDirOf(ifacePath);
    const iface = ifacePath.split('/').pop();
    if (!dir || !isIfaceName(iface)) throw new Error(`refusing: /sys/class/tty/${tty}/device resolves to ${ifacePath || '(nothing)'}, which is not a USB interface directory — nothing written`);
    const ids = parseIds(await ssh(`cat ${shq(`${dir}/idVendor`)} ${shq(`${dir}/idProduct`)}`));
    if (!isApolloBoard(ids)) {
      throw new Error(`refusing: the parent ${dir} is ${ids.vendor || '?'}:${ids.product || '?'}, not a ${BOARD.vendor}:${BOARD.product} board — nothing written`);
    }
    const product = (await ssh(`cat ${shq(`${dir}/product`)} 2>/dev/null || true`)).trim();
    if (productState(product) !== 'SLV') {
      throw new Error(`refusing: ${dir} reads "${product || '(nothing)'}", not SLV (bootloader or mid board-reset): cutting it off now wedges the board — nothing written`);
    }
    const serial = (await ssh(`cat ${shq(`${dir}/serial`)} 2>/dev/null || true`)).trim();
    if (expectSerial && serial.toLowerCase() !== String(expectSerial).toLowerCase()) {
      throw new Error(`refusing: ${dir} has serial "${serial}", not the chosen board ${expectSerial} — nothing written`);
    }
    const bound = (await ssh(`test -e ${shq(`${CDC}/${iface}`)} && echo yes || echo no`)).trim() === 'yes';
    if (!bound) throw new Error(`refusing: ${iface} is not bound to cdc_acm — nothing to unbind`);
    return { dir, iface, ids, product, serial };
  };

  // The unplug: unbind cdc_acm from the board's interface. Refused unless apollo-miner
  // is active: a board that is idle (miner stopped, after miner_stop's reset) wedges
  // when toggled, while with the miner running the same toggle recovers.
  const unplug = async (tty, expectSerial = null) => {
    const minerState = (await ssh('systemctl show apollo-miner -p ActiveState --value || true')).trim();
    if (minerState !== 'active') {
      throw new Error(`refusing: apollo-miner is ${minerState || 'unknown'}, not active: an idle board wedges when toggled (use reemit for a stopped miner) — nothing written`);
    }
    const { dir, iface, serial } = await inspect(tty, expectSerial);
    // Before the write: a crash right after it must still leave the way back.
    fsImpl.writeFileSync(markerPath, JSON.stringify({ iface, dir, tty, serial, at: new Date().toISOString() }), { mode: 0o600 });
    let out;
    try {
      out = await ssh(unbindCommand(iface, { serial: expectSerial }), { timeoutMs: 30000 });
    } catch (err) {
      // The shell says why it refused on stderr; ssh puts it in the error.
      throw new Error(`${(err.stderr || err.message || '').toString().trim().split('\n').pop()} (nothing unbound, or the unbind failed: marker kept so the restore binds it back)`);
    }
    if (String(out).trim() !== 'unbound') throw new Error(`the unbind answered "${String(out).trim()}"`);
    return iface;
  };

  // A plug seen by udev without touching the device: the add event of the board's
  // tty is emitted again. The tty must belong to the board (by serial).
  const reemit = async (tty, expectSerial) => {
    if (!/^ttyACM\d+$/.test(tty)) throw new Error(`"${tty}" is not a ttyACM port`);
    if (!expectSerial) throw new Error('reemit needs the board serial');
    const port = portFor(parsePortList(await ssh(PORT_LIST_CMD)), expectSerial);
    if (!port || port.tty !== tty) {
      throw new Error(`refusing: /dev/${tty} is not the board ${expectSerial} (sysfs says ${port ? port.tty : 'not on the bus'}) — no event emitted`);
    }
    await ssh(`sudo -n udevadm trigger --action=add --settle /sys/class/tty/${tty}`, { timeoutMs: 60000 });
    return port.tty;
  };
  const replug = () => replugFromMarker({ ssh, markerPath, healthPath, fsImpl, waitUntil });
  const isUnplugged = () => readMarker(fsImpl, markerPath) !== null;
  return { inspect, unplug, reemit, replug, isUnplugged };
};

// ------------------------------------------------------------ API, device

// `ps -eo pid=,comm=,args=` -> the miner processes and the port each one drives.
// The comm is the binary: screen's own command line also names the miner, and must
// not be counted as a second miner.
const parseMinerProcs = (text) =>
  String(text || '').split('\n').map((l) => /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec(l)).filter(Boolean)
    .filter((m) => /^futurebit-miner/.test(m[2]))
    .map((m) => ({ pid: Number(m[1]), comport: /-comport\s+(\S+)/.exec(m[3])?.[1] ?? null }));
const procsOn = (procs, tty) => procs.filter((p) => p.comport === `/dev/${tty}`);
const internalProcs = (procs) => procs.filter((p) => p.comport && !/ttyACM/.test(p.comport));

// A schema without `Miner.boards`: the feature is not on this build.
const isBoardsMissing = (err) =>
  !!err && err.malformed === true && /Cannot query field "boards"/.test(String(err.message));

const usbBoards = (boards) => (boards || []).filter((b) => b.kind === 'usb');

const msUntilExpiry = (board, nowMs) => {
  const t = Date.parse(board?.expiresAt);
  return Number.isFinite(t) ? t - nowMs : null;
};
const expiresAround = (board, nowMs, { minMs = 13 * 60000, maxMs = 16 * 60000 } = {}) => {
  const ms = msUntilExpiry(board, nowMs);
  return ms !== null && ms >= minMs && ms <= maxMs;
};

// ------------------------------------------------------------------- UI

// Every "Active a/t" badge in a block of page text.
const activeBadges = (text) =>
  [...String(text || '').matchAll(/Active\s+(\d+)\s*\/\s*(\d+)/g)].map((m) => ({ active: Number(m[1]), total: Number(m[2]) }));

// "rgb(237, 137, 54)" is Chakra's orange.500; accept the warm range, not one value.
const isOrange = (css) => {
  const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(String(css || ''));
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return r >= 200 && g >= 90 && g <= 190 && b <= 110 && r - b >= 100;
};

const leadingInt = (text) => {
  const m = /(\d+)\s*$/.exec(String(text || '').trim());
  return m ? Number(m[1]) : null;
};

module.exports = {
  BOARD,
  MARKER,
  shq,
  ttyOf,
  usbDeviceDirOf,
  isDeviceDir,
  parseIds,
  isApolloBoard,
  authorizeCommand,
  readMarker,
  replugFromMarker,
  createUsbRig,
  parseMinerProcs,
  procsOn,
  internalProcs,
  isBoardsMissing,
  usbBoards,
  msUntilExpiry,
  expiresAround,
  activeBadges,
  isOrange,
  leadingInt,
  markerFile: (out) => path.join(out, MARKER),
  healthFile: (out) => path.join(out, HEALTH),
  productState,
  PORT_LIST_CMD,
  parsePortList,
  portFor,
  waitSlvStable,
  pickJournal,
  journalCommand,
  wedgedInJournal,
  verifyHealth,
  MANUAL_RESTORE,
  findOrphans,
  LEGACY_MARKER,
  IFACE_NAME_RE,
  isIfaceName,
  unbindCommand,
  bindCommand,
  IFACE_SCAN_CMD,
  parseIfaceScan,
  unboundIn,
  USB_SCAN_CMD,
  USB_UNITS_CMD,
  parseUsbScan,
  orphansIn,
  rescueOrphans,
  leftoverMarkers,
  instanceMismatch,
  activeUnitNames,
  hashboardsBadge,
  isTransient,
};
