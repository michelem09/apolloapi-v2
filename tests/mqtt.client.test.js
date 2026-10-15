// Mock the transport so the broker-facing orchestration in testConnection() and
// discoverTopics() runs without a real broker. The jest config sets resetMocks,
// which strips a factory's implementation before each test, so the fake client
// is (re)installed in beforeEach via mockImplementation, not in the factory.
jest.mock('mqtt', () => ({ connect: jest.fn() }));

const mqtt = require('mqtt');
const client = require('../src/services/mqtt/client');

// A minimal event-emitter-ish fake mqtt client we drive from the tests.
const makeClient = () => {
  const handlers = {};
  return {
    on: (ev, cb) => {
      (handlers[ev] = handlers[ev] || []).push(cb);
    },
    emit: (ev, ...args) => {
      (handlers[ev] || []).forEach((cb) => cb(...args));
    },
    subscribe: jest.fn((topic, cb) => cb && cb(null)),
    publish: jest.fn(),
    end: (force, opts, cb) => {
      if (typeof opts === 'function') opts();
      else if (typeof cb === 'function') cb();
    },
  };
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

describe('mqtt client — topic cache', () => {
  const connected = (extra = {}) => {
    client.configure({ enabled: true, host: 'b', inputs: [], ...extra });
    const c = probe();
    c.emit('connect');
    return c;
  };
  const msg = (c, topic, body) => c.emit('message', topic, Buffer.from(body));

  it('subscribes to # once connected and fills from what it sees', () => {
    const c = connected();
    expect(c.subscribe.mock.calls.map((x) => x[0])).toContain('#');
    msg(c, 'sun2000/state', JSON.stringify({ battery: { soc: 80 }, label: 'x' }));
    msg(c, 'plain/topic', '42');

    const r = client.getCachedTopics();
    expect(r.ok).toBe(true);
    const state = r.topics.find((t) => t.topic === 'sun2000/state');
    expect(state.jsonPaths).toEqual(['battery.soc']);
    expect(state.pathValues).toEqual([{ path: 'battery.soc', value: '80' }]);
    expect(Date.parse(state.lastSeen)).not.toBeNaN();
    expect(r.topics.find((t) => t.topic === 'plain/topic').value).toBe('42');
  });

  it('resolves a HA sensor from cached config + state', () => {
    const c = connected();
    msg(c, 'homeassistant/sensor/x/config', JSON.stringify({ name: 'Yield', unit_of_measurement: 'kWh', state_topic: 's/t', value_template: '{{ value_json.y }}' }));
    msg(c, 's/t', JSON.stringify({ y: 7 }));
    const e = client.getCachedTopics().topics.find((t) => t.name === 'Yield');
    expect(e).toMatchObject({ topic: 's/t', jsonPath: 'y', value: '7', unit: 'kWh' });
  });

  it('keeps the newest topics and never exceeds the bound', () => {
    const c = connected();
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

  it('bounds the stored payload size', () => {
    const c = connected();
    msg(c, 'big', 'x'.repeat(100000));
    const t = client.getCachedTopics().topics.find((x) => x.topic === 'big');
    expect(t.sample.length).toBeLessThanOrEqual(300);
    expect(t.value.length).toBeLessThanOrEqual(80);
  });

  it("leaves out the device's own topics and non-sensor HA definitions", () => {
    const out = { will: { topic: 'apollo/id1/status', payload: 'offline' }, ownPrefix: 'apollo/id1', commandTopics: [] };
    client.setOutput(out);
    const c = connected();
    msg(c, 'apollo/id1/state', '{"a":1}');
    msg(c, 'apollo/other/state', '{"a":1}');
    msg(c, 'homeassistant/switch/x/config', '{}');
    msg(c, 'homeassistant/sensor/own/config', JSON.stringify({ name: 'Own', state_topic: 'apollo/id1/miner' }));
    const names = client.getCachedTopics().topics.map((t) => t.topic);
    expect(names).toContain('apollo/other/state');
    expect(names).not.toContain('apollo/id1/state');
    expect(client.getCachedTopics().topics.some((t) => t.name === 'Own')).toBe(false);
    expect(client._topicCacheSize()).toBe(2); // other/state + own sensor config
  });

  it('still routes a command once even when # delivers it twice', () => {
    const onCommand = jest.fn();
    client.setOutput({ commandTopics: ['apollo/id1/miner/set'], ownPrefix: 'apollo/id1', onCommand });
    const c = connected();
    msg(c, 'apollo/id1/miner/set', 'ON');
    msg(c, 'apollo/id1/miner/set', 'ON');
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(client._topicCacheSize()).toBe(0);
  });

  it('does not disturb input signals', () => {
    const c = connected({ inputs: [{ name: 'surplus', topic: 'sun/surplus' }] });
    msg(c, 'sun/surplus', '850');
    expect(client.getValue('surplus').value).toBe(850);
  });

  it('is empty and not ok when disconnected, and cleared on disconnect', () => {
    expect(client.getCachedTopics()).toMatchObject({ ok: false, topics: [] });
    const c = connected();
    msg(c, 'a/b', '1');
    client.disconnect();
    expect(client._topicCacheSize()).toBe(0);
    expect(client.getCachedTopics()).toMatchObject({ ok: false, topics: [] });
  });

  it('is cleared when the broker config changes', () => {
    const c = connected();
    msg(c, 'a/b', '1');
    client.configure({ enabled: true, host: 'other', inputs: [] });
    expect(client._topicCacheSize()).toBe(0);
  });

  it('a timed scan on the same broker refreshes the cache', async () => {
    const shared = connected();
    const p = client.discoverTopics({ host: 'b' }, { seconds: 1 });
    const scan = probe(1);
    scan.emit('connect');
    msg(scan, 'scanned/only', '5');
    jest.advanceTimersByTime(1000);
    await p;
    expect(client.getCachedTopics().topics.map((t) => t.topic)).toContain('scanned/only');
    expect(shared).toBeDefined();
  });

  it('never logs payloads', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map((m) => jest.spyOn(console, m).mockImplementation(() => {}));
    const c = connected();
    msg(c, 'secret/topic', 'hunter2-password');
    spies.forEach((s) => {
      expect(s).not.toHaveBeenCalled();
      s.mockRestore();
    });
  });
});
