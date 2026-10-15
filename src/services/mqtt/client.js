/**
 * A single MQTT connection to the user's broker (their Home Assistant broker),
 * shared by the whole automation. It reads and writes:
 *   - reads: subscribes to the topics the user mapped and caches the latest value
 *     per input, so the `input.<name>` signals can react to them (e.g. the solar
 *     surplus published by the SUN2000→MQTT bridge);
 *   - writes: publishes the device's own state and (optionally) exposes command
 *     topics, so Home Assistant can watch and control the miner. The output side
 *     lives in ./output; here we only own the connection, publish() and command
 *     routing.
 *
 * Singleton module state: there is one broker connection for the process.
 */
const mqtt = require('mqtt');
const log = require('../../logger')('mqtt');

let client = null;
let brokerSig = null; // broker identity — reconnect only when it changes
let status = { connected: false, error: null };
let inputs = []; // [{ name, topic, jsonPath, unit }]
const cache = new Map(); // name -> { value, at }
// Input topics currently subscribed on the live client. Editing the mappings
// diffs against this instead of reconnecting, so the browse cache, the HA entities
// and the retained last-will are not disturbed by an input edit.
let subscribedInputs = new Set();
let firstConnect = true; // per client: later connects are resubscribed by mqtt.js itself

// Topic browse cache. It is filled only while a browse session is open (see
// startBrowse), from a `#` subscription, and then kept in memory so the modal
// opens on data. Payloads stay in memory and are never logged: a broker carries
// credentials and personal data. Bounded by count AND real bytes.
const TOPIC_MAX_LEN = 512;
const PAYLOAD_MAX = 4000; // bytes kept per ordinary topic
const HA_CONFIG_MAX = 16000; // bytes kept per HA sensor config (the shared `device` object makes them long)

// A Map whose insertion order is the LRU order, bounded by entries and bytes.
class BoundedLru {
  constructor(maxEntries, maxBytes) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.map = new Map();
    this.bytes = 0;
  }

  get size() {
    return this.map.size;
  }

  get(k) {
    return this.map.get(k);
  }

  delete(k) {
    const e = this.map.get(k);
    if (e) {
      this.bytes -= e.bytes;
      this.map.delete(k);
    }
    return e;
  }

  set(k, e) {
    this.delete(k);
    this.map.set(k, e);
    this.bytes += e.bytes;
    while (this.map.size > this.maxEntries || (this.bytes > this.maxBytes && this.map.size > 1)) {
      this.delete(this.map.keys().next().value);
    }
  }

  clear() {
    this.map.clear();
    this.bytes = 0;
  }
}

const TOPIC_CACHE_MAX = 500;
// Ordinary topics: 500 x 4000 B. Never lets a chatty state topic push out the
// HA sensors below.
const topicCache = new BoundedLru(TOPIC_CACHE_MAX, 4 * 1024 * 1024);
// HA sensor configs (retained, published once) and the state topics they point at.
const haCache = new BoundedLru(1000, 8 * 1024 * 1024);
const haStateTopics = new Set(); // state topics named by a cached HA sensor config
let brokerKey = null; // identity of the broker the shared client points at

// The browse session. `#` is subscribed only while one is active: it ends when
// the modal closes, or after BROWSE_TTL_MS without a renew (the modal polls).
const BROWSE_TTL_MS = 5 * 60 * 1000;
const browse = { active: false, subscribed: false, timer: null, refused: null, warned: false };

// The output side registers itself here (set once at boot, before the first
// connect): { will, commandTopics, onCommand, onConnect }. Kept out of the
// connection signature so toggling output on/off never drops the input link.
let output = null;

const getByPath = (obj, path) =>
  String(path)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);

// A message payload → a number, via an optional JSON path (else the raw payload).
function extractValue(input, payloadStr) {
  // A blank payload is the standard "clear a retained topic" idiom (output.js
  // does it too). Number('') is 0, which is finite, so without this guard an
  // empty message would be cached as a real 0 reading and could fire a rule.
  if (payloadStr == null || String(payloadStr).trim() === '') return NaN;
  if (input.jsonPath) {
    try {
      return Number(getByPath(JSON.parse(payloadStr), input.jsonPath));
    } catch (e) {
      return NaN;
    }
  }
  return Number(payloadStr);
}

