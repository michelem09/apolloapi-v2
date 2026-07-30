// Central logger. One pino instance, one child per component, so every line is
// levelled, structured, and filterable (see docs-ai/LOGGING_REDESIGN.md).
//
// Redaction (below) protects logs ROUTED THROUGH this logger. Migration off raw
// console.* is in progress — the hot/secret-handling modules first — so an
// unconverted file's console.* still bypasses both the levels and the redaction.
// The guarantee is "what goes through the logger is redacted", not "nothing in the
// process can log a secret". Route credential-adjacent code here before relying on
// it there.
//
//   const log = require('../logger')('scheduler');
//   log.info('miner stats pushed');
//   log.debug({ rows }, 'time series pruned');
//   log.error({ err }, 'failed to reach the node');
//
// Level comes from LOG_LEVEL, else a sane per-env default. Prod emits JSON on
// stdout → journald; dev pretty-prints inline; tests are silent.
const pino = require('pino');

const isDev = process.env.NODE_ENV === 'development';
const isTest = process.env.NODE_ENV === 'test';
const level = process.env.LOG_LEVEL || (isTest ? 'silent' : isDev ? 'debug' : 'info');

// Redact sensitive values on the direct-object logging paths — `log.warn({
// node_rpc_password }, …)` and the Knex error's `bindings` (a password hash).
// Path-based redaction only reaches shallow keys, so it is NOT the defence for
// deeply-nested secrets: those are handled structurally by the err serializer
// below. Keep this list to shapes actually logged at this layer (§2.4).
const redactPaths = [
  'password', '*.password', 'newPassword', '*.newPassword',
  'rpcpassword', '*.rpcpassword', 'node_rpc_password', '*.node_rpc_password',
  'pass', '*.pass',
  'authorization', '*.authorization',
  'token', '*.token', 'accessToken', '*.accessToken',
  // Knex errors serialize their own enumerable props (sql, bindings); the values
  // that matter are in bindings.
  'bindings', '*.bindings', 'err.bindings',
];

// An axios error carries the whole request in `config` and `request` — including
// `config.auth.password` (plaintext RPC password) and `config.headers.authorization`
// (base64), nested where path-based redaction can't reach. pino's default err
// serializer copies every enumerable own prop, so `log.error({ err })` on a failed
// bitcoind RPC call would write those to the (persistent, on-disk) journal. Strip
// the request/response plumbing structurally, at any depth; keep the useful bits
// (message, stack, code, response status/body).
// Must be PURE: pino's std serializer shallow-copies, so `serialized.response` is
// the caller's own `err.response`. Deleting keys off it would strip fields from the
// live error that then propagates (node.js logs the error and re-throws it), and a
// downstream interceptor/retry/reporter would see an object nobody visibly touched.
// So rebuild instead of delete.
const errSerializer = (err) => {
  const serialized = pino.stdSerializers.err(err);
  if (!serialized || typeof serialized !== 'object') return serialized;

  const { config, request, response, ...rest } = serialized;
  if (response && typeof response === 'object') {
    const { config: _config, request: _request, ...responseRest } = response;
    rest.response = responseRest;
  }
  return rest;
};

const options = {
  level,
  redact: { paths: redactPaths, censor: '[redacted]' },
  serializers: { err: errSerializer },
  // journald already stamps _PID/_HOSTNAME on every entry — dropping pino's own
  // base keeps the JSON lean.
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  // 'info' reads better than the numeric 30 in the journal and in a bundle.
  formatters: { level: (label) => ({ level: label }) },
};

// Dev: pretty inline via a worker, so `yarn dev` no longer pipes through bunyan.
// Prod: plain JSON on stdout, the cheapest path into journald.
const root = isDev
  ? pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
      },
    })
  : pino(options);

// A child per component tags every line with { component } for filtering. Called
// with no name it returns the root — for the rare top-level line.
module.exports = (component) => (component ? root.child({ component }) : root);

// Exposed for the redaction/serializer regression tests (tests/logger.test.js) —
// the pieces that keep secrets out of the journal, so a future refactor can't
// silently reopen the leak.
module.exports.errSerializer = errSerializer;
module.exports.redactPaths = redactPaths;
