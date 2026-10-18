const probes = require('./probes');
const { DIR } = require('../lib/snapshot');

// What a round may change and must put back.
//
// `lib/snapshot.js` already covers the database and the system timezone. That is
// not the whole device: the miner and node config files are written by the API
// at save time and do not come back with the database; NetworkManager lives
// outside it entirely; and a service a journey started stays started. This
// module photographs the rest, puts it back, and says what did not come back.

const UNITS = ['apollo-miner', 'node', 'ckpool'];

const POOLS = `{ Pool { list { result { pools { id url username enabled index } } error { message } } } }`;
const SETTINGS = `{ Settings { list { result { settings {
  id minerMode nodeSoftware nodeEnableTor nodeEnableSoloMining temperatureUnit
} } error { message } } } }`;
const WIFI_CONNECT = `mutation($input: McuWifiConnectInput!) {
  Mcu { wifiConnect(input: $input) { result { address } error { message } } }
}`;

// Single-quote for the remote shell: a profile name is whatever the user typed.
const shq = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

const flat = (file) => file.split('/').pop();

// Services and the API's own view, read defensively: a field the schema of this
// release does not have must not stop a round from starting.
const readApi = async (gql) => {
  const out = {};
  try {
    out.pools = (await gql(POOLS)).Pool.list.result?.pools ?? [];
  } catch (err) {
    out.poolsUnavailable = err.message;
  }
  try {
    const all = (await gql(SETTINGS)).Settings.list.result?.settings ?? [];
    // Append-only table: the newest row is the configuration in force.
    out.settings = [...all].sort((a, b) => b.id - a.id)[0] ?? null;
  } catch (err) {
    out.settingsUnavailable = err.message;
  }
  return out;
};

const confHashes = async (ssh) => {
  const text = await ssh(
    `for f in ${probes.CONF_FILES.join(' ')}; do sudo sha256sum "$f" 2>/dev/null; done || true`
  );
  return Object.fromEntries(
    text.split('\n').filter(Boolean).map((l) => {
      const [hash, ...file] = l.trim().split(/\s+/);
      return [file.join(' '), hash];
    })
  );
};

const capture = async ({ ssh, gql }) => {
  const services = {};
  for (const unit of UNITS) services[unit] = await probes.unitState(ssh, unit);
  return {
    at: new Date().toISOString(),
    services,
    timezone: await probes.timezone(ssh),
    nmcli: await probes.nmcliState(ssh),
    savedWifi: (await probes.nmcliSaved(ssh)).filter(probes.isWifi),
    defaultRoute: await probes.defaultRouteDevices(ssh),
    bitcoind: await probes.bitcoindVersion(ssh),
    confHashes: await confHashes(ssh),
    ...(await readApi(gql)),
  };
};

// The snapshot proper: the existing DB + timezone one, plus the config files and
// the photograph above. `base` is injectable for the offline tests.
const takeStateSnapshot = async ({ profile, ssh, gql, base }) => {
  const db = await base.takeSnapshot(profile);
  // takeSnapshot empties DIR, so the copies come after it.
  const copied = (
    await ssh(
      `for f in ${probes.CONF_FILES.join(' ')}; do ` +
      `if sudo test -f "$f"; then sudo cp -p "$f" "${DIR}/conf.$(basename "$f")" && echo "$f"; fi; done`
    )
  ).split('\n').filter(Boolean);
  return { db, confCopied: copied, before: await capture({ ssh, gql }) };
};

const waitFor = async (waitUntil, probe, opts) => (await waitUntil(probe, opts)).ok;

const apiAnswers = (gql) => async () => {
  try { await gql('{ __typename }'); return true; } catch { return false; }
};

// "Not an active connection" on a `down` is the state that was asked for.
const alreadyDone = (err) => /not an active connection|no active connection|not active/i.test(`${err?.message} ${err?.stderr || ''}`);