const isOwnTopic = (topic) => !!(output && output.ownPrefix && topic.startsWith(`${output.ownPrefix}/`));
const isHaSensorConfig = (topic) => /^homeassistant\/sensor\/.+\/config$/.test(topic);

// Decode at most `max` bytes. Slicing the Buffer first matters: slicing the decoded
// string would keep the whole payload alive in V8, and a 200 KB camera snapshot
// per topic would defeat the bound.
const decode = (payload, max) => (Buffer.isBuffer(payload) ? payload.toString('utf8', 0, max) : String(payload).slice(0, max));

// Remember a topic for the browse cache. The device's own apollo/<id>/ topics are
// left out (they are what we publish, not something to map), and so are HA
// discovery definitions other than sensors (hidden from the browse anyway).
function remember(topic, payload, at = Date.now(), wasTruncated = false) {
  if (topic.length > TOPIC_MAX_LEN || isOwnTopic(topic)) return;
  const isSensorConfig = isHaSensorConfig(topic);
  if (/^homeassistant\/.+\/config$/.test(topic) && !isSensorConfig) return;

  if (isSensorConfig) {
    const str = decode(payload, HA_CONFIG_MAX);
    const truncated = wasTruncated || payload.length > HA_CONFIG_MAX;
    haCache.set(topic, { payload: str, at, bytes: str.length + topic.length, truncated });
    const ha = resolveHaSensorConfig(topic, str);
    if (ha && ha.topic && !haStateTopics.has(ha.topic) && haStateTopics.size < haCache.maxEntries) {
      haStateTopics.add(ha.topic);
      // The state may have been cached as an ordinary topic before its config arrived.
      const early = topicCache.delete(ha.topic);
      if (early) haCache.set(ha.topic, early);
    }
    return;
  }

  const str = decode(payload, PAYLOAD_MAX);
  const entry = { payload: str, at, bytes: str.length + topic.length };
  // A state topic that an HA sensor points at lives with the HA configs, so
  // chatter on other topics cannot turn its entity into "no value yet".
  (haStateTopics.has(topic) ? haCache : topicCache).set(topic, entry);
}

function onMessage(topic, payload) {
  remember(topic, payload);

  // A command topic (miner/mode set from Home Assistant) — route it and stop; a
  // command topic is never also an input topic. No de-duplication: every command
  // is delivered, because start/stop/start are three real commands.
  if (output && output.commandTopics && output.commandTopics.includes(topic)) {
    if (output.onCommand) Promise.resolve(output.onCommand(topic, payload.toString())).catch(() => {});
    return;
  }

  let str = null; // decoded in full only for a topic a rule actually reads
  for (const input of inputs) {
    if (input.topic !== topic) continue;
    if (str === null) str = payload.toString();
    const value = extractValue(input, str);
    if (Number.isFinite(value)) cache.set(input.name, { value, at: Date.now() });
  }
}

const commandTopics = () => (output && output.commandTopics) || [];
const inputTopics = () => [...new Set(inputs.map((i) => i.topic))];

// Bring the live subscriptions in line with the current mappings.
function syncInputSubscriptions() {
  if (!client || !status.connected) return;
  const want = new Set(inputTopics());
  const keep = new Set(commandTopics());
  const add = [...want].filter((t) => !subscribedInputs.has(t));
  const drop = [...subscribedInputs].filter((t) => !want.has(t) && !keep.has(t));
  if (add.length) client.subscribe(add, () => {});
  if (drop.length) client.unsubscribe(drop, () => {});
  subscribedInputs = want;
}

function dropBrowseTimer() {
  if (browse.timer) clearTimeout(browse.timer);
  browse.timer = null;
}

function disconnect() {
  if (client) {
    const c = client;
    client = null;
    // Graceful end sends a DISCONNECT so the broker drops the retained last-will.
    // end(true) destroys the socket, which the broker reads as an abnormal close
    // and answers by publishing 'offline' — greying out every Home Assistant
    // entity on every routine reconfigure. Force the close only if the graceful
    // end stalls.
    const force = setTimeout(() => {
      try {
        c.end(true);
      } catch (e) {
        /* ignore */
      }
    }, 2000);
    if (force.unref) force.unref();
    // Nothing the old client still has in flight may reach the new state.
    try {
      c.removeAllListeners('message');
      c.removeAllListeners('connect');
      c.removeAllListeners('close');
      c.on('error', () => {});
    } catch (e) {
      /* ignore */
    }
    try {
      c.end(false, {}, () => clearTimeout(force));
    } catch (e) {
      clearTimeout(force);
      try {
        c.end(true);
      } catch (e2) {
        /* ignore */
      }
    }
  }
  status = { connected: false, error: null };
  subscribedInputs = new Set();
  firstConnect = true;
  topicCache.clear();
  haCache.clear();
  haStateTopics.clear();
  dropBrowseTimer();
  browse.active = false;
  browse.subscribed = false;
  browse.refused = null;
  browse.warned = false;
}

