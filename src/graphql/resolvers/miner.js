const { errorPayload } = require('../errorPayload');

// One implementation for each mutation and its deprecated query alias: the alias
// only keeps a pre-mutation UI bundle working, and must not drift.
const start = async (_, __, { services }) => {
  try {
    await services.miner.start();
    return { error: null };
  } catch (error) {
    return { error: errorPayload(error) };
  }
};

const stop = async (_, __, { services }) => {
  try {
    await services.miner.stop();
    return { error: null };
  } catch (error) {
    return { error: errorPayload(error) };
  }
};

const restart = async (_, __, { services }) => {
  try {
    await services.miner.restart();
    return { error: null };
  } catch (error) {
    return { error: errorPayload(error) };
  }
};

const resetBlockFoundFlag = async (_, __, { services }) => {
  try {
    await services.miner.resetBlockFoundFlag();
    return { error: null };
  } catch (error) {
    return { error: { message: error.message } };
  }
};

module.exports = {
  Query: {
    Miner: () => ({}),
  },

  Mutation: {
    Miner: () => ({}),
  },

  MinerMutations: { start, stop, restart, resetBlockFoundFlag },

  MinerActions: {
    // Deprecated aliases — see typeDefs/miner.js.
    start,
    stop,
    restart,
    resetBlockFoundFlag,

    stats: async (_, __, { services }) => {
      try {
        const result = await services.miner.getStats();
        return { result, error: null };
      } catch (error) {
        return { result: null, error: { message: error.message } };
      }
    },

    online: async (_, __, { services }) => {
      try {
        const result = await services.miner.checkOnline();
        return { result, error: null };
      } catch (error) {
        return { result: null, error: { message: error.message } };
      }
    },
  },
};