// Ethernet is never taken down, whatever the snapshot says: the run reaches the
// device through it, and a wifi mistake must not cost the way back in.
const restoreNetwork = async ({ ssh, gql, snap, wifi, waitUntil, notes, errors }) => {
  const now = await probes.nmcliState(ssh);
  const had = snap.before.nmcli.active;
  const has = (list, uuid) => list.some((c) => c.uuid === uuid);
  const broughtUp = [];

  for (const c of had) {
    if (has(now.active, c.uuid)) continue;
    try {
      await ssh(`sudo nmcli connection up uuid ${c.uuid}`, { timeoutMs: 60000 });
      notes.push(`network: ${c.name} (${c.device}) brought back up`);
      broughtUp.push(c.uuid);
    } catch (err) {
      // A 2.1.x "disconnect" deletes the saved profile: there is nothing to bring
      // up, so join again the way a user would.
      if (probes.isWifi(c) && wifi?.passphrase) {
        try {
          await gql(WIFI_CONNECT, { input: { ssid: c.name, passphrase: wifi.passphrase, ifname: c.device } });
          notes.push(`network: ${c.name} had no saved profile, joined again`);
          broughtUp.push(c.uuid);
        } catch (err2) {
          errors.push(`network: could not rejoin ${c.name}: ${err2.message}`);
        }
      } else {
        errors.push(`network: could not bring ${c.name} back: ${err.message}`);
      }
    }
  }

  // Once each, and a profile that is not active counts as done.
  for (const c of now.active) {
    // Only wifi that the snapshot did not have: never ethernet, never loopback.
    if (!probes.isWifi(c) || has(had, c.uuid)) continue;
    try {
      await ssh(`sudo nmcli connection down uuid ${c.uuid}`, { timeoutMs: 30000 });
      notes.push(`network: left ${c.name}, which was not connected at the start`);
    } catch (err) {
      if (!alreadyDone(err)) errors.push(`network: could not leave ${c.name}: ${err.message}`);
    }
  }

  // Wait only for what this restore itself asked for.
  const wanted = broughtUp.filter((u) => had.some((c) => c.uuid === u && probes.isWifi(c)));
  if (wanted.length) {
    const ok = await waitFor(
      waitUntil,
      async () => {
        const s = await probes.nmcliState(ssh);
        return wanted.every((u) => has(s.active, u));
      },
      { timeoutMs: 60000, everyMs: 3000 }
    );
    if (!ok) errors.push('network: the wifi connection did not come back within 60 s');
  }

  await restoreSavedWifi({ ssh, snap, notes, errors });
};

// The saved wifi profiles themselves: name and autoconnect go back to what they
// were (a profile recreated by a disconnect/join comes back with autoconnect=yes
// and a new UUID). A UUID cannot be put back: that stays in the drift list.
const restoreSavedWifi = async ({ ssh, snap, notes, errors }) => {
  const before = snap.before.savedWifi;
  if (!before) return;
  const now = (await probes.nmcliSaved(ssh)).filter(probes.isWifi);
  for (const s of before) {
    const c = now.find((x) => x.uuid === s.uuid) || now.find((x) => x.name === s.name && !before.some((b) => b.uuid === x.uuid));
    if (!c) continue;
    try {
      if (c.name !== s.name) {
        await ssh(`sudo nmcli connection modify uuid ${c.uuid} connection.id ${shq(s.name)}`);
        notes.push(`network: profile ${c.uuid} renamed back to ${s.name}`);
      }
      if (c.autoconnect !== s.autoconnect) {
        await ssh(`sudo nmcli connection modify uuid ${c.uuid} connection.autoconnect ${s.autoconnect === 'yes' ? 'yes' : 'no'}`);
        notes.push(`network: ${s.name} autoconnect put back to ${s.autoconnect}`);
      }
    } catch (err) {
      errors.push(`network: could not restore the saved profile ${s.name}: ${err.message}`);
    }
  }
};

