module.exports = {
  Query: {
    Diagnostics: () => ({})
  },

  DiagnosticsActions: {
    bundle: async (_, { input }, { services }) => {
      try {
        const result = await services.diagnostics.bundle(input || {});
        return { result, error: null };
      } catch (error) {
        return { result: null, error: { message: error.message } };
      }
    }
  }
};
