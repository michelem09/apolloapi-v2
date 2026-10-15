// Mock the transport so the broker-facing orchestration in testConnection() and
// discoverTopics() runs without a real broker. The jest config sets resetMocks,
// which strips a factory's implementation before each test, so the fake client
// is (re)installed in beforeEach via mockImplementation, not in the factory.
jest.mock('mqtt', () => ({ connect: jest.fn() }));
// A plain function (not jest.fn), so resetMocks leaves it intact.
const mockWarn = jest.fn();
jest.mock('../src/logger', () => () => ({
  warn: (...a) => mockWarn(...a),
  error: () => {},
  info: () => {},
  debug: () => {},
}));

const mqtt = require('mqtt');
const client = require('../src/services/mqtt/client');

// A minimal event-emitter-ish fake mqtt client we drive from the tests.
const makeClient = () => {
  const handlers = {};
  const c = {
    on: (ev, cb) => {
      (handlers[ev] = handlers[ev] || []).push(cb);
    },
    emit: (ev, ...args) => {
      (handlers[ev] || []).forEach((cb) => cb(...args));
    },
    // The SUBACK: every topic granted at QoS 0 unless the test makes it refuse.
    subscribe: jest.fn((topic, cb) => {
      const topics = [].concat(topic);
      cb && cb(null, topics.map((t) => ({ topic: t, qos: c.refuse && c.refuse.includes(t) ? 128 : 0 })));
    }),
    unsubscribe: jest.fn((t, cb) => cb && cb(null)),
    removeAllListeners: (ev) => {
      if (ev) delete handlers[ev];
      else Object.keys(handlers).forEach((k) => delete handlers[k]);
    },
    publish: jest.fn(),
    end: (force, opts, cb) => {
      if (typeof opts === 'function') opts();
      else if (typeof cb === 'function') cb();
    },
  };
  return c;
};

// The fake client returned by the i-th mqtt.connect() call.
const probe = (i = 0) => mqtt.connect.mock.results[i].value;

beforeEach(() => {
  jest.useFakeTimers();
  mqtt.connect.mockImplementation(() => makeClient());
  client._reset();
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('mqtt client — testConnection', () => {
  it('resolves ok when the broker accepts the connection', async () => {
    const p = client.testConnection({ host: 'b' });
    probe().emit('connect');
    await expect(p).resolves.toEqual({ ok: true, error: null });
  });

  it('maps a CONNACK refusal to a readable reason', async () => {
    const p = client.testConnection({ host: 'b' });
    const err = new Error('connection refused');
    err.code = 5;
    probe().emit('error', err);
    await expect(p).resolves.toEqual({ ok: false, error: 'Rejected: not authorized' });
  });

  it('times out when the broker never answers', async () => {
    const p = client.testConnection({ host: 'b' });
    jest.advanceTimersByTime(7000);
    await expect(p).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/Timed out/) });
  });

  it('refuses without a host, without opening a connection', async () => {
    await expect(client.testConnection({})).resolves.toMatchObject({ ok: false });
    expect(mqtt.connect).not.toHaveBeenCalled();
  });
});

describe('mqtt client — discoverTopics', () => {
  it('collects published topics and resolves a HA sensor config to its value', async () => {
    const p = client.discoverTopics({ host: 'b' }, { seconds: 1 });
    const c = probe();
    c.emit('connect');
    c.emit('message', 'sun2000/surplus', Buffer.from('850'));
    c.emit(
      'message',
      'homeassistant/sensor/x/total_yield/config',
      Buffer.from(JSON.stringify({ name: 'Total Yield', state_topic: 'sun2000/state', value_template: '{{ value_json.total_yield }}' }))
    );
    c.emit('message', 'sun2000/state', Buffer.from(JSON.stringify({ total_yield: 1234 })));

    jest.advanceTimersByTime(1000); // close the browse window

    const r = await p;
    expect(r.ok).toBe(true);
    // The plain topic is listed…
    expect(r.topics.some((t) => t.topic === 'sun2000/surplus')).toBe(true);
    // …and the HA sensor config resolved to its state topic + current value.
    expect(r.topics.some((t) => t.topic === 'sun2000/state' && t.value === '1234')).toBe(true);
    // The config topic itself is not surfaced as a plain topic.
    expect(r.topics.some((t) => t.topic === 'homeassistant/sensor/x/total_yield/config')).toBe(false);
  });

  it('refuses without a host', async () => {
    await expect(client.discoverTopics({})).resolves.toMatchObject({ ok: false, topics: [] });
  });
});

