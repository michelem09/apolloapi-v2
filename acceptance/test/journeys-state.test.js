// Offline tier: snapshot and restore of everything a round may change.
const test = require('node:test');
const assert = require('node:assert/strict');
const { takeStateSnapshot, restoreState, capture, describeDrift } = require('../journeys/state');

const WLAN = 'Wiffy:uuid-wifi:802-11-wireless:wlan0';
const ETH = 'Wired connection 1:uuid-eth:802-3-ethernet:eth0';

// A scripted device: answers by pattern, records every command.
const device = ({ active = [ETH, WLAN], units = {}, version = 'Bitcoin Core version v28.1.0', tz = 'Europe/Rome', failOn = [] } = {}) => {
  const log = [];
  const s = { active: [...active], units: { 'apollo-miner': 'inactive', node: 'active', ckpool: 'inactive', ...units } };
  const ssh = async (cmd) => {
    log.push(cmd);
    if (failOn.some((f) => cmd.includes(f))) throw new Error(`ssh failed: ${f(cmd)}`);
    let m;
    if (/connection show --active/.test(cmd)) return s.active.join('\n');
    if (/device status/.test(cmd)) return 'eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:connected:Wiffy';
    if (/ip route show default/.test(cmd)) return 'default via 1.1.1.1 dev eth0';
    if ((m = /systemctl show (\S+) -p ActiveState/.exec(cmd))) return s.units[m[1]];
    if (/timedatectl/.test(cmd)) return tz;
    if (/-version/.test(cmd)) return version;
    if (/sha256sum/.test(cmd)) return 'abc  /opt/apolloapi/backend/apollo-miner/miner_config';
    if ((m = /nmcli connection up uuid (\S+)/.exec(cmd))) {
      const u = m[1];
      const row = [ETH, WLAN].find((r) => r.includes(u));
      if (row && !s.active.includes(row)) s.active.push(row);
      return '';
    }
    if ((m = /nmcli connection down uuid (\S+)/.exec(cmd))) {
      s.active = s.active.filter((r) => !r.includes(m[1]));
      return '';
    }
    if (/for f in .*cp -p/.test(cmd)) return '/opt/apolloapi/backend/apollo-miner/miner_config\n/opt/apolloapi/backend/node/api.conf';
    if (/cmp -s/.test(cmd)) return 'changed';
    return '';
  };
  const f = (c) => c.slice(0, 30);
  return { s, log, ssh };
};

