const pino = require('pino');
const { errSerializer, redactPaths } = require('../src/logger');

// These lock in the two mechanisms that keep secrets out of the (persistent,
// on-disk) journal. A real leak was found here once: node.js logs failed bitcoind
// RPC calls as `{ err }`, and pino's default err serializer copied the whole axios
// error — including `config.auth.password` (plaintext) and `config.headers.
// authorization` — three levels deep, where path-based redaction can't reach.

// Build a logger that writes to a capture buffer, with the real redaction config
// and err serializer, so the assertions exercise what production actually uses.
function captureLogger() {
  const lines = [];
  const stream = { write: (s) => lines.push(s) };
  const logger = pino(
    {
      level: 'trace',
      redact: { paths: redactPaths, censor: '[redacted]' },
      serializers: { err: errSerializer },
    },
    stream
  );
  return { logger, text: () => lines.join('') };
}

describe('logger errSerializer', () => {
  it('strips axios config/request (where RPC credentials nest) at any depth', () => {
    const err = new Error('connect ECONNREFUSED');
    err.code = 'ECONNREFUSED';
    err.config = {
      auth: { username: 'bitcoinrpc', password: 'SUPERSECRET_RPC_PASSWORD' },
      headers: { authorization: 'Basic Yml0Y29pbnJwYzpTVVBFUg==' },
    };
    err.request = { path: '/' };
    err.response = {
      status: 500,
      statusText: 'Internal Server Error',
      config: { auth: { password: 'SUPERSECRET_RPC_PASSWORD' } },
      data: { error: { code: -32601, message: 'Method not found' } },
    };

    const s = errSerializer(err);

    // The plumbing that carries the secret is gone.
    expect(s.config).toBeUndefined();
    expect(s.request).toBeUndefined();
    expect(s.response.config).toBeUndefined();
    // The useful diagnostics survive.
    expect(s.message).toContain('ECONNREFUSED');
    expect(s.code).toBe('ECONNREFUSED');
    expect(s.response.status).toBe(500);
    expect(s.response.data.error.message).toBe('Method not found');
    // No secret anywhere in the serialized form.
    expect(JSON.stringify(s)).not.toContain('SUPERSECRET_RPC_PASSWORD');
    expect(JSON.stringify(s)).not.toContain('Basic Yml');
  });

  it('leaves the caller’s error untouched (the serializer must be pure)', () => {
    // pino shallow-copies, so a `delete` inside the serializer would strip these
    // from the live error — which node.js logs and then re-throws to its callers.
    const err = new Error('boom');
    err.config = { auth: { password: 'SUPERSECRET_RPC_PASSWORD' } };
    err.request = { path: '/' };
    err.response = {
      status: 500,
      config: { auth: { password: 'SUPERSECRET_RPC_PASSWORD' } },
      request: { path: '/' },
      data: { ok: false },
    };

    errSerializer(err);

    expect(err.config).toBeDefined();
    expect(err.request).toBeDefined();
    expect(err.response.config).toBeDefined();
    expect(err.response.request).toBeDefined();
    expect(err.response.config.auth.password).toBe('SUPERSECRET_RPC_PASSWORD');
  });

  it('does not leak the axios credentials when logged through the logger', () => {
    const { logger, text } = captureLogger();
    const err = new Error('boom');
    err.config = { auth: { password: 'SUPERSECRET_RPC_PASSWORD' } };
    logger.error({ err }, 'error in _getNodeStats');
    expect(text()).not.toContain('SUPERSECRET_RPC_PASSWORD');
    expect(text()).toContain('error in _getNodeStats');
  });
});

describe('logger redaction', () => {
  it('redacts a Knex error’s bindings (the password hash)', () => {
    const { logger, text } = captureLogger();
    const err = new Error('insert failed');
    err.sql = 'insert into setup (password) values (?)';
    err.bindings = ['$2a$12$SECRET_BCRYPT_HASH'];
    logger.error({ err }, 'setup failed');
    expect(text()).toContain('[redacted]');
    expect(text()).not.toContain('SECRET_BCRYPT_HASH');
  });

  it('redacts sensitive keys on a directly-logged object', () => {
    const { logger, text } = captureLogger();
    logger.warn(
      { node_rpc_password: 'plaintext-pw', authorization: 'Bearer tok', ok: true },
      'settings snapshot'
    );
    const out = text();
    expect(out).not.toContain('plaintext-pw');
    expect(out).not.toContain('Bearer tok');
    expect(out).toContain('[redacted]');
    expect(out).toContain('"ok":true'); // non-sensitive fields pass through
  });
});
