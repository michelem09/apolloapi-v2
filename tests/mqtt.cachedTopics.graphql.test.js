const { graphql } = require('graphql');
const schema = require('../src/graphql/schema');
const client = require('../src/services/mqtt/client');

const hasAuth = (field) => field.astNode.directives.some((d) => d.name.value === 'auth');

// Every field in the MQTT namespaces sits behind @auth, like the rest of the API.
const READ = '{ Mqtt { cachedTopics { result { ok error topics { topic lastSeen pathValues { path value } } } error { message } } } }';
const MUTATIONS = {
  updateConfig: 'mutation { Mqtt { updateConfig(input: { enabled: true }) { result { enabled } } } }',
  renewBrowse: 'mutation { Mqtt { renewBrowse { result { ok } } } }',
  endBrowse: 'mutation { Mqtt { endBrowse { result { ok } } } }',
};

describe('Mqtt query side', () => {
  it('has @auth on every field', () => {
    const fields = Object.values(schema.getType('MqttActions').getFields());
    expect(fields.filter((f) => !hasAuth(f))).toEqual([]);
  });

  it('keeps no state-changing field, and cachedTopics takes no lease argument', () => {
    const fields = schema.getType('MqttActions').getFields();
    expect(Object.keys(fields).sort()).toEqual(['cachedTopics', 'config', 'discoverTopics', 'testConnection']);
    expect(fields.cachedTopics.args).toEqual([]);
  });

  it('rejects cachedTopics without a token, before the resolver runs', async () => {
    const getCachedTopics = jest.spyOn(client, 'getCachedTopics');
    const res = await graphql({ schema, source: READ, contextValue: { services: {} } });
    expect(res.errors?.[0].message).toMatch(/auth/i);
    expect(getCachedTopics).not.toHaveBeenCalled();
    getCachedTopics.mockRestore();
  });

  it('reading cachedTopics (authenticated) does not start a browse session', async () => {
    const renew = jest.spyOn(client, 'renewBrowse');
    const start = jest.spyOn(client, 'startBrowse');
    const services = { mqtt: { cachedTopics: () => client.getCachedTopics() } };
    const user = { id: 1 };
    // Resolver called directly: @auth is covered above, this is about side effects.
    const resolver = require('../src/graphql/resolvers/mqtt');
    const out = await resolver.MqttActions.cachedTopics({}, {}, { services, user });
    expect(out.error).toBeNull();
    expect(renew).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    renew.mockRestore();
    start.mockRestore();
  });
});

describe('Mqtt mutations', () => {
  it('lives on Mutation.Mqtt with @auth on every field', () => {
    expect(schema.getMutationType().getFields().Mqtt).toBeDefined();
    const fields = schema.getType('MqttMutations').getFields();
    expect(Object.keys(fields).sort()).toEqual(['endBrowse', 'renewBrowse', 'updateConfig']);
    expect(Object.values(fields).filter((f) => !hasAuth(f))).toEqual([]);
  });

  it.each(Object.entries(MUTATIONS))('%s is rejected without a token, before the resolver runs', async (name, source) => {
    const service = { updateConfig: jest.fn(), renewBrowse: jest.fn(), endBrowse: jest.fn() };
    const res = await graphql({ schema, source, contextValue: { services: { mqtt: service } } });
    expect(res.errors?.[0].message).toMatch(/auth/i);
    expect(service[name]).not.toHaveBeenCalled();
  });

  it('renewBrowse and endBrowse call the service and map the result', async () => {
    const resolver = require('../src/graphql/resolvers/mqtt');
    const services = {
      mqtt: {
        renewBrowse: jest.fn().mockReturnValue({ ok: false, error: 'Not connected to the MQTT broker' }),
        endBrowse: jest.fn().mockReturnValue({ ok: true, error: null }),
      },
    };
    expect(await resolver.MqttMutations.renewBrowse({}, {}, { services })).toEqual({
      result: { ok: false, message: 'Not connected to the MQTT broker' },
      error: null,
    });
    expect(await resolver.MqttMutations.endBrowse({}, {}, { services })).toEqual({
      result: { ok: true, message: null },
      error: null,
    });
  });
});
