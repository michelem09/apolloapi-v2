// Helpers several journeys need. They take the journey harness `j` (fixtures.js).

const NODE_NET = `{ Node { stats { result { stats {
  blockchainInfo { blocks } networkInfo { subversion localaddresses { address port } }
} } error { message } } } }`;
const SETTINGS_NOW = `{ Settings { list { result { settings {
  id nodeSoftware nodeEnableTor temperatureUnit nodeEnableSoloMining
} } error { message } } } }`;
const SETTINGS_UPDATE = `mutation($input: SettingsUpdateInput!) {
  Settings { update(input: $input) { error { message } } }
}`;
const POOLS = `{ Pool { list { result { pools { id url username enabled index } } error { message } } } }`;

const nodeNetwork = async (j) => {
  const stats = (await j.gql(NODE_NET)).Node.stats.result?.stats;
  return {
    blocks: stats?.blockchainInfo?.blocks ?? 0,
    subversion: stats?.networkInfo?.subversion ?? null,
    addresses: (stats?.networkInfo?.localaddresses ?? []).map((a) => a.address),
  };
};

// Running is not answering: bitcoind that is loading its block index runs and
// replies to nothing, and the UI reads the node over RPC.
const waitNodeAnswering = async (j, timeoutMs = 300000) => {
  const r = await j.waitUntil(async () => {
    try { return (await nodeNetwork(j)).blocks > 0; } catch (err) {
      if (err.malformed) throw err;
      return false;
    }
  }, { timeoutMs, everyMs: 10000 });
  j.must(r.ok, `the node did not answer RPC within ${timeoutMs / 1000} s`);
  return r.waitedMs;
};

// In a local run there is no device; the callers' preconditions then pass and
// their device checks are recorded as skipped.
const unit = async (j, name) => (j.local ? 'active' : j.probes.unitState(j.ssh, name));

const waitUnit = async (j, name, want, timeoutMs) => {
  const r = await j.waitUntil(async () => ((await unit(j, name)) === 'active') === want, { timeoutMs, everyMs: 4000 });
  j.must(r.ok, `${name} did not become ${want ? 'active' : 'inactive'} within ${timeoutMs / 1000} s`);
  return r.waitedMs;
};

const currentSettings = async (j) => {
  const all = (await j.gql(SETTINGS_NOW)).Settings.list.result?.settings ?? [];
  return [...all].sort((a, b) => b.id - a.id)[0] ?? null;
};

const updateSettings = async (j, input) => {
  const out = await j.gqlWrite(SETTINGS_UPDATE, { input });
  const err = out.Settings.update.error?.message;
  if (err) throw new Error(`Settings.update: ${err}`);
};

// Stop and start the node through the API, the way the UI does after a change.
const restartNode = async (j) => {
  await j.gqlWrite('mutation { Node { stop { error { message } } } }');
  await waitUnit(j, 'node', false, 600000); // TimeoutStopSec=600 in the unit
  await j.gqlWrite('mutation { Node { start { error { message } } } }');
  await waitUnit(j, 'node', true, 240000);
};

const poolList = async (j) => (await j.gql(POOLS)).Pool.list.result?.pools ?? [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = {
  nodeNetwork,
  waitNodeAnswering,
  unit,
  waitUnit,
  currentSettings,
  updateSettings,
  restartNode,
  poolList,
  sleep,
};
