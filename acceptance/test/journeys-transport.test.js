// Offline tier: the way to the API surviving the death of the ssh tunnel, and the
// end of a round not depending on it.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createTransport, through, isTransportError } = require('../journeys/transport');
const { runRound } = require('../journeys/round');
const { buildDeps } = require('../journeys/deps');
const report = require('../journeys/report');
const C = require('../journeys/common');

const TUNNEL = 'http://127.0.0.1:50000';
const DIRECT = 'http://10.0.0.5:5000';
const refused = () => Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 127.0.0.1:50000' } });

// A tunnel whose liveness the test controls.
const fakeTunnel = (port = 50000) => {
  const t = { port, dead: false, closed: false };
  t.alive = () => !t.dead;
  t.stderr = () => 'Connection to 10.0.0.5 closed by remote host';
  t.exit = () => ({ code: 255, at: 'now' });
  t.close = () => { t.closed = true; };
  return t;
};

// An API reachable only on the bases in `up`.
const fakeApi = (up) => ({
  gql: async (profile, _t, doc) => {
    if (!up.has(profile.apiBase)) throw refused();
    if (/bad/.test(doc)) throw new Error('GraphQL: nope');
    return { base: profile.apiBase };
  },
  gqlWrite: async (profile, _t, doc) => {
    if (!up.has(profile.apiBase)) throw refused();
    return { base: profile.apiBase };
  },
});

const make = ({ up, reopen = null, tunnel = fakeTunnel() } = {}) => {
  const profile = { apiBase: TUNNEL };
  const opened = [];
  const t = createTransport({
    profile, directBase: DIRECT, tunnel,
    openTunnel: async () => { opened.push(1); if (!reopen) throw new Error('ssh: connect refused'); return reopen(); },
    sleep: async () => {},
  });
  return { profile, t, tunnel, opened, api: through(t, fakeApi(up), profile, 'tok') };
};

test('what counts as a network failure, and what does not', () => {
  assert.ok(isTransportError(refused()));
  assert.ok(isTransportError(new Error('read ECONNRESET')));
  assert.ok(!isTransportError(new Error('GraphQL: Cannot query field')));
  assert.ok(!isTransportError(new Error('the node did not answer')));
});

test('a dead tunnel is reopened before the next call, with the reason in the events', async () => {
  const m = make({ up: new Set(['http://127.0.0.1:50001']), reopen: async () => fakeTunnel(50001) });
  m.tunnel.dead = true;
  const out = await m.api.gql('{ x }');
  assert.equal(out.base, 'http://127.0.0.1:50001');
  assert.deepEqual(m.t.events.map((e) => e.what), ['ssh tunnel to the API died', 'ssh tunnel reopened']);
  assert.match(m.t.events[0].detail, /closed by remote host/);
});

test('when the tunnel cannot be reopened the call goes over the LAN', async () => {
  const m = make({ up: new Set([DIRECT]) });
  m.tunnel.dead = true;
  const out = await m.api.gql('{ x }');
  assert.equal(out.base, DIRECT);
  assert.equal(m.opened.length, 3, 'three attempts with backoff');
  assert.ok(m.t.events.some((e) => /falling back to the API on the LAN/.test(e.what)));
});

test('a tunnel that looks alive but forwards nothing: the call is retried on the LAN and stays there', async () => {
  const m = make({ up: new Set([DIRECT]) });
  assert.equal((await m.api.gql('{ x }')).base, DIRECT);
  assert.equal((await m.api.gql('{ x }')).base, DIRECT);
  assert.ok(m.t.events.some((e) => /switched to direct/.test(e.what)));
});

test('both paths down: the error is tagged transport, so it is not read as a node problem', async () => {
  const m = make({ up: new Set() });
  await assert.rejects(() => m.api.gql('{ x }'), (e) => e.transport === true);
});

test('a GraphQL error is not about the path and does not switch it', async () => {
  const m = make({ up: new Set([TUNNEL, DIRECT]) });
  await assert.rejects(() => m.api.gql('bad'), /GraphQL: nope/);
  assert.equal(m.profile.apiBase, TUNNEL);
  assert.deepEqual(m.t.events, []);
});

test('a probe that cannot reach the API says so instead of blaming the node', async () => {
  const j = {
    gql: async () => { throw Object.assign(new Error('fetch failed'), { transport: true }); },
    waitUntil: async (probe) => { await probe(); return { ok: false, waitedMs: 0 }; },
    must: (c, m) => { if (!c) throw new Error(m); },
  };
  await assert.rejects(() => C.waitNodeAnswering(j, 1000), /API was unreachable.*not evidence about the node/);
  const j2 = { ...j, gql: async () => ({ Node: { stats: { result: { stats: { blockchainInfo: { blocks: 0 } } } } } }) };
  await assert.rejects(() => C.waitNodeAnswering(j2, 1000), /did not answer RPC/);
});

// ---- the end of a round with no tunnel

