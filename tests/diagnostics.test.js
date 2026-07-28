const { scrubValue, scrubText, maskBtcAddresses } = require('../src/services/diagnostics/redact');
const createDiagnostics = require('../src/services/diagnostics');

// The bundle is built to be SENT to someone. A regression in this file is a privacy
// incident, not a bug, so the guarantees are asserted explicitly rather than assumed
// from the shape of the code.

const MAINNET_P2PKH = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const MAINNET_P2SH = '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy';
const BECH32 = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

describe('diagnostics redaction — bitcoin addresses', () => {
  it('masks every address form, keeping only 4+4 for correlation', () => {
    const text = `payout ${MAINNET_P2PKH} and ${MAINNET_P2SH} and ${BECH32}`;
    const out = maskBtcAddresses(text);

    expect(out).not.toContain(MAINNET_P2PKH);
    expect(out).not.toContain(MAINNET_P2SH);
    expect(out).not.toContain(BECH32);
    expect(out).toContain('<btc:1A1z…vfNa>');
    expect(out).toContain('<btc:bc1q…5mdq>');
  });

  it('keeps two different addresses distinguishable inside one bundle', () => {
    const a = maskBtcAddresses(MAINNET_P2PKH);
    const b = maskBtcAddresses(MAINNET_P2SH);
    expect(a).not.toEqual(b);
  });

  it('leaves ordinary prose alone', () => {
    const prose = 'the miner restarted at 13:04 and the node resynced 3 blocks';
    expect(maskBtcAddresses(prose)).toBe(prose);
  });
});

describe('diagnostics redaction — secrets in free text', () => {
  it('strips key=value secrets as they appear in config files and logs', () => {
    const conf = [
      'rpcuser=bitcoinrpc',
      'rpcpassword=SUPERSECRET',
      'rpcauth=user:abc$def',
      'token=abcdef123456',
    ].join('\n');

    const out = scrubText(conf);

    expect(out).not.toContain('SUPERSECRET');
    expect(out).not.toContain('abc$def');
    expect(out).not.toContain('abcdef123456');
    expect(out).toContain('rpcpassword=[redacted]');
    expect(out).toContain('rpcuser=bitcoinrpc'); // not a secret, kept for support
  });

  it('strips a secret passed as a command argument, not just key=value', () => {
    // This is the real path a WiFi PSK takes into the journal: sudo logs the full
    // argv, and this release makes that journal survive reboots.
    const line =
      'sudo: futurebit : COMMAND=/usr/bin/nmcli dev wifi connect HomeNet password Sup3rSecretPSK';
    const out = scrubText(line);

    expect(out).not.toContain('Sup3rSecretPSK');
    expect(out).not.toContain('HomeNet'); // the SSID sits between "connect" and "password"
    expect(out).toContain('password [redacted]');
  });

  it('strips the wpa_supplicant psk and the SSID in its structured forms', () => {
    expect(scrubText('psk=abcdef123')).not.toContain('abcdef123');
    expect(scrubText('wlan0: SSID=HomeNet')).not.toContain('HomeNet');
    expect(scrubText('ssid: "HomeNet"')).not.toContain('HomeNet');
  });

  it('strips credentials embedded in a pool URL', () => {
    const out = scrubText('stratum+tcp://myworker:hunter2@pool.example.com:3333');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('myworker');
    expect(out).toContain('pool.example.com:3333');
  });
});