/**
 * Point the client at the current MQTT config. Reconnects only when the broker
 * (host, port, user, password, TLS) changed; adding or removing an input subscribes
 * or unsubscribes on the live link, and a jsonPath/unit-only edit just refreshes
 * the mapping.
 */
function configure(mqttConfig) {
  const cfg = mqttConfig || {};
  const enabled = !!(cfg.enabled && cfg.host);
  const nextInputs = (cfg.inputs || []).filter((i) => i && i.name && i.topic);

  const sig = JSON.stringify({
    enabled,
    host: cfg.host,
    port: cfg.port,
    username: cfg.username,
    password: cfg.password,
    tls: cfg.tls,
  });

  const prevInputs = inputs;
  inputs = nextInputs; // always refresh the mappings (jsonPath/unit)
  if (sig === brokerSig) {
    // No reconnect — but a cached reading pulled with a definition that has since
    // changed (jsonPath or topic), or whose input is gone, is wrong: drop it so a
    // stale or mis-extracted value isn't served as fresh until the source republishes.
    for (const prev of prevInputs) {
      const now = nextInputs.find((n) => n.name === prev.name);
      if (!now || now.topic !== prev.topic || (now.jsonPath || null) !== (prev.jsonPath || null)) {
        cache.delete(prev.name);
      }
    }
    syncInputSubscriptions();
    return;
  }
  brokerSig = sig;

  disconnect();
  cache.clear();
  brokerKey = enabled ? `${cfg.host}:${cfg.port || 1883}:${cfg.tls ? 1 : 0}:${cfg.username || ''}` : null;
  if (!enabled) return;

  const url = `${cfg.tls ? 'mqtts' : 'mqtt'}://${cfg.host}:${cfg.port || 1883}`;
  const c = mqtt.connect(url, {
    username: cfg.username || undefined,
    password: cfg.password || undefined,
    reconnectPeriod: 5000,
    connectTimeout: 8000,
    // Last-will: if the link drops, the broker marks the device unavailable so
    // Home Assistant greys the entities out instead of showing stale values.
    ...(output && output.will
      ? { will: { topic: output.will.topic, payload: output.will.payload, qos: 1, retain: true } }
      : {}),
  });
  client = c;

  // Every handler ignores a client that is no longer the current one.
  c.on('connect', () => {
    if (c !== client) return;
    status = { connected: true, error: null };
    if (firstConnect) {
      firstConnect = false;
      // Once per client: on a reconnect mqtt.js resubscribes what it knows, and
      // subscribing again would make the broker replay every retained topic twice.
      const want = new Set(inputTopics());
      const subs = [...want, ...commandTopics()];
      if (subs.length) c.subscribe(subs, () => {});
      subscribedInputs = want;
      ensureBrowseSubscription();
    } else {
      syncInputSubscriptions();
    }
    // Let the output side (re)publish its discovery + availability + first state.
    if (output && output.onConnect) Promise.resolve(output.onConnect()).catch(() => {});
  });
  c.on('message', (topic, payload) => {
    if (c === client) onMessage(topic, payload);
  });
  c.on('error', (e) => {
    if (c === client) status = { connected: false, error: e.message };
  });
  c.on('close', () => {
    if (c === client) status = { connected: false, error: status.error };
  });
}

// ---- browse session -------------------------------------------------------

// Subscribe `#` on the live client (once per session) and read the SUBACK: a
// broker whose ACL refuses it answers with 128, and some drop the client for it.
function ensureBrowseSubscription() {
  if (!browse.active || browse.subscribed || browse.refused || !client || !status.connected) return;
  const c = client;
  browse.subscribed = true;
  c.subscribe('#', (err, granted) => {
    if (c !== client) return;
    const refused = err || (granted || []).some((g) => g.qos === 128);
    if (!refused) return;
    browse.subscribed = false;
    browse.refused = 'The broker does not allow subscribing to all topics (#), so live browsing is unavailable. Use a scan, or ask for read access on #.';
    // Once per broker, and never the payloads. No retry loop: a new session retries.
    if (!browse.warned) {
      browse.warned = true;
      log.warn('MQTT broker refused the "#" subscription; live topic browsing is unavailable');
    }
  });
}

