const { errorPayload } = require('../errorPayload');

// One implementation per action, shared by the mutation and its deprecated query
// alias (see typeDefs/solo.js).
const action = (name) => async (_, __, { services }) => {
  try {
    await services.solo[name]();
    return { success: true, error: null };
  } catch (error) {
    return { success: false, error: errorPayload(error) };
  }
};
const start = action('start');
const stop = action('stop');
const restart = action('restart');

module.exports = {
  Query: {
    Solo: () => ({})
  },

  Mutation: {
    Solo: () => ({})
  },

  SoloMutations: { start, stop, restart },

  SoloActions: {
    // Deprecated aliases — see typeDefs/solo.js.
    start,
    stop,
    restart,

    status: async (_, __, { services }) => {
      try {
        const status = await services.solo.getStatus();
        return { result: { status }, error: null };
      } catch (error) {
        return { result: null, error: { message: error.message } };
      }
    },

    stats: async (_, __, { services }) => {
      try {
        const result = await services.solo.getStats();
        return { result, error: null };
      } catch (error) {
        return { result: null, error: { message: error.message } };
      }
    }
  }
};
