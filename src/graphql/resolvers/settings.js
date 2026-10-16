const pubsub = require('../pubsub');
const TOPICS = require('../topics');
const { errorPayload } = require('../errorPayload');

module.exports = {
  Query: {
    Settings: () => ({})
  },

  Mutation: {
    Settings: () => ({})
  },

  SettingsActions: {
    list: async (_, __, { services }) => {
      try {
        const result = await services.settings.list();
        return { result, error: null };
      } catch (error) {
        return { result: null, error: { message: error.message } };
      }
    },

    read: async (_, __, { services }) => {
      try {
        const settings = await services.settings.read();
        return { result: { settings }, error: null };
      } catch (error) {
        return { result: null, error: { message: error.message } };
      }
    }
  },

  SettingsMutations: {
    update: async (_, { input }, { services }) => {
      try {
        const settings = await services.settings.update(input);
        const payload = { result: { settings }, error: null };
        // Push updated settings to all active WebSocket subscribers
        pubsub.publish(TOPICS.SETTINGS, { settings: payload });
        return payload;
      } catch (error) {
        return { result: null, error: errorPayload(error) };
      }
    }
  }
};