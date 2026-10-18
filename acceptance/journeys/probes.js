// What the device itself says, as opposed to what the UI says about it.
//
// Every journey ends by asking the device: a toast that says "saved" proves the
// front end got an answer, not that miner_config holds the worker or that ckpool
// is hashing. The parsers here are pure so they can be tested without a device;
// the probes at the bottom take an `ssh(command) -> stdout` function.

const APOLLO = '/opt/apolloapi';
const PATHS = {
  minerConfig: `${APOLLO}/backend/apollo-miner/miner_config`,
  minerConfig3: `${APOLLO}/backend/apollo-miner/miner_config3`,
  minerDir: `${APOLLO}/backend/apollo-miner`,
  poolStatus: `${APOLLO}/backend/ckpool/logs/pool/pool.status`,
  ckpoolConf: `${APOLLO}/backend/ckpool/ckpool.conf`,
  apiConf: `${APOLLO}/backend/node/api.conf`,
  userConf: `${APOLLO}/backend/node/user.conf`,
  bitcoind: `${APOLLO}/backend/node/bitcoind`,
};

// Files a journey can rewrite and the DB restore does not bring back.
const CONF_FILES = [
  PATHS.minerConfig,
  PATHS.minerConfig3,
  PATHS.apiConf,
  PATHS.userConf,
  PATHS.ckpoolConf,
];

// ---------------------------------------------------------------- parsers

const SUFFIX = { K: 1e3, M: 1e6, G: 1e9, T: 1e12, P: 1e15, E: 1e18 };

// ckpool prints hashrates as "5.31T", "812G", "0".
const hashrateToNumber = (value) => {
  if (typeof value === 'number') return value;
  const m = /^\s*([\d.]+)\s*([KMGTPE])?\s*$/i.exec(String(value ?? ''));
  if (!m) return 0;
  return Number(m[1]) * (SUFFIX[(m[2] || '').toUpperCase()] || 1);
};

// pool.status is several JSON objects, one per line, that together describe the
// pool: runtime and users, hashrates, shares.
const parsePoolStatus = (text) => {
  const merged = {};
  String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .forEach((line) => {
      try { Object.assign(merged, JSON.parse(line)); } catch { /* a half-written line */ }
    });
  return {
    runtime: Number(merged.runtime) || 0,
    users: Number(merged.Users) || 0,
    workers: Number(merged.Workers) || 0,
    hashrate1m: hashrateToNumber(merged.hashrate1m),
    hashrate5m: hashrateToNumber(merged.hashrate5m),
    accepted: Number(merged.accepted) || 0,
    rejected: Number(merged.rejected) || 0,
    empty: Object.keys(merged).length === 0,
  };
};

// "Bitcoin Core version v28.1.0" / "Bitcoin Knots version v29.3.knots20260101".
const parseBitcoindVersion = (text) => {
  const m = /Bitcoin\s+(Core|Knots)\s+(?:Daemon\s+)?version\s+v?(\d+\.\d+(?:\.\d+)?)/i.exec(String(text || ''));
  if (!m) return null;
  return { family: m[1].toLowerCase(), version: m[2] };
};

// "28.1" matches 28.1 and 28.1.0 but not 28.10.
const bitcoindIs = (parsed, family, version) =>
  !!parsed &&
  parsed.family === family &&
  (parsed.version === version || parsed.version.startsWith(`${version}.`));

// Only the three flags a journey asserts on. The pool password (-pswd) is never
// read into a result, so it cannot reach a report.
const parseMinerArgs = (text) => {
  const pick = (flag) => new RegExp(`(?:^|\\s)-${flag}\\s+(\\S+)`).exec(String(text || ''))?.[1] ?? null;
  return { host: pick('host'), port: pick('port'), user: pick('user') };
};

// `nmcli -t` separates with ":" and escapes a literal one as "\:".
const splitTerse = (line) => {
  const out = [];
  let cur = '';
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] === '\\' && i + 1 < line.length) { cur += line[i + 1]; i += 1; }
    else if (line[i] === ':') { out.push(cur); cur = ''; }
    else cur += line[i];
  }
  out.push(cur);
  return out;
};

const parseNmcliActive = (text) =>
  String(text || '').split('\n').filter(Boolean).map((l) => {
    const [name, uuid, type, device] = splitTerse(l);
    return { name, uuid, type, device };
  });

const parseNmcliDevices = (text) =>
  String(text || '').split('\n').filter(Boolean).map((l) => {
    const [device, type, state, connection] = splitTerse(l);
    return { device, type, state, connection };
  });