function armBrowseTimer() {
  dropBrowseTimer();
  browse.timer = setTimeout(endBrowse, BROWSE_TTL_MS);
  if (browse.timer.unref) browse.timer.unref();
}

/** Start or renew a browse session (the modal does this on open and every poll). */
function startBrowse() {
  if (!browse.active) browse.refused = null; // a new session is allowed one fresh try
  browse.active = true;
  armBrowseTimer();
  ensureBrowseSubscription();
}

/** End the session: stop the `#` firehose; the cache stays for the next open. */
function endBrowse() {
  dropBrowseTimer();
  const wasSubscribed = browse.subscribed;
  browse.active = false;
  browse.subscribed = false;
  browse.refused = null;
  if (wasSubscribed && client && status.connected) {
    try {
      client.unsubscribe('#', () => {});
    } catch (e) {
      /* ignore */
    }
  }
}

// Human-readable MQTT CONNACK refusal reasons.
const CONNACK = {
  1: 'unacceptable protocol version',
  2: 'client id rejected',
  3: 'broker unavailable',
  4: 'bad username or password',
  5: 'not authorized',
};

// One-off connection attempt with the given config — does not touch the shared
// client. Resolves { ok, error } so the UI can tell the user exactly what failed.
function testConnection(mqttConfig) {
  return new Promise((resolve) => {
    const cfg = mqttConfig || {};
    if (!cfg.host) return resolve({ ok: false, error: 'No broker host set' });

    const url = `${cfg.tls ? 'mqtts' : 'mqtt'}://${cfg.host}:${cfg.port || 1883}`;
    const probe = mqtt.connect(url, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      connectTimeout: 6000,
      reconnectPeriod: 0, // one shot
    });

    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      try {
        probe.end(true);
      } catch (e) {
        /* ignore */
      }
      resolve(result);
    };

    probe.on('connect', () => finish({ ok: true, error: null }));
    probe.on('error', (e) =>
      finish({ ok: false, error: e.code && CONNACK[e.code] ? `Rejected: ${CONNACK[e.code]}` : e.code ? `Error ${e.code}` : e.message })
    );
    setTimeout(() => finish({ ok: false, error: 'Timed out — no response from the broker' }), 7000);
  });
}

// Dot-paths to numeric-ish leaves in a JSON payload — the candidate jsonPaths a
// user would map (e.g. "battery.soc", "active_power").
function numericPaths(obj, prefix = '', out = [], depth = 0) {
  if (depth > 4 || out.length > 50) return out;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      numericPaths(v, path, out, depth + 1);
    } else if (typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)))) {
      out.push(path);
    }
  }
  return out;
}

// A Home Assistant discovery `value_template` -> the dot-path it reads, e.g.
// "{{ value_json.total_yield }}" -> "total_yield", "{{ value_json['a']['b'] }}"
// -> "a.b". Null when the template does not pull a field out of value_json.
function jsonPathFromTemplate(tpl) {
  if (!tpl || typeof tpl !== 'string') return null;
  const i = tpl.indexOf('value_json');
  if (i < 0) return null;
  let rest = tpl.slice(i + 'value_json'.length);
  const parts = [];
  const re = /^\s*(?:\.([A-Za-z0-9_]+)|\[\s*['"]([^'"]+)['"]\s*\])/;
  let m = rest.match(re);
  while (m) {
    parts.push(m[1] || m[2]);
    rest = rest.slice(m[0].length);
    m = rest.match(re);
  }
  return parts.length ? parts.join('.') : null;
}

/**
 * Resolve a Home Assistant sensor discovery config to the value it describes.
 * The `homeassistant/sensor/<x>/config` topics carry a definition, not a value:
 * the real reading lives on the `state_topic` inside, pulled out by the
 * `value_template`. Browsing showed users these config topics and they mapped the
 * wrong one; here we turn each into a ready-to-use { topic, jsonPath, name, unit }.
 */
