const { graphql } = require('graphql');
const schema = require('../src/graphql/schema');
const client = require('../src/services/mqtt/client');

// cachedTopics must sit behind @auth like the rest of the MQTT namespace.
const QUERY = '{ Mqtt { cachedTopics { result { ok error topics { topic lastSeen pathValues { path value } } } error { message } } } }';

describe('Mqtt.cachedTopics', () => {
  it('has the @auth directive on the field', () => {
    const field = schema.getType('MqttActions').getFields().cachedTopics;
    expect(field.astNode.directives.some((d) => d.name.value === 'auth')).toBe(true);
  });

  it('has the @auth directive on endBrowse too', () => {
    const field = schema.getType('MqttActions').getFields().endBrowse;
    expect(field.astNode.directives.some((d) => d.name.value === 'auth')).toBe(true);
  });

  it('is rejected without a token, before the resolver runs', async () => {
    const getCachedTopics = jest.spyOn(client, 'getCachedTopics');
    const res = await graphql({ schema, source: QUERY, contextValue: { services: {} } });
    expect(res.errors?.[0].message).toMatch(/auth/i);
    expect(getCachedTopics).not.toHaveBeenCalled();
    getCachedTopics.mockRestore();
  });
});