// A device that holds a miner state and two passwords, and an API on the LAN only.
const world = ({ apiStopWorks = true, lanUp = true } = {}) => {
  const w = { miner: 'active', dbPw: 'temp', linuxPw: 'temp', journal: [], cmds: [], tunnelDead: false };
  const profile = { apiBase: TUNNEL };
  const tunnel = fakeTunnel();
  const api = {
    gql: async (p, _t, doc, vars) => {
      if (p.apiBase === TUNNEL && w.tunnelDead) throw refused();
      if (p.apiBase === DIRECT && !lanUp) throw refused();
      if (/Auth \{\s*login/.test(doc)) {
        return { Auth: { login: { result: vars.input.password === w.dbPw ? { accessToken: 'x' } : null } } };
      }
      return { Pool: { list: { result: { pools: [] } } }, Settings: { list: { result: { settings: [] } } }, __typename: 'Query' };
    },
    gqlWrite: async (p, _t, doc, vars) => {
      if (p.apiBase === TUNNEL && w.tunnelDead) throw refused();
      if (p.apiBase === DIRECT && !lanUp) throw refused();
      if (/changePassword/.test(doc)) { w.dbPw = vars.input.password; w.linuxPw = vars.input.password; return { Auth: { changePassword: { error: null } } }; }
      if (/Miner \{ stop/.test(doc)) {
        if (!apiStopWorks) return { Miner: { stop: { error: { message: 'boom' } } } };
        w.stop();
        return { Miner: { stop: { error: null } } };
      }
      return {};
    },
  };
  w.stop = () => { w.journal.push('Stopping apollo-miner.', 'Stopped', 'Stopped apollo-miner.'); w.miner = 'inactive'; };
  w.ssh = async (cmd) => {
    w.cmds.push(cmd);
    if (/systemctl show apollo-miner -p ActiveState/.test(cmd)) return w.miner;
    if (/systemctl show \S+ -p ActiveState/.test(cmd)) return 'inactive';
    if (/sudo systemctl stop apollo-miner/.test(cmd)) { w.stop(); return ''; }
    if (/journalctl/.test(cmd)) return w.journal.join('\n');
    if (/date \+%s/.test(cmd)) return '1000';
    if (/python3/.test(cmd)) return w.linuxPw === 'orig' ? 'MATCH' : 'NO';
    if (/timedatectl/.test(cmd)) return 'UTC';
    return '';
  };
  const transport = createTransport({ profile, directBase: DIRECT, tunnel, openTunnel: async () => { throw new Error('refused'); }, sleep: async () => {} });
  const io = {
    ssh: w.ssh,
    ...through(transport, api, profile, 'tok'),
    waitUntil: async (probe) => ((await probe()) ? { ok: true, waitedMs: 0 } : { ok: false, waitedMs: 0 }),
    base: { takeSnapshot: async () => ({}), restoreSnapshot: async () => [] },
  };
  return { w, io, transport, tunnel };
};

const roundWith = async ({ apiStopWorks, lanUp } = {}) => {
  const { w, io, transport, tunnel } = world({ apiStopWorks, lanUp });
  const deps = buildDeps({ profile: {}, io, out: '/nonexistent', ctxFile: '', uiBase: '', original: 'orig', state: {} });
  // The journey changes the password to a temporary one, then the tunnel dies, and it fails.
  deps.runJourney = async (j) => { w.tunnelDead = true; tunnel.dead = true; return { id: j.id, name: j.name, ok: false, error: 'the node did not answer RPC' }; };
  deps.password = (orig => () => orig())(deps.password);
  const r = await runRound({ journeys: [{ id: '08-password', name: 'password' }], deps });
  r.transport = transport.events;
  return { r, w };
};

test('the tunnel dies mid-round: the round still ends with the miner off and the original password working', async () => {
  const { r, w } = await roundWith();
  assert.equal(w.miner, 'inactive');
  assert.equal(w.dbPw, 'orig');
  assert.equal(w.linuxPw, 'orig');
  assert.equal(r.miner.off, true);
  assert.equal(r.miner.scriptRan, true);
  assert.equal(r.password.ok, true);
  assert.ok(r.transport.some((e) => /LAN/.test(e.what)), 'the death is in the report');
  assert.deepEqual(r.errors, []);
});

test('the API unreachable on both paths: the miner is still stopped, through systemd, and the report says what is left', async () => {
  const { r, w } = await roundWith({ lanUp: false });
  assert.equal(w.miner, 'inactive', 'stopped over ssh');
  assert.ok(w.cmds.some((c) => /sudo systemctl stop apollo-miner/.test(c)));
  assert.equal(r.miner.off, true);
  assert.match(r.miner.notes.join(), /stopped with systemctl instead/);
  assert.equal(r.password.ok, false, 'the password could not be put back with no API');
  const todo = report.leftToDo(r, { host: 'futurebit@10.0.0.5' });
  assert.ok(todo.some((t) => /original password is NOT confirmed/.test(t)), todo.join('\n'));
  assert.ok(!todo.some((t) => /miner may be running/.test(t)));
  const md = report.toMarkdown({ ...r, drift: r.drift || [] }, { host: 'futurebit@10.0.0.5' });
  assert.match(md.trim().split('\n').at(-1), /^LEFT TO DO BY HAND: .*original password/);
});

test('the API refusing the stop falls back to systemd as well', async () => {
  const { r, w } = await roundWith({ apiStopWorks: false });
  assert.equal(w.miner, 'inactive');
  assert.match(r.miner.notes.join(), /stopped with systemctl instead/);
});

test('left to do: nothing on a clean round, and the miner when it was not confirmed off', () => {
  const clean = { miner: { off: true, scriptRan: true }, password: { loginOk: true, linuxOk: true }, drift: [], restore: { errors: [] }, final: {} };
  assert.deepEqual(report.leftToDo(clean, { host: 'h' }), []);
  assert.match(report.toMarkdown({ ...clean, journeys: [], errors: [] }, {}).trim().split('\n').at(-1), /LEFT TO DO BY HAND: nothing$/);
  const bad = { ...clean, miner: { off: false } };
  assert.match(report.leftToDo(bad, { host: 'h' })[0], /miner may be running/);
  assert.deepEqual(report.leftToDo(bad, { local: true }), []);
});