function resolveHaSensorConfig(topic, sample) {
  if (!/^homeassistant\/sensor\/.+\/config$/.test(topic)) return null;
  let cfg;
  try {
    cfg = JSON.parse(sample);
  } catch (e) {
    return null;
  }
  if (!cfg || typeof cfg !== 'object' || !cfg.state_topic) return null;
  return {
    topic: cfg.state_topic,
    jsonPath: jsonPathFromTemplate(cfg.value_template),
    name: cfg.name || null,
    unit: cfg.unit_of_measurement || null,
    sample: null,
    jsonPaths: null,
  };
}

// The current reading behind a resolved sensor: pull the field out of the state
// topic's payload (or the raw payload when there is no jsonPath). Null when the
// state topic has published nothing yet — which itself tells the user something.
function currentValue(payload, jsonPath) {
  if (payload === undefined || payload === null) return null;
  if (!jsonPath) return String(payload).slice(0, 80);
  try {
    const v = getByPath(JSON.parse(payload), jsonPath);
    return v === undefined || v === null ? null : String(v).slice(0, 80);
  } catch (e) {
    return null;
  }
}


// Turn raw topic -> { payload, at } entries into the browse list: HA sensor
// configs resolved to named values first, then plain topics with their numeric
// jsonPaths (each with the current value). Shared by the timed scan and the cache.
function buildTopicList(entries) {
  const entities = []; // resolved HA sensors — the useful, named values
  const plain = []; // everything else
  const iso = (at) => (at ? new Date(at).toISOString() : null);

  for (const [topic, { payload: sample, at, truncated }] of [...entries.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (isOwnTopic(topic)) continue;
    const ha = resolveHaSensorConfig(topic, sample);
    if (ha) {
      // Our own discovery entities point at apollo/<id>/… — not an input source.
      if (isOwnTopic(ha.topic)) continue;
      const state = entries.get(ha.topic);
      ha.value = currentValue(state && state.payload, ha.jsonPath);
      ha.lastSeen = iso(state ? state.at : at);
      entities.push(ha);
      continue;
    }
    // Hide the rest of the Home Assistant discovery metadata (binary_sensor,
    // switch, select, … /config): it is definitions, not states/values.
    // A config too long to keep whole cannot be resolved: list it as it is rather
    // than hiding it without a word.
    if (/^homeassistant\/.+\/config$/.test(topic) && !truncated) continue;

    let jsonPaths = [];
    let parsed = null;
    try {
      parsed = JSON.parse(sample);
      if (parsed && typeof parsed === 'object') jsonPaths = numericPaths(parsed);
    } catch (e) {
      /* not JSON */
    }
    plain.push({
      topic,
      sample: sample.slice(0, 300),
      jsonPaths,
      pathValues: jsonPaths.map((path) => ({ path, value: String(getByPath(parsed, path)).slice(0, 80) })),
      value: jsonPaths.length ? null : sample.slice(0, 80),
      lastSeen: iso(at),
    });
  }

  entities.sort((a, b) => (a.name || a.jsonPath || '').localeCompare(b.name || b.jsonPath || ''));
  return [...entities, ...plain];
}

// What the shared connection has seen so far, in the same shape as a scan. Needs
// no new broker connection: it is read from memory. `lease` starts or renews the
// browse session, so the cache keeps filling while the modal is open.
function getCachedTopics({ lease = true } = {}) {
  if (!client || !status.connected) {
    return { ok: false, error: 'Not connected to the MQTT broker', topics: [] };
  }
  if (lease) startBrowse();
  const all = new Map([...topicCache.map, ...haCache.map]);
  return { ok: true, error: browse.refused, topics: buildTopicList(all) };
}

/**
 * Browse the broker: subscribe to a wildcard for a few seconds and collect the
 * topics that publish (retained ones arrive immediately). One-off connection,
 * separate from the shared client.
 */
function discoverTopics(mqttConfig, { prefix, seconds } = {}) {
  return new Promise((resolve) => {
    const cfg = mqttConfig || {};
    if (!cfg.host) return resolve({ ok: false, error: 'No broker host set', topics: [] });

    // Up to 60s: non-retained topics (e.g. a SUN2000 bridge that publishes every
    // ~40s) need a window near their interval for a value to be caught at all.
    const window = Math.min(Math.max(seconds || 4, 1), 60);
    const filter = prefix ? `${String(prefix).replace(/[/#\s]+$/, '')}/#` : '#';
    const url = `${cfg.tls ? 'mqtts' : 'mqtt'}://${cfg.host}:${cfg.port || 1883}`;
    const probe = mqtt.connect(url, {
      username: cfg.username || undefined,
      password: cfg.password || undefined,
      connectTimeout: 6000,
      reconnectPeriod: 0,
    });

    const found = new Map(); // topic -> { payload, at } (bounded; truncated only for display)
    const stateSubs = new Set(); // state topics we subscribed to for current values
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try {
        probe.end(true);
      } catch (e) {
        /* ignore */
      }
      resolve(result);
    };

    probe.on('error', (e) =>
      finish({ ok: false, error: e.code && CONNACK[e.code] ? `Rejected: ${CONNACK[e.code]}` : e.code ? `Error ${e.code}` : e.message, topics: [] })
    );
    probe.on('connect', () => {
      probe.subscribe(filter, (err) => {
        if (err) finish({ ok: false, error: err.message, topics: [] });
      });
    });
    probe.on('message', (topic, payload) => {
      if (found.size >= 400 && !found.has(topic)) return;
      // Keep the whole payload (bounded) so HA discovery configs stay parseable;
      // they are long (the shared `device` object) and a 300-char cut broke them.
      const str = decode(payload, isHaSensorConfig(topic) ? HA_CONFIG_MAX : PAYLOAD_MAX);
      found.set(topic, { payload: str, at: Date.now(), truncated: payload.length > (isHaSensorConfig(topic) ? HA_CONFIG_MAX : PAYLOAD_MAX) });
      // When a sensor config arrives, also listen to the value it points at (often
      // outside the browse prefix), so we can show the current reading.
      const ha = resolveHaSensorConfig(topic, str);
      if (ha && ha.topic && !stateSubs.has(ha.topic)) {
        stateSubs.add(ha.topic);
        try {
          probe.subscribe(ha.topic, () => {});
        } catch (e) {
          /* ignore */
        }
      }
    });

    setTimeout(() => {
      // The scan is also a refresh of the shared cache, when it looked at the same
      // broker the shared client is connected to.
      const key = `${cfg.host}:${cfg.port || 1883}:${cfg.tls ? 1 : 0}:${cfg.username || ''}`;
      if (status.connected && key === brokerKey) {
        for (const [t, e] of found) remember(t, e.payload, e.at, e.truncated);
      }
      finish({ ok: true, error: null, topics: buildTopicList(found) });
    }, window * 1000);
  });
}

