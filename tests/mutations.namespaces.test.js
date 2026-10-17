const { graphql } = require('graphql');
const schema = require('../src/graphql/schema');

const hasAuth = (field) => field.astNode.directives.some((d) => d.name.value === 'auth');
const names = (type) => Object.keys(schema.getType(type).getFields()).sort();

// Actions that change state live under Mutation, never under Query: Apollo Client
// re-executes queries on a re-render.
describe('Auth / Pool / Settings keep their writes on the Mutation side', () => {
  it('leaves only reads under Query', () => {
    expect(names('AuthActions')).toEqual(['login', 'status']);
    expect(names('PoolActions')).toEqual(['list']);
    expect(names('SettingsActions')).toEqual(['list', 'read']);
  });

  it('exposes the writes under Mutation', () => {
    expect(names('AuthMutations')).toEqual(['changePassword', 'setup']);
    expect(names('PoolMutations')).toEqual(['create', 'delete', 'update', 'updateAll']);
    expect(names('SettingsMutations')).toEqual(['update']);
    ['Auth', 'Pool', 'Settings'].forEach((ns) => expect(schema.getMutationType().getFields()[ns]).toBeDefined());
  });

  it('keeps @auth on every write except Auth.setup, the one open action', () => {
    const open = [];
    ['AuthMutations', 'PoolMutations', 'SettingsMutations'].forEach((t) =>
      Object.entries(schema.getType(t).getFields()).forEach(([n, f]) => {
        if (!hasAuth(f)) open.push(`${t}.${n}`);
      })
    );
    expect(open).toEqual(['AuthMutations.setup']);
  });

  const SOURCES = {
    changePassword: 'mutation { Auth { changePassword(input: { password: "x" }) { error { message } } } }',
    'pools.create': 'mutation { Pool { create(input: { enabled: true, url: "u" }) { error { message } } } }',
    'pools.update': 'mutation { Pool { update(input: { id: 1 }) { error { message } } } }',
    'pools.updateAll': 'mutation { Pool { updateAll(input: { pools: [] }) { error { message } } } }',
    'pools.delete': 'mutation { Pool { delete(input: { id: 1 }) { error { message } } } }',
    'settings.update': 'mutation { Settings { update(input: { agree: true }) { error { message } } } }',
  };

  it.each(Object.entries(SOURCES))('%s is rejected without a token, before the resolver runs', async (_, source) => {
    const spy = jest.fn();
    const services = new Proxy({}, { get: () => new Proxy({}, { get: () => spy }) });
    const res = await graphql({ schema, source, contextValue: { services } });
    expect(res.errors?.[0].message).toMatch(/auth/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('Auth.setup still runs without a token (it refuses by itself once setup is done)', async () => {
    const setup = jest.fn().mockResolvedValue(undefined);
    const res = await graphql({
      schema,
      source: 'mutation { Auth { setup(input: { password: "pw" }) { error { message } } } }',
      contextValue: { services: { auth: { setup } } },
    });
    expect(res.errors).toBeUndefined();
    expect(setup).toHaveBeenCalledWith({ password: 'pw' });
    expect(res.data.Auth.setup.error).toBeNull();
  });

  it('the old query forms are gone', async () => {
    const res = await graphql({
      schema,
      source: 'query { Settings { update(input: { agree: true }) { error { message } } } }',
      contextValue: { services: {} },
    });
    expect(res.errors?.[0].message).toMatch(/Cannot query field "update"/);
  });
});

// Miner / Solo actions: Mutation first, the query fields survive only as
// deprecated aliases for UI bundles open across an update.
describe('Miner / Solo actions are Mutations, with guarded query aliases', () => {
  const ACTIONS = {
    Miner: ['start', 'stop', 'restart', 'resetBlockFoundFlag'],
    Solo: ['start', 'stop', 'restart'],
  };
  const service = { Miner: 'miner', Solo: 'solo' };
  const selection = { Miner: '{ error { message } }', Solo: '{ success error { message } }' };

  it('exposes the actions under Mutation, all with @auth', () => {
    expect(names('MinerMutations')).toEqual([...ACTIONS.Miner].sort());
    expect(names('SoloMutations')).toEqual([...ACTIONS.Solo].sort());
    ['MinerMutations', 'SoloMutations'].forEach((t) =>
      Object.values(schema.getType(t).getFields()).forEach((f) => expect(hasAuth(f)).toBe(true))
    );
    ['Miner', 'Solo'].forEach((ns) => expect(schema.getMutationType().getFields()[ns]).toBeDefined());
  });

  it('keeps the query fields only as @auth + @deprecated aliases', () => {
    Object.entries({ MinerActions: ACTIONS.Miner, SoloActions: ACTIONS.Solo }).forEach(([t, list]) =>
      list.forEach((n) => {
        const f = schema.getType(t).getFields()[n];
        expect(hasAuth(f)).toBe(true);
        expect(f.deprecationReason).toMatch(/Mutation/);
      })
    );
  });

  const cases = Object.entries(ACTIONS).flatMap(([ns, list]) => list.map((a) => [ns, a]));

  it.each(cases)('mutation %s.%s is rejected without a token, before the resolver runs', async (ns, a) => {
    const spy = jest.fn();
    const services = new Proxy({}, { get: () => new Proxy({}, { get: () => spy }) });
    const res = await graphql({ schema, source: `mutation { ${ns} { ${a} ${selection[ns]} } }`, contextValue: { services } });
    expect(res.errors?.[0].message).toMatch(/auth/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it.each(cases)('query alias %s.%s is rejected without a token, before the resolver runs', async (ns, a) => {
    const spy = jest.fn();
    const services = new Proxy({}, { get: () => new Proxy({}, { get: () => spy }) });
    const res = await graphql({ schema, source: `query { ${ns} { ${a} ${selection[ns]} } }`, contextValue: { services } });
    expect(res.errors?.[0].message).toMatch(/auth/i);
    expect(spy).not.toHaveBeenCalled();
  });

  // With a token (the directive reads ctx.user) both forms reach the same service call.
  it.each(cases)('%s.%s runs the service through the mutation and through the alias', async (ns, a) => {
    for (const kind of ['mutation', 'query']) {
      const fn = jest.fn().mockResolvedValue(undefined);
      const res = await graphql({
        schema,
        source: `${kind} { ${ns} { ${a} ${selection[ns]} } }`,
        contextValue: { isAuthenticated: true, services: { [service[ns]]: { [a]: fn } } },
      });
      expect(res.errors).toBeUndefined();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(res.data[ns][a].error).toBeNull();
    }
  });
});