const api = () => {
  const writes = [];
  return {
    writes,
    gql: async (doc) => {
      if (/Pool \{ list/.test(doc)) return { Pool: { list: { result: { pools: [{ id: 1, url: 'u', username: 'w', enabled: true, index: 0 }] } } } };
      if (/Settings \{ list/.test(doc)) return { Settings: { list: { result: { settings: [{ id: 3, nodeSoftware: 'core_28_1', temperatureUnit: 'c' }, { id: 2, nodeSoftware: 'knots_29_3' }] } } } };
      return { __typename: 'Query' };
    },
    gqlWrite: async (doc) => { writes.push(doc); return {}; },
  };
};

const base = (order = []) => ({
  takeSnapshot: async () => { order.push('db-snapshot'); return { db: '/x.sqlite', timezone: 'Europe/Rome' }; },
  restoreSnapshot: async () => { order.push('db-restore'); return []; },
});

const instantWait = async (probe) => ((await probe()) ? { ok: true, waitedMs: 0 } : { ok: false, waitedMs: 0 });

test('capture reads services, network, timezone, binary, pools and the newest settings row', async () => {
  const d = device();
  const a = api();
  const c = await capture({ ssh: d.ssh, gql: a.gql });
  assert.equal(c.services.node, 'active');
  assert.equal(c.timezone, 'Europe/Rome');
  assert.equal(c.bitcoind.version, '28.1.0');
  assert.equal(c.nmcli.active.length, 2);
  assert.equal(c.settings.id, 3);
  assert.equal(c.pools.length, 1);
  assert.equal(c.confHashes['/opt/apolloapi/backend/apollo-miner/miner_config'], 'abc');
});

test('a settings query this release cannot answer does not stop the round from starting', async () => {
  const d = device();
  const a = api();
  const c = await capture({ ssh: d.ssh, gql: async (doc) => { if (/Settings/.test(doc)) throw new Error('Cannot query field "list"'); return a.gql(doc); } });
  assert.match(c.settingsUnavailable, /Cannot query/);
  assert.equal(c.pools.length, 1);
});

test('the config files are copied AFTER the database snapshot, which empties the directory', async () => {
  const d = device();
  const order = [];
  const b = base(order);
  const ssh = async (cmd) => { if (/cp -p/.test(cmd)) order.push('conf-copy'); return d.ssh(cmd); };
  const snap = await takeStateSnapshot({ profile: {}, ssh, gql: api().gql, base: b });
  assert.deepEqual(order, ['db-snapshot', 'conf-copy']);
  assert.equal(snap.confCopied.length, 2);
});

test('restore: database, then config files, then network, then services', async () => {
  const d = device();
  const a = api();
  const order = [];
  const snap = await takeStateSnapshot({ profile: {}, ssh: d.ssh, gql: a.gql, base: base(order) });
  order.length = 0;
  // One timeline for everything the restore does.
  const ssh = async (cmd) => {
    if (/cmp -s/.test(cmd)) order.push('config');
    if (/nmcli -t -f NAME,UUID,TYPE,DEVICE connection show/.test(cmd)) order.push('network');
    if (/systemctl show node -p ActiveState/.test(cmd)) order.push('services');
    return d.ssh(cmd);
  };
  const r = await restoreState({ profile: {}, ssh, gql: a.gql, gqlWrite: a.gqlWrite, snap, base: base(order), waitUntil: instantWait });
  assert.deepEqual(r.errors, []);
  const first = (name) => order.indexOf(name);
  assert.equal(order[0], 'db-restore');
  assert.ok(first('config') < first('network') && first('network') < first('services'), order.join(' > '));
  assert.ok(r.notes.some((n) => /restored miner_config/.test(n)));
});

test('restore: a wifi connection that was lost is brought back, and ethernet is never taken down', async () => {
  const d = device();
  const a = api();
  const snap = await takeStateSnapshot({ profile: {}, ssh: d.ssh, gql: a.gql, base: base() });
  d.s.active = [ETH]; // the journey left Wiffy
  d.log.length = 0;
  const r = await restoreState({ profile: {}, ssh: d.ssh, gql: a.gql, gqlWrite: a.gqlWrite, snap, base: base(), waitUntil: instantWait });
  assert.ok(d.log.some((c) => /connection up uuid uuid-wifi/.test(c)));
  assert.ok(!d.log.some((c) => /connection down/.test(c)), d.log.join('\n'));
  assert.deepEqual(r.errors, []);
});

test('restore: a wifi network that was not connected at the start is left, ethernet untouched', async () => {
  const d = device({ active: [ETH] });
  const a = api();
  const snap = await takeStateSnapshot({ profile: {}, ssh: d.ssh, gql: a.gql, base: base() });
  d.s.active = [ETH, WLAN];
  d.log.length = 0;
  await restoreState({ profile: {}, ssh: d.ssh, gql: a.gql, gqlWrite: a.gqlWrite, snap, base: base(), waitUntil: instantWait });
  const downs = d.log.filter((c) => /connection down/.test(c));
  assert.equal(downs.length, 1);
  assert.match(downs[0], /uuid-wifi/);
  assert.ok(!downs.some((c) => /uuid-eth/.test(c)));
});

test('restore: an ethernet connection that appeared during the round is never taken down', async () => {
  const d = device({ active: [WLAN] });
  const a = api();
  const snap = await takeStateSnapshot({ profile: {}, ssh: d.ssh, gql: a.gql, base: base() });
  d.s.active = [WLAN, ETH]; // the cable went in during the round
  d.log.length = 0;
  await restoreState({ profile: {}, ssh: d.ssh, gql: a.gql, gqlWrite: a.gqlWrite, snap, base: base(), waitUntil: instantWait });
  assert.ok(!d.log.some((c) => /connection down/.test(c)), d.log.join('\n'));
});

test('restore: a forgotten wifi profile is joined again through the API, passphrase in the call not the command line', async () => {
  const d = device();
  const a = api();
  const snap = await takeStateSnapshot({ profile: {}, ssh: d.ssh, gql: a.gql, base: base() });
  d.s.active = [ETH];
  const ssh = async (cmd) => {
    if (/connection up uuid uuid-wifi/.test(cmd)) throw new Error('no such connection');
    return d.ssh(cmd);
  };
  const calls = [];
  const gqlWrite = async (doc, vars) => { calls.push([doc, vars]); d.s.active.push(WLAN); return {}; };
  const r = await restoreState({ profile: {}, ssh, gql: a.gql, gqlWrite, snap, base: base(), waitUntil: instantWait, wifi: { passphrase: 'pw' } });
  assert.equal(calls[0][1].input.ssid, 'Wiffy');
  assert.equal(calls[0][1].input.passphrase, 'pw');
  assert.deepEqual(r.errors, []);
});

test('restore: one step failing does not skip the ones after it', async () => {
  const d = device();
  const a = api();
  const snap = await takeStateSnapshot({ profile: {}, ssh: d.ssh, gql: a.gql, base: base() });
  d.s.units.node = 'inactive'; // the journey left the node down
  const failing = { ...base(), restoreSnapshot: async () => { throw new Error('cannot stop apollo-api'); } };
  const r = await restoreState({ profile: {}, ssh: d.ssh, gql: a.gql, gqlWrite: async (doc) => { a.writes.push(doc); d.s.units.node = 'active'; return {}; }, snap, base: failing, waitUntil: instantWait });
  assert.ok(r.errors.some((e) => /database: cannot stop apollo-api/.test(e)));
  assert.ok(a.writes.some((w) => /Node \{ start/.test(w)), 'the node was still started again');
});

test('restore: services go back to how they were, the miner is left to the end-of-round step', async () => {
  const d = device({ units: { ckpool: 'inactive' } });
  const a = api();
  const snap = await takeStateSnapshot({ profile: {}, ssh: d.ssh, gql: a.gql, base: base() });
  d.s.units.ckpool = 'active'; // a solo journey started it
  d.s.units['apollo-miner'] = 'active';
  const writes = [];
  await restoreState({ profile: {}, ssh: d.ssh, gql: a.gql, gqlWrite: async (doc) => { writes.push(doc); d.s.units.ckpool = 'inactive'; return {}; }, snap, base: base(), waitUntil: instantWait });
  assert.ok(writes.some((w) => /Solo \{ stop/.test(w)));
  assert.ok(!writes.some((w) => /Miner/.test(w)));
});

test('drift: says what differs, and nothing when nothing does', async () => {
  const d = device();
  const a = api();
  const before = await capture({ ssh: d.ssh, gql: a.gql });
  assert.deepEqual(describeDrift(before, JSON.parse(JSON.stringify(before))), []);
  const after = JSON.parse(JSON.stringify(before));
  after.timezone = 'UTC';
  after.bitcoind = { family: 'knots', version: '29.3' };
  after.services.ckpool = 'active';
  after.nmcli.active = after.nmcli.active.filter((c) => !/wireless/.test(c.type));
  after.settings.temperatureUnit = 'f';
  after.confHashes['/opt/apolloapi/backend/apollo-miner/miner_config'] = 'zzz';
  const drift = describeDrift(before, after).join('\n');
  for (const needle of ['timezone Europe/Rome -> UTC', 'bitcoind core 28.1.0 -> knots 29.3', 'ckpool inactive -> active', 'wifi Wiffy -> none', 'setting temperatureUnit c -> f', 'miner_config differs']) {
    assert.match(drift, new RegExp(needle.replace(/[.>]/g, '.')));
  }
});

test('drift: a missing ethernet connection is reported — it is the way in', async () => {
  const d = device();
  const a = api();
  const before = await capture({ ssh: d.ssh, gql: a.gql });
  const after = JSON.parse(JSON.stringify(before));
  after.nmcli.active = after.nmcli.active.filter((c) => !/ethernet/.test(c.type));
  assert.match(describeDrift(before, after).join(), /ethernet/);
});
