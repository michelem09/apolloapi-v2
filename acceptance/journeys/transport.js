// The way to the device's API, which must outlive the thing carrying it.
//
// A round once lost its ssh tunnel half-way and from then on every API call said
// "fetch failed": the journeys, the restore's wait for the API, Miner.stop, the
// password — the end of the round that exists to leave the device safe. So API
// calls go through here: before each call the tunnel is checked (and reopened with
// backoff if it died); a call that fails at the network level is retried once on
// the other path (the API also listens on the LAN, so `directBase` needs no
// tunnel); and a failure that survives both is tagged `transport`, so a caller can
// say "the API was unreachable" instead of "the node did not answer".

const isTransportError = (err) => {
  const text = `${err?.message || ''} ${err?.cause?.message || ''} ${err?.cause?.code || ''} ${err?.code || ''}`;
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|EPIPE|socket hang up|UND_ERR/i.test(text);
};

const createTransport = ({
  profile,
  directBase,
  tunnel = null,
  openTunnel = null,
  record = () => {},
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  backoffMs = [1000, 2000, 4000],
}) => {
  const state = { tunnel, via: tunnel ? 'tunnel' : profile.apiBase === directBase ? 'direct' : 'base' };
  const firstBase = profile.apiBase;
  const tunnelBase = () => (state.tunnel ? `http://127.0.0.1:${state.tunnel.port}` : firstBase);
  const events = [];
  const note = (what, detail = '') => {
    const e = { at: new Date().toISOString(), what, detail };
    events.push(e);
    record(e);
  };

  const useDirect = () => {
    profile.apiBase = directBase;
    state.via = 'direct';
  };

  // The tunnel is dead: open another, with backoff, else carry on over the LAN.
  const revive = async () => {
    const t = state.tunnel;
    note('ssh tunnel to the API died', `${JSON.stringify(t?.exit?.() ?? null)} ${t?.stderr?.() || ''}`.trim());
    for (const wait of backoffMs) {
      await sleep(wait);
      try {
        state.tunnel = await openTunnel();
        profile.apiBase = `http://127.0.0.1:${state.tunnel.port}`;
        state.via = 'tunnel';
        note('ssh tunnel reopened', `127.0.0.1:${state.tunnel.port}`);
        return;
      } catch (err) {
        note('reopening the tunnel failed', err.message);
      }
    }
    useDirect();
    note('falling back to the API on the LAN', directBase);
  };

  const ensure = async () => {
    if (state.via === 'tunnel' && state.tunnel && !state.tunnel.alive()) await revive();
  };

  const call = async (fn) => {
    await ensure();
    try {
      return await fn();
    } catch (err) {
      if (!isTransportError(err)) throw err; // a GraphQL or business error is not about the path
      note('API call failed at the network level', err.message);
      const was = profile.apiBase;
      // The path in use is suspect: try the other one for this call.
      const other = state.via === 'direct' ? tunnelBase() : directBase;
      if (!other || other === was) {
        err.transport = true;
        throw err;
      }
      profile.apiBase = other;
      try {
        const out = await fn();
        state.via = other === directBase ? 'direct' : 'tunnel';
        note(`switched to ${state.via}`, other);
        return out;
      } catch (err2) {
        profile.apiBase = was;
        if (isTransportError(err2)) err2.transport = true;
        throw err2;
      }
    }
  };

  return { call, events, state, close: () => state.tunnel?.close?.() };
};

// gql / gqlWrite of lib/api.js, routed through a transport.
const through = (transport, api, profile, token) => ({
  gql: (doc, vars) => transport.call(() => api.gql(profile, token, doc, vars)),
  gqlWrite: (doc, vars) => transport.call(() => api.gqlWrite(profile, token, doc, vars)),
});

module.exports = { createTransport, through, isTransportError };