const restoreState = async ({ profile, ssh, gql, gqlWrite, snap, base, waitUntil, wifi }) => {
  const notes = [];
  const errors = [];
  const step = async (name, fn) => {
    try { await fn(); } catch (err) { errors.push(`${name}: ${err.message}`); }
  };

  await step('database', async () => {
    notes.push(...(await base.restoreSnapshot(profile, snap.db)));
    const up = await waitFor(waitUntil, apiAnswers(gql), { timeoutMs: 90000, everyMs: 3000 });
    if (!up) throw new Error('the API did not answer within 90 s of the restore');
  });

  await step('config files', async () => {
    for (const f of snap.confCopied) {
      const copy = `${DIR}/conf.${flat(f)}`;
      const out = await ssh(`if ! sudo cmp -s "${copy}" "${f}"; then sudo cp -p "${copy}" "${f}" && echo changed; fi`);
      if (out) notes.push(`restored ${flat(f)}`);
    }
  });

  await step('network', () => restoreNetwork({ ssh, gql: gqlWrite, snap, wifi, waitUntil, notes, errors }));

  // Node and ckpool go back to what they were. The miner is NOT handled here: the
  // obligation at the end of a round is "off", whatever it was at the start.
  for (const [unit, group] of [['node', 'Node'], ['ckpool', 'Solo']]) {
    await step(unit, async () => {
      const want = snap.before.services[unit];
      const have = await probes.unitState(ssh, unit);
      if (want === have || (want !== 'active' && have !== 'active')) return;
      const action = want === 'active' ? 'start' : 'stop';
      await gqlWrite(`mutation { ${group} { ${action} { error { message } } } }`);
      const ok = await waitFor(
        waitUntil,
        async () => ((await probes.unitState(ssh, unit)) === 'active') === (action === 'start'),
        { timeoutMs: action === 'start' ? 240000 : 180000, everyMs: 5000 }
      );
      if (!ok) throw new Error(`${unit} did not ${action} within the deadline`);
      notes.push(`${unit}: ${action}ed to match the start of the round`);
    });
  }

  return { notes, errors };
};

// Differences between two photographs, as sentences. Empty is the only good answer.
const describeDrift = (before, after) => {
  const out = [];
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  if (before.timezone !== after.timezone) out.push(`timezone ${before.timezone} -> ${after.timezone}`);
  for (const unit of ['node', 'ckpool']) {
    if (before.services[unit] !== after.services[unit]) {
      out.push(`${unit} ${before.services[unit]} -> ${after.services[unit]}`);
    }
  }
  const v = (b) => (b ? `${b.family} ${b.version}` : 'unknown');
  if (v(before.bitcoind) !== v(after.bitcoind)) out.push(`bitcoind ${v(before.bitcoind)} -> ${v(after.bitcoind)}`);
  const wifi = (s) => s.nmcli.active.filter(probes.isWifi).map((c) => c.name).sort();
  const eth = (s) => s.nmcli.active.filter(probes.isEthernet).map((c) => c.name).sort();
  if (!same(wifi(before), wifi(after))) out.push(`wifi ${wifi(before).join(',') || 'none'} -> ${wifi(after).join(',') || 'none'}`);
  if (!same(eth(before), eth(after))) out.push(`ethernet ${eth(before).join(',') || 'none'} -> ${eth(after).join(',') || 'none'}`);
  // Saved wifi profiles: name, UUID and autoconnect. Today's miss: Wiffy was
  // autoconnect=no and came back yes with a new UUID, and nothing said so.
  const key = (list) => Object.fromEntries((list || []).map((c) => [c.name, c]));
  const bw = key(before.savedWifi);
  const aw = key(after.savedWifi);
  if (before.savedWifi && after.savedWifi) {
    for (const name of Object.keys(bw)) {
      if (!aw[name]) { out.push(`wifi profile ${name} is gone`); continue; }
      if (bw[name].uuid !== aw[name].uuid) out.push(`wifi profile ${name}: uuid ${bw[name].uuid} -> ${aw[name].uuid}`);
      if (bw[name].autoconnect !== aw[name].autoconnect) out.push(`wifi profile ${name}: autoconnect ${bw[name].autoconnect} -> ${aw[name].autoconnect}`);
    }
    for (const name of Object.keys(aw)) if (!bw[name]) out.push(`wifi profile ${name} is new`);
  }
  if (before.pools && after.pools && !same(before.pools, after.pools)) out.push('pools differ');
  if (before.settings && after.settings) {
    const { id: _a, ...b } = before.settings;
    const { id: _b, ...a } = after.settings;
    for (const k of Object.keys(b)) if (!same(b[k], a[k])) out.push(`setting ${k} ${b[k]} -> ${a[k]}`);
  }
  for (const f of Object.keys(before.confHashes)) {
    if (before.confHashes[f] !== after.confHashes[f]) out.push(`${flat(f)} differs`);
  }
  return out;
};

module.exports = {
  UNITS,
  capture,
  takeStateSnapshot,
  restoreState,
  describeDrift,
};