describe('diagnostics redaction — structures', () => {
  it('drops sensitive keys in camelCase and snake_case, at any depth', () => {
    const out = scrubValue({
      nodeRpcPassword: 'secret1',
      node_rpc_password: 'secret2',
      nested: { pools: [{ username: MAINNET_P2PKH, password: 'secret3' }] },
      apiKey: 'secret4',
      authorization: 'Bearer secret5',
    });

    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('secret1');
    expect(serialized).not.toContain('secret2');
    expect(serialized).not.toContain('secret3');
    expect(serialized).not.toContain('secret4');
    expect(serialized).not.toContain('secret5');
    // the pool username is a payout address → masked, not dropped
    expect(out.nested.pools[0].username).toBe('<btc:1A1z…vfNa>');
  });

  it('removes the WiFi network name (identifying, not secret)', () => {
    const out = scrubValue({ connectedWifi: 'MyHomeNetwork', connected_wifi: 'MyHomeNetwork' });
    expect(out.connectedWifi).toBe('[redacted]');
    expect(out.connected_wifi).toBe('[redacted]');
  });

  it('catches an address hiding in an innocuously-named field', () => {
    const out = scrubValue({ notes: `send to ${MAINNET_P2PKH} please` });
    expect(out.notes).not.toContain(MAINNET_P2PKH);
  });

  it('preserves the non-sensitive values support actually needs', () => {
    const out = scrubValue({ minerMode: 'balanced', fan: 70, enabled: true, nullish: null });
    expect(out).toEqual({ minerMode: 'balanced', fan: 70, enabled: true, nullish: null });
  });

  it('matches key WORDS, so a field merely containing "pass" survives', () => {
    // Substring matching blanked real diagnostic fields, and a silent [redacted]
    // makes support believe a secret was there.
    const out = scrubValue({
      bypassRoute: 'lan',
      passes: 3,
      compass: 'N',
      password: 'secret',
      node_rpc_password: 'secret',
      apiKey: 'secret',
    });

    expect(out.bypassRoute).toBe('lan');
    expect(out.passes).toBe(3);
    expect(out.compass).toBe('N');
    expect(out.password).toBe('[redacted]');
    expect(out.node_rpc_password).toBe('[redacted]');
    expect(out.apiKey).toBe('[redacted]');
  });
});

describe('diagnostic bundle', () => {
  const okDeps = () => ({
    mcu: {
      getVersion: jest.fn().mockResolvedValue({ installed: '2.2.0', available: '2.2.1' }),
      getStats: jest.fn().mockResolvedValue({ temperature: 55 }),
      getTimezone: jest.fn().mockResolvedValue('Europe/Rome'),
    },
    services: { getStats: jest.fn().mockResolvedValue({ result: [] }) },
    settings: {
      read: jest.fn().mockResolvedValue({ minerMode: 'eco', nodeRpcPassword: 'SUPERSECRET' }),
    },
    pools: {
      list: jest.fn().mockResolvedValue({
        pools: [{ url: 'stratum+tcp://pool.example.com:3333', username: MAINNET_P2PKH, password: 'x' }],
      }),
    },
    automation: {
      getConfig: jest.fn().mockResolvedValue({ enabled: true }),
      listEvents: jest.fn().mockResolvedValue([{ id: 1, message: 'off' }]),
    },
    node: {},
  });

  it('produces a downloadable, self-describing payload', async () => {
    const svc = createDiagnostics(null, okDeps());
    const out = await svc.bundle();

    expect(out.filename).toMatch(/^apollo-diagnostics-.*\.json$/);
    expect(out.sizeBytes).toBeGreaterThan(0);

    const parsed = JSON.parse(out.content);
    expect(parsed.bundleVersion).toBe(1);
    expect(parsed.privacy.redacted).toBe(true);
    expect(parsed.versions.installed).toBe('2.2.0');
  });

  it('never ships a secret or a bare address, end to end', async () => {
    const svc = createDiagnostics(null, okDeps());
    const { content } = await svc.bundle();

    expect(content).not.toContain('SUPERSECRET');
    expect(content).not.toContain(MAINNET_P2PKH);
    expect(content).toContain('<btc:1A1z…vfNa>');
  });

  it('still produces a bundle when a section fails', async () => {
    // A device with a stopped node / missing miner must still get support a bundle:
    // the broken section reports itself, the rest survives.
    const deps = okDeps();
    deps.settings.read = jest.fn().mockRejectedValue(new Error('settings table missing'));

    const { content } = await createDiagnostics(null, deps).bundle();
    const parsed = JSON.parse(content);

    expect(parsed.settings.error).toMatch(/settings table missing/);
    expect(parsed.versions.installed).toBe('2.2.0'); // unaffected
  });

  it('does not hang when a section never resolves', async () => {
    jest.useFakeTimers();
    try {
      const deps = okDeps();
      deps.mcu.getVersion = jest.fn(() => new Promise(() => {})); // never settles
      const svc = createDiagnostics(null, deps);

      const promise = svc.bundle();
      // The section timeout is the only thing standing between a wedged service and
      // a bundle the user can never generate.
      await jest.advanceTimersByTimeAsync(16000);
      const parsed = JSON.parse((await promise).content);

      expect(parsed.versions.error).toMatch(/timed out/);
    } finally {
      jest.useRealTimers();
    }
  });
});
