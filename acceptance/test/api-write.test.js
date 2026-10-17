// Offline tier: no device, no network. Run with `node --test acceptance/test/`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { gql, gqlWrite, resetWriteForms } = require('../lib/api');

const MUT = 'mutation($input: X!) {\n  Auth { changePassword(input: $input) { error { message } } }\n}';
const validation = (message) => {
  const e = new Error(`GraphQL: ${message}`);
  e.malformed = true;
  e.graphqlErrors = [{ message, extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }];
  return e;
};
const unknownOnMutation = () => validation('Cannot query field "Auth" on type "Mutation".');
const profile = (apiBase) => ({ apiBase });

// A fake server: `mutations` says whether its schema has the field under Mutation.
const fakeServer = ({ mutations, fail } = {}) => {
  const calls = [];
  const send = async (_p, _t, doc, vars) => {
    calls.push(doc.trimStart().split(/\W/)[0]);
    if (fail) throw fail;
    if (doc.trimStart().startsWith('mutation') && !mutations) throw unknownOnMutation();
    return { Auth: { changePassword: { error: null } }, vars };
  };
  return { send, calls };
};

test.beforeEach(() => resetWriteForms());

test('v2.2 schema: the mutation works, nothing falls back', async () => {
  const s = fakeServer({ mutations: true });
  const data = await gqlWrite(profile('a'), 't', MUT, { input: 1 }, s.send);
  assert.equal(data.Auth.changePassword.error, null);
  assert.deepEqual(s.calls, ['mutation']);
  await gqlWrite(profile('a'), 't', MUT, {}, s.send);
  assert.deepEqual(s.calls, ['mutation', 'mutation']);
});

test('2.1.4 schema: mutation rejected, query used, form cached per host', async () => {
  const s = fakeServer({ mutations: false });
  await gqlWrite(profile('old'), 't', MUT, {}, s.send);
  assert.deepEqual(s.calls, ['mutation', 'query']);
  await gqlWrite(profile('old'), 't', MUT, {}, s.send);
  assert.deepEqual(s.calls, ['mutation', 'query', 'query']); // no second probe
  // another host is probed on its own
  await gqlWrite(profile('other'), 't', MUT, {}, s.send);
  assert.deepEqual(s.calls.slice(3), ['mutation', 'query']);
});

test('the query form is the same document with only the keyword changed', async () => {
  let seen;
  const send = async (_p, _t, doc) => {
    if (doc.startsWith('mutation')) throw unknownOnMutation();
    seen = doc;
    return {};
  };
  await gqlWrite(profile('q'), 't', MUT, {}, send);
  assert.equal(seen, MUT.replace('mutation', 'query'));
});

test('a schema with no Mutation type also falls back', async () => {
  const send = async (_p, _t, doc) => {
    if (doc.startsWith('mutation')) throw validation('Schema is not configured for mutations.');
    return { ok: true };
  };
  assert.deepEqual(await gqlWrite(profile('n'), 't', MUT, {}, send), { ok: true });
});

test('auth error on the mutation: no fallback, error surfaced', async () => {
  const e = new Error('GraphQL: Unauthorized');
  e.malformed = false;
  e.graphqlErrors = [{ message: 'Unauthorized', extensions: { code: 'UNAUTHENTICATED' } }];
  const s = fakeServer({ fail: e });
  await assert.rejects(gqlWrite(profile('x'), 't', MUT, {}, s.send), /Unauthorized/);
  assert.deepEqual(s.calls, ['mutation']);
});

test('network error and unrelated validation errors surface without fallback', async () => {
  for (const err of [new TypeError('fetch failed'), validation('Variable "$input" got invalid value')]) {
    const s = fakeServer({ fail: err });
    await assert.rejects(gqlWrite(profile('y'), 't', MUT, {}, s.send), err);
    assert.deepEqual(s.calls, ['mutation']);
  }
});

test('a mixed error list (one not about Mutation) does not fall back', async () => {
  const e = unknownOnMutation();
  e.graphqlErrors.push({ message: 'Unknown type "Foo".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } });
  const s = fakeServer({ fail: e });
  await assert.rejects(gqlWrite(profile('m'), 't', MUT, {}, s.send));
  assert.deepEqual(s.calls, ['mutation']);
});

test('if the query form fails too, that error surfaces and nothing is cached as working', async () => {
  const boom = new Error('GraphQL: boom');
  let n = 0;
  const send = async (_p, _t, doc) => {
    n++;
    if (doc.startsWith('mutation')) throw unknownOnMutation();
    throw boom;
  };
  await assert.rejects(gqlWrite(profile('z'), 't', MUT, {}, send), /boom/);
  await assert.rejects(gqlWrite(profile('z'), 't', MUT, {}, send), /boom/);
  assert.equal(n, 4); // re-probed: failure is not cached
});

test('a document that is not a mutation is refused when a fallback is needed', async () => {
  const send = async () => { throw unknownOnMutation(); };
  await assert.rejects(gqlWrite(profile('d'), 't', '{ Auth { x } }', {}, send), /expects a document starting/);
});

test('gql flags a real Apollo validation body so gqlWrite recognises it (stubbed fetch)', async () => {
  const real = global.fetch;
  global.fetch = async () => ({
    json: async () => ({
      errors: [{ message: 'Cannot query field "Auth" on type "Mutation".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }],
    }),
  });
  try {
    await assert.rejects(gql(profile('http://h'), 't', MUT), (e) => e.malformed === true && e.graphqlErrors.length === 1);
    const bodies = [];
    global.fetch = async (_u, init) => {
      const q = JSON.parse(init.body).query;
      bodies.push(q.trimStart().split(/\W/)[0]);
      return {
        json: async () =>
          q.trimStart().startsWith('mutation')
            ? { errors: [{ message: 'Cannot query field "Auth" on type "Mutation".', extensions: { code: 'GRAPHQL_VALIDATION_FAILED' } }] }
            : { data: { Auth: { changePassword: { error: null } } } },
      };
    };
    const data = await gqlWrite(profile('http://h2'), 't', MUT, {});
    assert.equal(data.Auth.changePassword.error, null);
    assert.deepEqual(bodies, ['mutation', 'query']);
  } finally {
    global.fetch = real;
  }
});

test('the form is cached per root field: Node can be a mutation while Miner is still a query', async () => {
  const NODE = 'mutation { Node { stop { error { message } } } }';
  const MINER = 'mutation { Miner { stop { error { message } } } }';
  const calls = [];
  const send = async (_p, _t, doc) => {
    calls.push(`${doc.trimStart().split(/\W/)[0]}:${/\{\s*(\w+)/.exec(doc.replace(/^\s*\w+/, ''))[1]}`);
    // a 2.1.4-like schema: Node is a mutation, Miner exists only as a query
    if (doc.trimStart().startsWith('mutation') && doc.includes('Miner')) {
      throw validation('Cannot query field "Miner" on type "Mutation".');
    }
    return {};
  };
  await gqlWrite(profile('mixed'), 't', NODE, {}, send);
  await gqlWrite(profile('mixed'), 't', MINER, {}, send);
  await gqlWrite(profile('mixed'), 't', MINER, {}, send);
  assert.deepEqual(calls, ['mutation:Node', 'mutation:Miner', 'query:Miner', 'query:Miner']);
});