/**
 * Register the output side (once, at boot). Stores the last-will, the command
 * topics to subscribe, and the callbacks. If the link is already up, subscribe
 * the command topics and fire onConnect now so a late registration still works.
 */
function setOutput(o) {
  output = o || null;
  if (client && status.connected && output) {
    if (output.commandTopics && output.commandTopics.length) client.subscribe(output.commandTopics, () => {});
    if (output.onConnect) Promise.resolve(output.onConnect()).catch(() => {});
  }
}

// Publish, but only when the link is up — telemetry is disposable, so a message
// sent while disconnected is simply dropped (retained state catches HA up on the
// next connect).
function publish(topic, payload, { retain = false, qos = 0 } = {}) {
  if (!client || !status.connected) return false;
  try {
    client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain, qos });
    return true;
  } catch (e) {
    return false;
  }
}

module.exports = {
  configure,
  disconnect,
  testConnection,
  discoverTopics,
  getCachedTopics,
  startBrowse,
  endBrowse,
  setOutput,
  publish,
  isConnected: () => status.connected,
  getValue: (name) => cache.get(name) || null,
  getStatus: () => ({ ...status }),
  // Test helpers.
  _reset: () => {
    disconnect();
    brokerSig = null;
    inputs = [];
    output = null;
    cache.clear();
    topicCache.clear();
    haCache.clear();
    brokerKey = null;
  },
  _ingest: onMessage, // simulate an incoming message in tests
  _setStatus: (s) => {
    status = { ...status, ...s };
  },
  _jsonPathFromTemplate: jsonPathFromTemplate,
  _resolveHaSensorConfig: resolveHaSensorConfig,
  _currentValue: currentValue,
  _topicCacheSize: () => topicCache.size + haCache.size,
  _haCacheSize: () => haCache.size,
  _cacheBytes: () => topicCache.bytes + haCache.bytes,
  _isBrowsing: () => browse.active,
  _topicCacheMax: TOPIC_CACHE_MAX,
  _setClient: (c, key) => {
    client = c;
    brokerKey = key || null;
  },
};
