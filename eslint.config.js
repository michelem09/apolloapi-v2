// Minimal ESLint config: the one rule we care about right now is no-console, so a
// raw console.* can't creep back in after the migration to src/logger.js (see
// docs-ai/LOGGING_REDESIGN.md). Scoped to src/ — tests and scripts may use console.
// Not a full style pass; add rules deliberately, not by pulling in a big preset.
module.exports = [
  {
    files: ['src/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
    },
    rules: {
      'no-console': 'error',
    },
  },
];
