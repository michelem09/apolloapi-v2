const { serializeMqttConfig } = require('../serialize/mqtt');

// Same shape as the other namespaces: { result, error }, never a thrown error
// across the wire.
const wrap = async (fn) => {
  try {
    return { result: await fn(), error: null };
  } catch (error) {
    return { result: null, error: { message: error.message } };
  }
};

// Changing the input mappings affects the automation signals; re-evaluate now so
// a new input.* value can be reacted to without waiting for the 60s tick.
const triggerTick = () => {
  try {
    const { evaluateAutomation } = require('../../app/scheduler');
    Promise.resolve(evaluateAutomation()).catch(() => {});
  } catch (e) {
    /* scheduler not running (tests) */
  }
};

module.exports = {
  Query: {
    Mqtt: () => ({}),
  },

  Mutation: {
    Mqtt: () => ({}),
  },

  MqttActions: {
    config: (_, __, { services }) => wrap(async () => serializeMqttConfig(await services.mqtt.getConfig())),

    testConnection: (_, { input }, { services }) =>
      wrap(async () => {
        const { ok, error } = await services.mqtt.testConnection(input);
        return { ok, message: error };
      }),

    discoverTopics: (_, { input, prefix, seconds }, { services }) =>
      wrap(async () => services.mqtt.discoverTopics(input, { prefix, seconds })),

    cachedTopics: (_, __, { services }) => wrap(async () => services.mqtt.cachedTopics()),
  },

  MqttMutations: {
    updateConfig: (_, { input }, { services }) =>
      wrap(async () => {
        const config = serializeMqttConfig(await services.mqtt.updateConfig(input));
        if (input.inputs !== undefined) triggerTick();
        return config;
      }),

    renewBrowse: (_, __, { services }) =>
      wrap(async () => {
        const { ok, error } = services.mqtt.renewBrowse();
        return { ok, message: error };
      }),

    endBrowse: (_, __, { services }) =>
      wrap(async () => {
        const { ok, error } = services.mqtt.endBrowse();
        return { ok, message: error };
      }),
  },
};