// Saved profiles, active or not: `nmcli -t -f NAME,UUID,TYPE,AUTOCONNECT connection show`.
const parseNmcliSaved = (text) =>
  String(text || '').split('\n').filter(Boolean).map((l) => {
    const [name, uuid, type, autoconnect] = splitTerse(l);
    return { name, uuid, type, autoconnect };
  });

const isWifi = (c) => /wireless|wifi/i.test(c.type || '');
const isEthernet = (c) => /ethernet/i.test(c.type || '') || /^(eth|en)/.test(c.device || '');

// ARP flux: with ethernet and wifi on the SAME subnet and Linux's defaults
// (arp_ignore=0, arp_announce=0), either interface answers ARP for the other's
// address, so taking wlan down/up can make the ethernet address unreachable for
// minutes. Returns the reason a wifi journey is unsafe, or null.
const ipv4Network = (cidr) => {
  const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/.exec(cidr);
  if (!m) return null;
  const bits = Number(m[5]);
  const n = (((+m[1] << 24) | (+m[2] << 16) | (+m[3] << 8) | +m[4]) >>> 0);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return `${(n & mask) >>> 0}/${bits}`;
};

// `ip -4 -o addr show`: "2: eth0    inet 192.168.86.66/24 brd ..."
const arpFluxRisk = ({ addrText, arpIgnore, arpAnnounce }) => {
  const rows = String(addrText || '').split('\n').map((l) => /^\d+:\s+(\S+)\s+inet\s+(\S+)/.exec(l)).filter(Boolean)
    .map((m) => ({ dev: m[1], cidr: m[2], net: ipv4Network(m[2]) })).filter((r) => r.net);
  const eth = rows.filter((r) => /^(eth|en)/.test(r.dev));
  const wifi = rows.filter((r) => /^(wl|wlan)/.test(r.dev));
  const shared = eth.find((e) => wifi.some((w) => w.net === e.net));
  if (!shared) return null;
  const w = wifi.find((x) => x.net === shared.net);
  const ignore = Number(arpIgnore);
  const announce = Number(arpAnnounce);
  if (ignore >= 1 && announce === 2) return null;
  return `${shared.dev} (${shared.cidr}) and ${w.dev} (${w.cidr}) are on the same subnet, with arp_ignore=${arpIgnore} and arp_announce=${arpAnnounce} (safe is >=1 and 2): ARP flux, so taking the radio down can cut the ethernet address too`;
};

const deviceOfRoute = (text) => /\bdev\s+(\S+)/.exec(String(text || ''))?.[1] ?? null;
const devicesOfDefaultRoutes = (text) =>
  String(text || '').split('\n').map((l) => deviceOfRoute(l)).filter(Boolean);

// systemd prints "Sun 2026-10-18 10:00:00 UTC" when asked with TZ=UTC.
const parseSystemdTime = (value) => {
  const m = /(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})/.exec(String(value || ''));
  return m ? Date.parse(`${m[1]}T${m[2]}Z`) : NaN;
};

// A key=value dump from `systemctl show`.
const parseShow = (text) =>
  Object.fromEntries(
    String(text || '').split('\n').filter((l) => l.includes('=')).map((l) => {
      const i = l.indexOf('=');
      return [l.slice(0, i), l.slice(i + 1)];
    })
  );

// What the journal of apollo-miner says about its stops.
//
// A stop is "Stopping apollo-miner." (or the unit's "Deactivated"); when systemd
// runs ExecStop, miner_stop.sh prints its closing "Stopped" on a line of its own
// (not systemd's "Stopped apollo-miner."). A stop with no such line after it never
// ran the script — which is what a stop of a unit still `activating` does.
// `lastSkipped` is about the LAST stop only: that is the one that decides whether
// the board was left reset.
// A stop is good when miner_stop.sh printed its closing line during it. A stop
// does not always log "Stopping apollo-miner": one that lands while the unit is
// still activating goes straight to the kill, and since the fix the script runs
// as ExecStopPost and prints BEFORE "Deactivated". So a stop is the span from
// "Stopping" (or the first sign of one) to "Stopped apollo-miner." / a failure,
// and the script line counts for the stop it falls in.
const analyseStops = (text) => {
  let stops = 0;
  let scripts = 0;
  let lastSkipped = false;
  let open = false;
  let seen = false;
  const close = () => {
    if (!open) return;
    stops += 1;
    if (seen) scripts += 1;
    lastSkipped = !seen;
    open = false;
    seen = false;
  };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (/^Stopping apollo-miner/.test(line)) {
      close();
      open = true;
    } else if (line === 'Stopped' || /^Killing session/.test(line)) {
      open = true;
      seen = true;
    } else if (/Deactivated successfully|apollo-miner\.service: Deactivated/.test(line)) {
      open = true;
    } else if (/^Stopped apollo-miner\b|Failed with result/.test(line)) {
      open = true;
      close();
    } else if (/^Start(ing|ed) apollo-miner/.test(line)) {
      close();
    }
  }
  close();
  return { stops, scripts, lastSkipped };
};

