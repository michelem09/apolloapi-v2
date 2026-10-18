// Offline tier: the parsers that turn what the device prints into facts.
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../journeys/probes');

test('pool.status: one JSON object per line, rates with ckpool suffixes', () => {
  const s = p.parsePoolStatus([
    '{"runtime":61,"lastupdate":1,"Users":1,"Workers":1,"Idle":0}',
    '{"hashrate1m":"5.31T","hashrate5m":"812G","hashrate15m":"0"}',
    '{"diff":1.2,"accepted":42,"rejected":1,"bestshare":9}',
  ].join('\n'));
  assert.equal(s.hashrate1m, 5.31e12);
  assert.equal(s.hashrate5m, 812e9);
  assert.equal(s.accepted, 42);
  assert.equal(s.rejected, 1);
  assert.equal(s.workers, 1);
});

test('pool.status: a half-written line and an empty file do not throw', () => {
  assert.equal(p.parsePoolStatus('{"runtime":1}\n{"hashrate1m":"5').runtime, 1);
  assert.equal(p.parsePoolStatus('').empty, true);
  assert.equal(p.parsePoolStatus('').hashrate1m, 0);
});

test('bitcoind version: family and version, and 28.1 is not 28.10', () => {
  const core = p.parseBitcoindVersion('Bitcoin Core version v28.1.0\nCopyright');
  const knots = p.parseBitcoindVersion('Bitcoin Knots version v29.3.knots20260101');
  assert.deepEqual(core, { family: 'core', version: '28.1.0' });
  assert.deepEqual(knots, { family: 'knots', version: '29.3' });
  assert.ok(p.bitcoindIs(core, 'core', '28.1'));
  assert.ok(!p.bitcoindIs(core, 'knots', '28.1'));
  assert.ok(!p.bitcoindIs(p.parseBitcoindVersion('Bitcoin Core version v28.10.0'), 'core', '28.1'));
  assert.ok(p.bitcoindIs(knots, 'knots', '29.3'));
  assert.equal(p.parseBitcoindVersion('bash: not found'), null);
  assert.ok(!p.bitcoindIs(null, 'core', '28.1'));
});

test('miner args: host, port and user only; the pool password is never read', () => {
  const a = p.parseMinerArgs('-host stratum.braiins.com -port 3333 -user michelem09.apollo2-test -pswd hunter2 -pwrled off');
  assert.deepEqual(a, { host: 'stratum.braiins.com', port: '3333', user: 'michelem09.apollo2-test' });
  assert.ok(!JSON.stringify(a).includes('hunter2'));
  assert.deepEqual(p.parseMinerArgs(''), { host: null, port: null, user: null });
});

test('nmcli terse output: escaped colons, wifi vs ethernet', () => {
  const active = p.parseNmcliActive('Wired connection 1:uuid-1:802-3-ethernet:eth0\nMy\\:Net:uuid-2:802-11-wireless:wlan0');
  assert.equal(active[1].name, 'My:Net');
  assert.ok(p.isEthernet(active[0]) && !p.isWifi(active[0]));
  assert.ok(p.isWifi(active[1]) && !p.isEthernet(active[1]));
  const devs = p.parseNmcliDevices('eth0:ethernet:connected:Wired connection 1\nwlan0:wifi:disconnected:');
  assert.equal(devs[1].state, 'disconnected');
  assert.ok(p.isWifi(devs[1]));
});

test('routes: the device a route leaves by', () => {
  assert.equal(p.deviceOfRoute('192.168.86.5 dev eth0 src 192.168.86.66 uid 1000'), 'eth0');
  assert.deepEqual(p.devicesOfDefaultRoutes('default via 192.168.86.1 dev eth0 proto dhcp\ndefault via 192.168.86.1 dev wlan0 metric 600'), ['eth0', 'wlan0']);
  assert.deepEqual(p.devicesOfDefaultRoutes(''), []);
});

test('systemd time and show output', () => {
  assert.equal(p.parseSystemdTime('Sun 2026-10-18 10:00:00 UTC'), Date.parse('2026-10-18T10:00:00Z'));
  assert.ok(Number.isNaN(p.parseSystemdTime('n/a')));
  assert.deepEqual(p.parseShow('ActiveState=active\nSubState=running'), { ActiveState: 'active', SubState: 'running' });
});

test('hashrate suffixes', () => {
  assert.equal(p.hashrateToNumber('1.5G'), 1.5e9);
  assert.equal(p.hashrateToNumber('7'), 7);
  assert.equal(p.hashrateToNumber('junk'), 0);
});

test('probes ask the device with the commands they claim to', async () => {
  const seen = [];
  const ssh = async (cmd, opts) => { seen.push([cmd, opts]); return 'MATCH'; };
  assert.equal(await p.linuxPasswordMatches(ssh, 's3cret'), true);
  // The password is on stdin, never in the command line.
  assert.ok(!seen[0][0].includes('s3cret'));
  assert.equal(seen[0][1].input, 's3cret\n');
  assert.equal(await p.torEnabled(async () => 'listen=1\nonlynet=onion\n'), true);
  assert.equal(await p.torEnabled(async () => 'listen=1\n# onlynet=onion\n'), false);
});

test('the stat files asked for are the ones the miner writes, not every apollo-miner* in the directory', async () => {
  const cmd = p.statFilesCommand();
  assert.match(cmd, /apollo-miner\.\*/);
  assert.match(cmd, /apollo-miner-v\*\.\*/);
  assert.match(cmd, /apollo-miner-3\.json/);
  assert.ok(!/apollo-miner\*/.test(cmd), 'a bare apollo-miner* would read the helper binaries');
  const seen = [];
  const r = await p.statFileMentions(async (c) => { seen.push(c); return '{"pool":"michelem09.x-test"}'; }, ['michelem09.x-test', 'nope']);
  assert.deepEqual(r, { 'michelem09.x-test': true, nope: false });
  assert.equal(seen[0], cmd);
});

test('journal analysis: a stop is only good if the script printed its closing line after it', () => {
  const ok = 'Stopping apollo-miner.\nKilling session: miner\nStopped\nStopped apollo-miner.';
  assert.deepEqual(p.analyseStops(ok), { stops: 1, scripts: 1, lastSkipped: false });
  const skipped = 'Starting apollo-miner.\nStopping apollo-miner.\nStopped apollo-miner.';
  assert.deepEqual(p.analyseStops(skipped), { stops: 1, scripts: 0, lastSkipped: true });
  // an earlier good stop does not excuse the last one skipping it
  assert.equal(p.analyseStops(ok + '\nStarted apollo-miner.\n' + skipped).lastSkipped, true);
  // the script of an earlier stop does not count for a later one
  assert.equal(p.analyseStops('Stopped\nStopping apollo-miner.').lastSkipped, true);
  assert.deepEqual(p.analyseStops(''), { stops: 0, scripts: 0, lastSkipped: false });
  assert.equal(p.analyseStops('apollo-miner.service: Deactivated successfully.').lastSkipped, true);
});