describe('mqtt client — topic cache and browse session', () => {
  const connected = (extra = {}) => {
    client.configure({ enabled: true, host: 'b', inputs: [], ...extra });
    const c = probe(mqtt.connect.mock.calls.length - 1);
    c.emit('connect');
    return c;
  };
  const msg = (c, topic, body) => c.emit('message', topic, Buffer.isBuffer(body) ? body : Buffer.from(body));
  const subscribedTopics = (c) => c.subscribe.mock.calls.flatMap((x) => [].concat(x[0]));

  describe('the # subscription', () => {
    it('is not made on connect: only inputs and command topics', () => {
      client.setOutput({ commandTopics: ['apollo/x/miner/set'], ownPrefix: 'apollo/x' });
      const c = connected({ inputs: [{ name: 'a', topic: 'sun/a' }] });
      expect(subscribedTopics(c).sort()).toEqual(['apollo/x/miner/set', 'sun/a']);
    });

    it('starts with the first cachedTopics lease, once, and stops with endBrowse', () => {
      const c = connected();
      client.getCachedTopics();
      client.getCachedTopics(); // a renew, not a second subscription
      expect(subscribedTopics(c).filter((t) => t === '#')).toHaveLength(1);

      msg(c, 'a/b', '1');
      client.endBrowse();
      expect(c.unsubscribe).toHaveBeenCalledWith('#', expect.any(Function));
      // The cache outlives the session…
      expect(client.getCachedTopics({ lease: false }).topics.map((t) => t.topic)).toContain('a/b');
      // …and a read without a lease does not reopen it.
      expect(subscribedTopics(c).filter((t) => t === '#')).toHaveLength(1);
    });

    it('ends by itself after 5 minutes without a renew, and a renew pushes that back', () => {
      const c = connected();
      client.getCachedTopics();
      jest.advanceTimersByTime(4 * 60 * 1000);
      client.getCachedTopics(); // the modal's poll
      jest.advanceTimersByTime(4 * 60 * 1000);
      expect(c.unsubscribe).not.toHaveBeenCalled();
      jest.advanceTimersByTime(61 * 1000);
      expect(c.unsubscribe).toHaveBeenCalledWith('#', expect.any(Function));
      expect(client._isBrowsing()).toBe(false);
    });

    it('is not repeated on a reconnect: mqtt.js resubscribes, a second one replays retained twice', () => {
      const c = connected({ inputs: [{ name: 'a', topic: 'sun/a' }] });
      client.getCachedTopics();
      const before = c.subscribe.mock.calls.length;
      c.emit('connect'); // the reconnect
      expect(c.subscribe.mock.calls.length).toBe(before);
    });

    it('surfaces a refused # (SUBACK 128) in the result, warns once, and does not retry in a loop', () => {
      client.configure({ enabled: true, host: 'b', inputs: [] });
      const c = probe();
      c.refuse = ['#'];
      c.emit('connect');

      const r = client.getCachedTopics();
      expect(r.ok).toBe(true);
      expect(r.error).toMatch(/does not allow subscribing to all topics/);
      client.getCachedTopics();
      client.getCachedTopics();
      expect(subscribedTopics(c).filter((t) => t === '#')).toHaveLength(1);
      expect(mockWarn).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/password|payload/i);

      // A new session may try again (the user fixed the ACL).
      client.endBrowse();
      c.refuse = null;
      expect(client.getCachedTopics().error).toBeNull();
      expect(subscribedTopics(c).filter((t) => t === '#')).toHaveLength(2);
    });
  });

  describe('what is cached', () => {
    it('fills from what it sees, with values per jsonPath', () => {
      const c = connected();
      client.getCachedTopics();
      msg(c, 'sun2000/state', JSON.stringify({ battery: { soc: 80 }, label: 'x' }));
      msg(c, 'plain/topic', '42');

      const r = client.getCachedTopics();
      const state = r.topics.find((t) => t.topic === 'sun2000/state');
      expect(state.jsonPaths).toEqual(['battery.soc']);
      expect(state.pathValues).toEqual([{ path: 'battery.soc', value: '80' }]);
      expect(Date.parse(state.lastSeen)).not.toBeNaN();
      expect(r.topics.find((t) => t.topic === 'plain/topic').value).toBe('42');
    });

    it('resolves a HA sensor from cached config + state', () => {
      const c = connected();
      client.getCachedTopics();
      msg(c, 'homeassistant/sensor/x/config', JSON.stringify({ name: 'Yield', unit_of_measurement: 'kWh', state_topic: 's/t', value_template: '{{ value_json.y }}' }));
      msg(c, 's/t', JSON.stringify({ y: 7 }));
      const e = client.getCachedTopics().topics.find((t) => t.name === 'Yield');
      expect(e).toMatchObject({ topic: 's/t', jsonPath: 'y', value: '7', unit: 'kWh' });
    });

    it('keeps the newest topics and never exceeds the entry bound', () => {
      const c = connected();
      client.getCachedTopics();
      const max = client._topicCacheMax;
      for (let i = 0; i < max + 50; i++) msg(c, `t/${i}`, '1');
      msg(c, 't/60', '2'); // refreshed: must survive the next eviction
      msg(c, 't/new', '1');
      expect(client._topicCacheSize()).toBe(max);
      const names = client.getCachedTopics().topics.map((t) => t.topic);
      expect(names).not.toContain('t/0');
      expect(names).toContain('t/60');
      expect(names).toContain('t/new');
    });

    it('keeps HA sensors, config and state, however much the other topics chatter', () => {
      const c = connected();
      client.getCachedTopics();
      msg(c, 'homeassistant/sensor/inv/power/config', JSON.stringify({ name: 'PV power', state_topic: 'sun2000/state', value_template: '{{ value_json.p }}' }));
      msg(c, 'sun2000/state', '{"p":1234}');
      for (let i = 0; i < 2000; i++) msg(c, `zigbee2mqtt/dev${i}`, '{"linkquality":50}');
      const e = client.getCachedTopics().topics.find((t) => t.name === 'PV power');
      expect(e).toMatchObject({ value: '1234' });
    });

    it('also when the state arrives before its config', () => {
      const c = connected();
      client.getCachedTopics();
      msg(c, 'sun2000/state', '{"p":99}');
      msg(c, 'homeassistant/sensor/inv/power/config', JSON.stringify({ name: 'PV power', state_topic: 'sun2000/state', value_template: '{{ value_json.p }}' }));
      for (let i = 0; i < 2000; i++) msg(c, `zigbee2mqtt/dev${i}`, '{"linkquality":50}');
      expect(client.getCachedTopics().topics.find((t) => t.name === 'PV power').value).toBe('99');
    });

    it('keeps a long HA config whole, and lists one too long to keep instead of hiding it', () => {
      const c = connected();
      client.getCachedTopics();
      const device = { identifiers: ['x'.repeat(9000)] };
      msg(c, 'homeassistant/sensor/a/config', JSON.stringify({ name: 'Long', state_topic: 's/a', value_template: '{{ value_json.v }}', device }));
      msg(c, 's/a', '{"v":5}');
      const huge = JSON.stringify({ name: 'Huge', state_topic: 's/b', device: { identifiers: ['y'.repeat(40000)] } });
      msg(c, 'homeassistant/sensor/b/config', huge);
      const topics = client.getCachedTopics().topics;
      expect(topics.find((t) => t.name === 'Long')).toMatchObject({ value: '5' });
      expect(topics.some((t) => t.topic === 'homeassistant/sensor/b/config')).toBe(true);
    });

    it('bounds the real bytes held, not the length of a decoded string', () => {
      const out = jest.requireActual('child_process').execFileSync(
        process.execPath,
        [
          '--expose-gc',
          '-e',
          `
          const c = require(${JSON.stringify(require.resolve('../src/services/mqtt/client'))});
          c._reset(); c._setClient({}, 'k'); c._setStatus({ connected: true });
          const big = Buffer.alloc(200 * 1024, 0x41);
          gc(); const before = process.memoryUsage().heapUsed;
          for (let i = 0; i < 600; i++) c._ingest('frigate/cam' + i + '/snapshot', big);
          gc(); const after = process.memoryUsage().heapUsed;
          console.log(JSON.stringify({ delta: after - before, size: c._topicCacheSize(), bytes: c._cacheBytes() }));
          `,
        ],
        { encoding: 'utf8' }
      );
      const r = JSON.parse(out.trim().split('\n').pop());
      expect(r.size).toBe(500);
      expect(r.bytes).toBeLessThanOrEqual(4 * 1024 * 1024);
      // 500 x 4 KB is about 2 MB; the old behaviour kept ~98 MB alive.
      expect(r.delta).toBeLessThan(8 * 1024 * 1024);
    });

    it('keeps at most 4000 bytes of an ordinary payload', () => {
      const c = connected();
      client.getCachedTopics();
      msg(c, 'big', 'x'.repeat(100000));
      const t = client.getCachedTopics().topics.find((x) => x.topic === 'big');
      expect(t.sample.length).toBeLessThanOrEqual(300);
      expect(t.value.length).toBeLessThanOrEqual(80);
    });

    it("leaves out the device's own topics and non-sensor HA definitions", () => {
      client.setOutput({ will: { topic: 'apollo/id1/status', payload: 'offline' }, ownPrefix: 'apollo/id1', commandTopics: [] });
      const c = connected();
      client.getCachedTopics();
      msg(c, 'apollo/id1/state', '{"a":1}');
      msg(c, 'apollo/other/state', '{"a":1}');
      msg(c, 'homeassistant/switch/x/config', '{}');
      msg(c, 'homeassistant/sensor/own/config', JSON.stringify({ name: 'Own', state_topic: 'apollo/id1/miner' }));
      const r = client.getCachedTopics();
      const names = r.topics.map((t) => t.topic);
      expect(names).toContain('apollo/other/state');
      expect(names).not.toContain('apollo/id1/state');
      expect(r.topics.some((t) => t.name === 'Own')).toBe(false);
    });

    it('is not ok while disconnected', () => {
      expect(client.getCachedTopics()).toMatchObject({ ok: false, topics: [] });
    });

    it('never logs payloads', () => {
      const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
      const c = connected();
      client.getCachedTopics();
      msg(c, 'secret/topic', 'hunter2-password');
      spies.forEach((s) => {
        expect(s).not.toHaveBeenCalled();
        s.mockRestore();
      });
      expect(JSON.stringify(mockWarn.mock.calls)).not.toMatch(/hunter2/);
    });

    it('a timed scan on the same broker refreshes the cache', async () => {
      connected();
      const p = client.discoverTopics({ host: 'b' }, { seconds: 1 });
      const scan = probe(1);
      scan.emit('connect');
      msg(scan, 'scanned/only', '5');
      jest.advanceTimersByTime(1000);
      await p;
      expect(client.getCachedTopics().topics.map((t) => t.topic)).toContain('scanned/only');
    });
  });

  describe('commands and inputs', () => {
    it('delivers every command: start, stop, start within a moment are three commands', () => {
      const got = [];
      client.setOutput({ commandTopics: ['apollo/id1/miner/set'], ownPrefix: 'apollo/id1', onCommand: (t, p) => got.push(p) });
      const c = connected();
      msg(c, 'apollo/id1/miner/set', 'start');
      msg(c, 'apollo/id1/miner/set', 'stop');
      msg(c, 'apollo/id1/miner/set', 'start');
      expect(got).toEqual(['start', 'stop', 'start']);
    });

    it('does not disturb input signals while browsing', () => {
      const c = connected({ inputs: [{ name: 'surplus', topic: 'sun/surplus' }] });
      client.getCachedTopics();
      msg(c, 'sun/surplus', '850');
      expect(client.getValue('surplus').value).toBe(850);
    });
  });

  describe('changing the configuration', () => {
    it('adding, changing and removing inputs subscribes on the live link and does not reconnect', () => {
      const c = connected({ inputs: [{ name: 'a', topic: 't/a' }] });
      client.getCachedTopics();
      msg(c, 'homeassistant/sensor/x/config', JSON.stringify({ name: 'Yield', state_topic: 's/t' }));
      msg(c, 'other/topic', '1');
      msg(c, 't/a', '5');
      mqtt.connect.mockClear();
      c.subscribe.mockClear();

      client.configure({ enabled: true, host: 'b', inputs: [{ name: 'a', topic: 't/a' }, { name: 'b', topic: 't/b' }] });
      expect(mqtt.connect).not.toHaveBeenCalled();
      expect(c.subscribe).toHaveBeenCalledWith(['t/b'], expect.any(Function));

      client.configure({ enabled: true, host: 'b', inputs: [{ name: 'b', topic: 't/b' }] });
      expect(c.unsubscribe).toHaveBeenCalledWith(['t/a'], expect.any(Function));
      expect(client.getValue('a')).toBeNull(); // its input is gone
      expect(mqtt.connect).not.toHaveBeenCalled();

      // The browse cache, the HA rows and the session survived all of it.
      const names = client.getCachedTopics({ lease: false }).topics.map((t) => t.topic);
      expect(names).toContain('other/topic');
      expect(names.length).toBeGreaterThanOrEqual(2);
      expect(client._isBrowsing()).toBe(true);
      expect(client.getStatus().connected).toBe(true);
    });

    it('never unsubscribes a command topic that an input also named', () => {
      client.setOutput({ commandTopics: ['apollo/x/miner/set'], ownPrefix: 'apollo/x' });
      const c = connected({ inputs: [{ name: 'a', topic: 'apollo/x/miner/set' }] });
      client.configure({ enabled: true, host: 'b', inputs: [] });
      expect(c.unsubscribe).not.toHaveBeenCalled();
    });

    it('a broker change reconnects and clears the cache', () => {
      const c = connected();
      client.getCachedTopics();
      msg(c, 'a/b', '1');
      mqtt.connect.mockClear();
      client.configure({ enabled: true, host: 'other', inputs: [] });
      expect(mqtt.connect).toHaveBeenCalledTimes(1);
      expect(client._topicCacheSize()).toBe(0);
    });

    it('a new password reconnects as well', () => {
      connected({ password: 'one' });
      mqtt.connect.mockClear();
      client.configure({ enabled: true, host: 'b', password: 'two', inputs: [] });
      expect(mqtt.connect).toHaveBeenCalledTimes(1);
    });

    it('is cleared on disconnect', () => {
      const c = connected();
      client.getCachedTopics();
      msg(c, 'a/b', '1');
      client.disconnect();
      expect(client._topicCacheSize()).toBe(0);
      expect(client.getCachedTopics()).toMatchObject({ ok: false, topics: [] });
    });

    it('late messages from the old client cannot reach the new cache', () => {
      const old = connected();
      client.getCachedTopics();
      client.configure({ enabled: true, host: 'other', inputs: [] });
      const fresh = probe(mqtt.connect.mock.calls.length - 1);
      fresh.emit('connect');
      client.getCachedTopics();
      msg(old, 'stale/topic', '1');
      expect(client.getCachedTopics().topics.map((t) => t.topic)).not.toContain('stale/topic');
    });
  });
});
