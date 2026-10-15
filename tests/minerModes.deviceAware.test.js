const fs = require('fs');
const os = require('os');
const path = require('path');
const { knex } = require('../src/db');

// Capture the logger so the MQTT "ignored with one warn" contract is observable.
jest.mock('../src/logger', () => {
  const calls = [];
  const record = (level) => (...args) => calls.push({ level, args });
  const logger = {
    trace: record('trace'),
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    fatal: record('fatal'),
    isLevelEnabled: () => false,
  };
  const factory = () => logger;
  factory.__calls = calls;
  return factory;
});

const logger = require('../src/logger');
const { getDeviceFamily, parseBoardName, resetDeviceFamilyCache } = require('../src/deviceFamily');
const { MINER_MODES, availableMinerModes } = require('../src/constants/minerModes');
const signals = require('../src/services/signals');
const { decide } = require('../src/services/automation/engine');

const ALL = ['super_eco', 'eco', 'balanced', 'turbo', 'custom'];
const NO_SUPER = ['eco', 'balanced', 'turbo', 'custom'];

// The three families plus "cannot tell". `release` is the armbian-release body
// (null: no such file, as on a dev machine or in CI).
const FAMILIES = {
  'apollo-iii': { release: 'BOARD_NAME="Apollo 3"\n', modes: ALL },
  legacy: { release: 'BOARD=orangepi\nBOARD_NAME="Orange Pi Zero"\n', modes: NO_SUPER },
  'solo-node': { release: "BOARD_NAME='Solo Node'\n", modes: NO_SUPER },
  unknown: { release: null, modes: ALL },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-family-'));
const originalEnv = process.env.ARMBIAN_RELEASE_FILE;

// Point the detection at a fake /etc/armbian-release for the given family.
function asDevice(name) {
  const { release } = FAMILIES[name];
  const file = path.join(tmp, `release-${name}`);
  if (release === null) {
    fs.rmSync(file, { force: true });
  } else {
    fs.writeFileSync(file, release);
  }
  process.env.ARMBIAN_RELEASE_FILE = file;
  resetDeviceFamilyCache();
}

afterAll(() => {
  if (originalEnv === undefined) delete process.env.ARMBIAN_RELEASE_FILE;
  else process.env.ARMBIAN_RELEASE_FILE = originalEnv;
  resetDeviceFamilyCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('device family detection (armbian-release BOARD_NAME)', () => {
  it('parses quoted, single-quoted and bare values, last assignment wins', () => {
    expect(parseBoardName('BOARD_NAME="Apollo 3"\n')).toBe('Apollo 3');
    expect(parseBoardName("BOARD_NAME='Solo Node'\n")).toBe('Solo Node');
    expect(parseBoardName('BOARD_NAME=foo\nBOARD_NAME=bar\n')).toBe('bar');
    expect(parseBoardName('BOARD=x\n')).toBeNull();
  });

  it.each(Object.keys(FAMILIES))('resolves %s', (name) => {
    asDevice(name);
    expect(getDeviceFamily()).toBe(name);
  });

  it('is unknown (not legacy) when the file has no BOARD_NAME', () => {
    const file = path.join(tmp, 'release-empty');
    fs.writeFileSync(file, 'VERSION=24\n');
    process.env.ARMBIAN_RELEASE_FILE = file;
    resetDeviceFamilyCache();
    expect(getDeviceFamily()).toBe('unknown');
  });
});

describe.each(Object.keys(FAMILIES))('miner modes on %s', (family) => {
  const { modes } = FAMILIES[family];

  beforeEach(() => asDevice(family));

  it('availableMinerModes follows the family; the universe never shrinks', () => {
    expect(availableMinerModes()).toEqual(modes);
    expect(MINER_MODES).toEqual(ALL);
  });

  it('the miner.mode descriptor (rule editor, fallback tiles) lists the same modes', () => {
    const d = signals.descriptors({}).find((x) => x.id === 'miner.mode');
    expect(d.options).toEqual(modes);
  });

  describe('MQTT', () => {
    const deps = {
      miner: {
        getStats: jest.fn(),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        restart: jest.fn().mockResolvedValue(undefined),
      },
      settings: { read: jest.fn(), update: jest.fn().mockResolvedValue(undefined) },
      automation: { getConfig: jest.fn() },
      mqtt: { getConfig: jest.fn() },
    };
    const output = require('../src/services/mqtt/output')(knex, deps);

    beforeEach(async () => {
      jest.clearAllMocks();
      logger.__calls.length = 0;
      deps.mqtt.getConfig.mockResolvedValue({ enabled: true, output: { enabled: true, control: true } });
      output.hasMiner = true;
      await knex('service_status').where({ service_name: 'miner' }).update({ status: 'offline' });
    });

    it('offers only the available modes in the HA select', () => {
      const select = output._entities('miner', { control: true }).find((c) => c.topic.includes('/select/'));
      expect(select.payload.options).toEqual(modes);
    });

    it('super_eco command: applied where available, ignored with exactly one warn elsewhere', async () => {
      await output.handleCommand(output.modeCmdTopic, 'super_eco');
      const warns = logger.__calls.filter((c) => c.level === 'warn');
      if (modes.includes('super_eco')) {
        expect(deps.settings.update).toHaveBeenCalledWith({ minerMode: 'super_eco' });
        expect(warns).toHaveLength(0);
      } else {
        expect(deps.settings.update).not.toHaveBeenCalled();
        expect(warns).toHaveLength(1);
        expect(warns[0].args[0]).toMatchObject({ mode: 'super_eco' });
      }
    });

    it('a mode every device has is always applied', async () => {
      await output.handleCommand(output.modeCmdTopic, 'eco');
      expect(deps.settings.update).toHaveBeenCalledWith({ minerMode: 'eco' });
    });
  });

  describe('automation', () => {
    const deps = {
      miner: {
        getStats: jest.fn().mockResolvedValue({ stats: [{ slots: { int_0: { temperature: 65 } } }] }),
        start: jest.fn().mockResolvedValue(undefined),
        stop: jest.fn().mockResolvedValue(undefined),
        restart: jest.fn().mockResolvedValue(undefined),
      },
      settings: {
        read: jest.fn().mockResolvedValue({ minerMode: 'balanced' }),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };
    const automation = require('../src/services/automation')(knex, deps);
    const rule = (mode, extra = {}) => ({
      name: 'Quiet night',
      conditions: [{ signal: 'clock.time', op: '>', value: '22:00' }],
      action: { type: 'mode', mode },
      ...extra,
    });

    beforeEach(async () => {
      await knex('automation_events').del();
      await knex('automation_rules').del();
      await knex('automation_config').where({ id: 1 }).update({ enabled: false, fallback_action: 'keep' });
    });

    it('validates a super_eco rule against the device', async () => {
      const result = automation.createRule(rule('super_eco'));
      if (modes.includes('super_eco')) {
        await expect(result).resolves.toBeTruthy();
      } else {
        await expect(result).rejects.toThrow(/"super_eco" is not available on this device \(available: eco, balanced, turbo, custom\)/);
      }
    });

    it('still rejects a mode that does not exist anywhere with the old message', async () => {
      await expect(automation.createRule(rule('ludicrous'))).rejects.toThrow(/Unknown miner mode/);
    });

    it('accepts a mode every device has', async () => {
      await expect(automation.createRule(rule('eco'))).resolves.toBeTruthy();
    });
  });
});

// A rule saved while the device could run super_eco (or restored from another
// device) and then loaded on one that cannot. Must not crash anything.
describe('a saved rule whose mode this device cannot run', () => {
  const deps = {
    miner: {
      getStats: jest.fn().mockResolvedValue({ stats: [{ slots: { int_0: { temperature: 65 } } }] }),
      start: jest.fn().mockResolvedValue(undefined),
      stop: jest.fn().mockResolvedValue(undefined),
      restart: jest.fn().mockResolvedValue(undefined),
    },
    settings: {
      read: jest.fn().mockResolvedValue({ minerMode: 'balanced' }),
      update: jest.fn().mockResolvedValue(undefined),
    },
  };
  const automation = require('../src/services/automation')(knex, deps);
  let id;

  beforeEach(async () => {
    jest.clearAllMocks();
    asDevice('apollo-iii');
    await knex('automation_events').del();
    await knex('automation_rules').del();
    await knex('automation_config').where({ id: 1 }).update({
      enabled: true,
      dry_run: false,
      fallback_action: 'keep',
      override_until: null,
    });
    // Always-true condition, so the rule would win if the engine did not skip it.
    const created = await automation.createRule({
      name: 'Always super eco',
      conditions: [{ signal: 'clock.time', op: 'between', values: ['00:00', '23:59'] }],
      action: { type: 'mode', mode: 'super_eco' },
    });
    id = created.id;
    asDevice('legacy');
  });

  it('still loads', async () => {
    const rules = await automation.listRules();
    expect(rules).toHaveLength(1);
    expect(rules[0].action.mode).toBe('super_eco');
  });

  it('is skipped by the engine as mode_unavailable and never applied', async () => {
    const out = await automation.evaluate({ preview: true });
    expect(out.decision.reason).toBe('fallback');
    expect(out.decision.target).toBeNull();
    expect(out.decision.evaluated[0]).toMatchObject({ ruleId: id, matched: false, why: 'mode_unavailable' });

    const real = await automation.evaluate();
    expect(real.applied).toBe(false);
    expect(deps.settings.update).not.toHaveBeenCalled();
  });

  it('on the device that supports it, the same rule matches and applies again', async () => {
    asDevice('apollo-iii');
    const out = await automation.evaluate({ preview: true });
    expect(out.decision.ruleId).toBe(id);
    expect(out.decision.target).toEqual({ type: 'mode', mode: 'super_eco' });
  });

  it('can be disabled and deleted, but not (re-)enabled or kept enabled while invalid', async () => {
    await expect(automation.updateRule(id, { name: 'renamed' })).rejects.toThrow(/not available on this device/);
    await expect(automation.updateRule(id, { enabled: false })).resolves.toMatchObject({ enabled: false });
    await expect(automation.updateRule(id, { enabled: true })).rejects.toThrow(/not available on this device/);
    await expect(automation.deleteRule(id)).resolves.toBe(true);
  });

  it('a fallback naming the unavailable mode degrades to keep', async () => {
    await automation.deleteRule(id);
    await knex('automation_config').where({ id: 1 }).update({ fallback_action: 'on:super_eco' });
    const out = await automation.evaluate({ preview: true });
    expect(out.decision.reason).toBe('fallback');
    expect(out.decision.target).toBeNull();
  });
});

describe('engine decide() with availableModes', () => {
  const base = {
    signals: { 'clock.time': { value: '23:00', stale: false } },
    descriptors: { 'clock.time': { id: 'clock.time', type: 'time', ops: ['>', '<'] } },
    config: { fallbackAction: 'keep', defaultHysteresis: 0 },
    state: { activeRuleId: null },
    now: new Date('2026-01-01T23:00:00Z'),
  };
  const r = (id, mode) => ({
    id,
    name: `r${id}`,
    enabled: true,
    priority: id,
    match: 'all',
    conditions: [{ signal: 'clock.time', op: '>', value: '22:00' }],
    action: { type: 'mode', mode },
  });

  it('skips an unavailable-mode rule and falls through to the next matching one', () => {
    const d = decide({ ...base, rules: [r(1, 'super_eco'), r(2, 'eco')], availableModes: NO_SUPER });
    expect(d.ruleId).toBe(2);
    expect(d.target).toEqual({ type: 'mode', mode: 'eco' });
  });

  it('does not restrict anything when availableModes is absent', () => {
    const d = decide({ ...base, rules: [r(1, 'super_eco'), r(2, 'eco')] });
    expect(d.ruleId).toBe(1);
  });
});