// ---------------------------------------------------------------- probes

const unitState = async (ssh, unit) =>
  (await ssh(`systemctl show ${unit} -p ActiveState --value || true`)) || 'unknown';

const readFile = (ssh, file) => ssh(`sudo cat ${file} 2>/dev/null || true`);

const poolStatus = async (ssh) => parsePoolStatus(await readFile(ssh, PATHS.poolStatus));

const bitcoindVersion = async (ssh) =>
  parseBitcoindVersion(await ssh(`${PATHS.bitcoind} -version 2>&1 | head -1 || true`));

const minerArgs = async (ssh) => ({
  usb: parseMinerArgs(await readFile(ssh, PATHS.minerConfig)),
  iii: parseMinerArgs(await readFile(ssh, PATHS.minerConfig3)),
});

// The stat file the miner writes carries the pool it is on: look for the strings
// rather than a schema, which differs between the Apollo II and III files.
// The USB boards write `apollo-miner.<uid>` / `apollo-miner-v<n>.<uid>` and the
// Apollo III `apollo-miner-3.json` (see services/miner.js); a bare `apollo-miner*`
// would also pick up the helper binaries that live in the same directory.
const STAT_FILES = ['apollo-miner.*', 'apollo-miner-v*.*', 'apollo-miner-3.json'];
const statFilesCommand = () =>
  `cd ${PATHS.minerDir} && sudo cat ${STAT_FILES.join(' ')} 2>/dev/null || true`;

// Returns which of `needles` appear in any stat file.
const statFileMentions = async (ssh, needles) => {
  const text = await ssh(statFilesCommand());
  return Object.fromEntries(needles.map((n) => [n, text.includes(n)]));
};

const nmcliSaved = async (ssh) =>
  parseNmcliSaved(await ssh('nmcli -t -f NAME,UUID,TYPE,AUTOCONNECT connection show || true'));

const nmcliState = async (ssh) => ({
  active: parseNmcliActive(await ssh('nmcli -t -f NAME,UUID,TYPE,DEVICE connection show --active || true')),
  devices: parseNmcliDevices(await ssh('nmcli -t -f DEVICE,TYPE,STATE,CONNECTION device status || true')),
});

const defaultRouteDevices = async (ssh) => devicesOfDefaultRoutes(await ssh('ip route show default || true'));

// The interface this ssh session itself arrives on: the one a journey must never
// take down, wherever the default route happens to point.
const sessionDevice = async (ssh) =>
  deviceOfRoute(await ssh('ip route get "${SSH_CONNECTION%% *}" 2>/dev/null | head -1 || true'));

const timezone = (ssh) => ssh('timedatectl show -p Timezone --value');

// Does the Linux user `futurebit` have this password? The password travels on
// stdin only. python3's crypt handles yescrypt, the Debian default that openssl
// cannot compute.
const linuxPasswordMatches = async (ssh, password) =>
  (await ssh(
    'sudo python3 -c "import crypt,subprocess,sys; ' +
    "h=subprocess.check_output(['getent','shadow','futurebit'],text=True).split(':')[1]; " +
    "pw=sys.stdin.readline().rstrip('\\n'); print('MATCH' if crypt.crypt(pw,h)==h else 'NO')\"",
    { input: `${password}\n` }
  )) === 'MATCH';

const torEnabled = async (ssh) => /^\s*onlynet\s*=\s*onion\s*$/m.test(await readFile(ssh, PATHS.apiConf));

module.exports = {
  PATHS,
  CONF_FILES,
  hashrateToNumber,
  parsePoolStatus,
  parseBitcoindVersion,
  bitcoindIs,
  parseMinerArgs,
  splitTerse,
  parseNmcliActive,
  parseNmcliDevices,
  parseNmcliSaved,
  arpFluxRisk,
  ipv4Network,
  nmcliSaved,
  isWifi,
  isEthernet,
  deviceOfRoute,
  devicesOfDefaultRoutes,
  parseSystemdTime,
  parseShow,
  analyseStops,
  unitState,
  readFile,
  poolStatus,
  bitcoindVersion,
  minerArgs,
  statFileMentions,
  statFilesCommand,
  nmcliState,
  defaultRouteDevices,
  sessionDevice,
  timezone,
  torEnabled,
  linuxPasswordMatches,
};
