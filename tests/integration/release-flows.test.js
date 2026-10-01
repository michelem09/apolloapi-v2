const jwt = require('jsonwebtoken');
const config = require('config');
const { run, services, utils, knex } = require('./harness');
const childProcess = require('child_process');

// Release-gate flows: the things a user does on a device, driven through the
// REAL schema and the REAL services, with only the system boundary stubbed.
//
// These are the five flows that have actually cost us releases — setup, login,
// the device password, WiFi and the timezone — plus one sweep over the whole
// mutation surface. Unit tests say why something broke; this file says whether
// the product still works assembled.

const PROD = (fn) => async () => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    await fn();
  } finally {
    process.env.NODE_ENV = before;
  }
};

beforeEach(async () => {
  await knex('setup').del();
  jest.restoreAllMocks();
});

describe('release — first setup', () => {
  const STATUS = `{ Auth { status { result { status } error { message } } } }`;
  const SETUP = `query($in: AuthSetupInput!) {
    Auth { setup(input: $in) { error { message } } }
  }`;

  it('goes from pending to done, and the device password is set with it', PROD(async () => {
    const chpasswd = jest.spyOn(utils.auth, 'changeSystemPassword').mockResolvedValue();

    const before = await run(STATUS, { auth: false });
    expect(before.data.Auth.status.result.status).toBe('pending');

    const res = await run(SETUP, { variables: { in: { password: 'correct horse' } }, auth: false });
    expect(res.data.Auth.setup.error).toBeNull();

    const after = await run(STATUS, { auth: false });
    expect(after.data.Auth.status.result.status).toBe('done');

    // The lock screen and the system user are the same password: a setup that
    // writes only the DB leaves SSH on the factory one.
    expect(chpasswd).toHaveBeenCalledWith('correct horse');
  }));

  it('refuses a second setup — it is the one unauthenticated write there is', async () => {
    await run(SETUP, { variables: { in: { password: 'first' } }, auth: false });
    const again = await run(SETUP, { variables: { in: { password: 'second' } }, auth: false });

    expect(again.data?.Auth?.setup?.error?.message ?? again.errors?.[0]?.message).toMatch(/already done/i);
    expect(await knex('setup').count({ n: '*' }).first()).toEqual({ n: 1 });
  });
});

describe('release — login', () => {
  const LOGIN = `query($in: AuthLoginInput!) {
    Auth { login(input: $in) { result { accessToken } error { message } } }
  }`;

  const setupWith = async (password) => {
    process.env.NODE_ENV = 'test'; // no chpasswd outside production
    await run(`query($in: AuthSetupInput!) { Auth { setup(input: $in) { error { message } } } }`,
      { variables: { in: { password } }, auth: false });
  };

  it('issues a token the API itself accepts', async () => {
    await setupWith('letmein123');

    const res = await run(LOGIN, { variables: { in: { password: 'letmein123' } }, auth: false });
    const token = res.data.Auth.login.result.accessToken;

    // Verified the way the server verifies it, not merely "a non-empty string".
    const claims = jwt.verify(token, config.get('server.secret'), { audience: 'auth' });
    expect(claims.sub).toBe('apollouser');
  });

  it('refuses the wrong password', async () => {
    await setupWith('letmein123');
    const res = await run(LOGIN, { variables: { in: { password: 'letmein124' } }, auth: false });

    // The resolver catches and reports in the payload; a thrown GraphQL error
    // would be a different contract, and the UI reads this one.
    expect(res.data.Auth.login.result).toBeNull();
    expect(res.data.Auth.login.error.message).toMatch(/invalid password/i);
  });

  it('refuses to log in at all before setup', async () => {
    const res = await run(LOGIN, { variables: { in: { password: 'anything' } }, auth: false });

    expect(res.data.Auth.login.result).toBeNull();
    expect(res.data.Auth.login.error.message).toMatch(/setup not finished/i);
  });
});

describe('release — changing the device password', () => {
  const CHANGE = `query($in: AuthChangePasswordInput!) {
    Auth { changePassword(input: $in) { error { message } } }
  }`;
  const LOGIN = `query($in: AuthLoginInput!) {
    Auth { login(input: $in) { result { accessToken } error { message } } }
  }`;

  beforeEach(async () => {
    process.env.NODE_ENV = 'test';
    await run(`query($in: AuthSetupInput!) { Auth { setup(input: $in) { error { message } } } }`,
      { variables: { in: { password: 'old-password' } }, auth: false });
  });

  it('is refused without a token', async () => {
    const res = await run(CHANGE, { variables: { in: { password: 'new-password' } }, auth: false });

    expect(res.errors?.[0]?.message ?? res.data?.Auth?.changePassword?.error?.message).toBeTruthy();
    // and nothing changed: the old one still works
    const login = await run(LOGIN, { variables: { in: { password: 'old-password' } }, auth: false });
    expect(login.data.Auth.login.result.accessToken).toBeTruthy();
  });

  it('replaces the password end to end: the old one stops working, the new one logs in', async () => {
    const res = await run(CHANGE, { variables: { in: { password: 'new-password' } } });
    expect(res.data.Auth.changePassword.error).toBeNull();

    const stale = await run(LOGIN, { variables: { in: { password: 'old-password' } }, auth: false });
    expect(stale.data.Auth.login.error.message).toMatch(/invalid password/i);

    const fresh = await run(LOGIN, { variables: { in: { password: 'new-password' } }, auth: false });
    expect(fresh.data.Auth.login.result.accessToken).toBeTruthy();
  });

  it('carries the change to the system user in production', PROD(async () => {
    const chpasswd = jest.spyOn(utils.auth, 'changeSystemPassword').mockResolvedValue();

    await run(CHANGE, { variables: { in: { password: 'new-password' } } });

    expect(chpasswd).toHaveBeenCalledWith('new-password');
  }));
});

describe('release — WiFi', () => {
  const CONNECT = `mutation($in: McuWifiConnectInput!) {
    Mcu { wifiConnect(input: $in) { result { address } error { message } } }
  }`;
  const DISCONNECT = `mutation($if: String!) { Mcu { wifiDisconnect(ifname: $if) { error { message } } } }`;
  const FORGET = `mutation($u: String!) { Mcu { wifiForget(uuid: $u) { error { message } } } }`;

  // The boundary is `spawn` itself, not our runner: index.js captures `run` at
  // require time, so spying on the module afterwards changes nothing — and the
  // property worth asserting is what reaches the operating system anyway.
  const spawned = () =>
    childProcess.spawn.mock.calls.filter((c) => c[0] === 'nmcli' || String(c[0]).endsWith('nmcli'));

  beforeEach(() => {
    childProcess.spawn.mockImplementation(() => {
      const listeners = {};
      const out = [];
      setImmediate(() => {
        out.forEach((h) => h(''));
        if (listeners.close) listeners.close(0);
      });
      return {
        stdout: { on: (_, h) => out.push(h) },
        stderr: { on: () => {} },
        on: (event, handler) => { listeners[event] = handler; },
      };
    });
  });

  // Driven at the service, not through GraphQL: joining a network ends in a
  // verification poll with a real-world window, and the service takes injectable
  // timeouts precisely so a test need not sit through it. The property under
  // test — the passphrase never becomes shell text — belongs to this layer; that
  // the operation is a mutation and needs a token is covered above and below.
  it('never puts the passphrase through a shell', async () => {
    const wifi = require('../../src/services/wifi')({ verifyTimeoutMs: 1, verifyIntervalMs: 1 });

    // (device, ssid, passphrase, opts) — the shape the resolver uses
    await wifi
      .connect('wlan0', 'Wiffy', 'p; rm -rf /', { hidden: false, band: null })
      .catch(() => {}); // it cannot succeed against a stub; what it SPAWNED is the point

    const calls = spawned();
    expect(calls.length).toBeGreaterThan(0);
    for (const [, argv, opts] of calls) {
      expect(Array.isArray(argv)).toBe(true); // argv array, never a command string
      expect(opts?.shell).toBeFalsy();
    }
    // the passphrase travels as its own element, intact — never concatenated
    expect(calls.flatMap(([, argv]) => argv)).toContain('p; rm -rf /');
  });

  it('disconnecting keeps the saved network — forgetting is a different verb', async () => {
    await run(DISCONNECT, { variables: { if: 'wlan0' } });

    // The old implementation deleted every saved profile here.
    for (const [, argv] of spawned()) {
      expect(argv.join(' ')).not.toMatch(/\bdelete\b/);
    }
  });

  it('forgetting deletes exactly the one network asked for', async () => {
    await run(FORGET, { variables: { u: 'uuid-of-one-network' } });

    const deletes = spawned().filter(([, argv]) => argv.includes('delete'));
    expect(deletes).toHaveLength(1);
    expect(deletes[0][1]).toContain('uuid-of-one-network');
  });
});

describe('release — timezone', () => {
  const READ = `{ Mcu { timezone { result { timezone available rebootPending } error { message } } } }`;
  const SET = `mutation($in: McuSetTimezoneInput!) {
    Mcu { setTimezone(input: $in) { result { timezone } error { message } } }
  }`;

  it('reports the zone, the list and whether a restart is still owed', async () => {
    jest.spyOn(services.mcu, 'getTimezone').mockResolvedValue({
      timezone: 'Europe/Rome',
      available: ['Europe/Rome', 'UTC'],
      rebootPending: true,
    });

    const res = await run(READ);

    expect(res.data.Mcu.timezone.result).toEqual({
      timezone: 'Europe/Rome',
      available: ['Europe/Rome', 'UTC'],
      rebootPending: true,
    });
  });

  it('writes through a mutation, not a query', async () => {
    const spy = jest.spyOn(services.mcu, 'setTimezone').mockResolvedValue({
      timezone: 'Europe/Rome', available: ['Europe/Rome'], rebootPending: true,
    });

    const res = await run(SET, { variables: { in: { timezone: 'Europe/Rome' } } });

    expect(res.errors).toBeUndefined();
    expect(spy).toHaveBeenCalledWith({ timezone: 'Europe/Rome' });
  });
});

describe('release — nothing side-effectful is reachable without a token', () => {
  // Mechanical, straight from the schema: every field of McuMutations must
  // refuse an anonymous caller. A new mutation added without @auth fails here
  // the day it lands, instead of shipping.
  const { schema } = require('./harness');
  const {
    isNonNullType, isListType, isEnumType, isInputObjectType, isScalarType,
  } = require('graphql');

  // The smallest value the schema will accept for a type, so the request gets
  // past validation and actually reaches the auth check — which is the only
  // thing under test here.
  const minimal = (type) => {
    if (isNonNullType(type)) return minimal(type.ofType);
    if (isListType(type)) return [];
    if (isEnumType(type)) return type.getValues()[0]?.name ?? null;
    if (isInputObjectType(type)) {
      const out = {};
      for (const [name, field] of Object.entries(type.getFields())) {
        if (isNonNullType(field.type)) out[name] = minimal(field.type);
      }
      return out;
    }
    if (isScalarType(type)) {
      if (type.name === 'Int' || type.name === 'Float') return 0;
      if (type.name === 'Boolean') return false;
      return '';
    }
    return null;
  };

  const fields = schema.getType('McuMutations').getFields();

  it.each(Object.keys(fields))('McuMutations.%s refuses an anonymous caller', async (name) => {
    const field = fields[name];
    const defs = field.args.map((a) => `$${a.name}: ${a.type.toString()}`).join(', ');
    const call = field.args.map((a) => `${a.name}: $${a.name}`).join(', ');
    const variables = Object.fromEntries(field.args.map((a) => [a.name, minimal(a.type)]));

    const res = await run(
      `mutation${defs ? `(${defs})` : ''} { Mcu { ${name}${call ? `(${call})` : ''} { error { message } } } }`,
      { variables, auth: false }
    );

    const message = res.errors?.[0]?.message ?? res.data?.Mcu?.[name]?.error?.message ?? '';
    expect(message).toMatch(/auth|token|unauthenticated/i);
  });
});
