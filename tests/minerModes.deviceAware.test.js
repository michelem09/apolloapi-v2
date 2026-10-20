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
const { getDeviceFamily, parseBoardName, familyOf, resetDeviceFamilyCache } = require('../src/deviceFamily');
const { hasUsbMiners, resetUsbMinersCache } = require('../src/usbMiners');
const { EXPIRY_MS } = require('../src/minerBoards');
const { MINER_MODES, availableMinerModes } = require('../src/constants/minerModes');
const signals = require('../src/services/signals');
const { decide } = require('../src/services/automation/engine');

const ALL = ['super_eco', 'eco', 'balanced', 'turbo', 'custom'];
const NO_SUPER = ['eco', 'balanced', 'turbo', 'custom'];

// The three families plus "cannot tell". `release` is the armbian-release body
// (null: no such file, as on a dev machine or in CI).
const FAMILIES = {
  'apollo-iii': { release: 'BOARD_NAME="Apollo 3"\n', modes: ALL },
  legacy: { release: 'BOARD=orangepi4-lts\nBOARD_NAME="FutureBit Apollo II"\n', modes: NO_SUPER },
  // An Apollo III whose armbian-release was reset to stock must not lose super_eco.
  'stock-board': { release: 'BOARD=rock-5b-plus\nBOARD_NAME="Rock 5B Plus"\n', modes: ALL },
  // A Solo Node only has modes while USB miners are attached.
  'solo-node': { release: "BOARD_NAME='Solo Node'\n", usb: true, modes: NO_SUPER },
  'solo-node-no-usb': { release: "BOARD_NAME='Solo Node'\n", usb: false, modes: [] },
  unknown: { release: null, modes: ALL },
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apollo-family-'));
const originalEnv = process.env.ARMBIAN_RELEASE_FILE;
const originalUsb = process.env.APOLLO_USB_DEV_DIR;

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
  usbMiners(!!FAMILIES[name].usb);
}

// Point the USB check at a fake /dev with or without a ttyACM node.
function usbMiners(present) {
  const dir = path.join(tmp, `dev-${present ? 'usb' : 'empty'}`);
  fs.mkdirSync(dir, { recursive: true });
  if (present) fs.writeFileSync(path.join(dir, 'ttyACM0'), '');
  process.env.APOLLO_USB_DEV_DIR = dir;
  resetUsbMinersCache();
}

afterAll(() => {
  if (originalUsb === undefined) delete process.env.APOLLO_USB_DEV_DIR;
  else process.env.APOLLO_USB_DEV_DIR = originalUsb;
  resetUsbMinersCache();
  if (originalEnv === undefined) delete process.env.ARMBIAN_RELEASE_FILE;
  else process.env.ARMBIAN_RELEASE_FILE = originalEnv;
  resetDeviceFamilyCache();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('device family detection (armbian-release BOARD_NAME)', () => {
  // What `. /etc/armbian-release` would leave in BOARD_NAME.
  it.each([
    ['double quotes', 'BOARD_NAME="Apollo 3"\n', 'Apollo 3'],
    ['single quotes', "BOARD_NAME='Solo Node'\n", 'Solo Node'],
    ['bare word', 'BOARD_NAME=foo\n', 'foo'],
    ['last assignment wins', 'BOARD_NAME=foo\nBOARD_NAME=bar\n', 'bar'],
    ['trailing comment after a bare word', 'BOARD_NAME=foo # stock\n', 'foo'],
    ['trailing comment after quotes', 'BOARD_NAME="Apollo 3" # set by installer\n', 'Apollo 3'],
    ['# inside quotes is data', 'BOARD_NAME="a # b"\n', 'a # b'],
    ['export prefix', 'export BOARD_NAME="Apollo 3"\n', 'Apollo 3'],
    ['leading whitespace', '   BOARD_NAME=foo\n', 'foo'],
    ['escaped quote in double quotes', 'BOARD_NAME="a\\"b"\n', 'a"b'],
    ['multi-word name with a trailing comment', 'BOARD_NAME="FutureBit Apollo II" # x\n', 'FutureBit Apollo II'],
    ['empty value is unset', 'BOARD_NAME=\n', null],
    ['empty quotes are unset', 'BOARD_NAME=""\n', null],
    ['a later empty assignment unsets an earlier one', 'BOARD_NAME=foo\nBOARD_NAME=\n', null],
    ['value that is only a comment is unset', 'BOARD_NAME=# nothing\n', null],
    ['KEY = value is not an assignment', 'BOARD_NAME = foo\n', null],
    ['another key is ignored', 'BOARD=x\n', null],
    ['a commented-out line is ignored', '# BOARD_NAME=foo\n', null],
  ])('parses: %s', (_name, text, expected) => {
    expect(parseBoardName(text)).toBe(expected);
  });

  it.each([
    ['FutureBit Apollo II', 'legacy'],
    ['FutureBit Apollo BTC', 'legacy'],
    ['FutureBit Apollo', 'legacy'],
    ['Apollo 3', 'apollo-iii'],
    ['Solo Node', 'solo-node'],
    ['FutureBit Apollo 3', 'unknown'], // names the III: never legacy
    ['FutureBit Apollo III', 'unknown'],
    ['FutureBit Apollonia', 'unknown'], // \b: not a word boundary match
    ['Rock 5B Plus', 'unknown'],
    ['Orange Pi Zero', 'unknown'],
    [null, 'unknown'],
  ])('familyOf(%s) is %s', (board, family) => {
    expect(familyOf(board)).toBe(family);
  });

  describe('cache', () => {
    it('does not cache unknown: a file that appears later is picked up', () => {
      const file = path.join(tmp, 'release-late');
      fs.rmSync(file, { force: true });
      process.env.ARMBIAN_RELEASE_FILE = file;
      resetDeviceFamilyCache();
      expect(getDeviceFamily()).toBe('unknown');
      fs.writeFileSync(file, 'BOARD_NAME="Apollo 3"\n');
      expect(getDeviceFamily()).toBe('apollo-iii');
    });

    it('caches a definite answer: the file is not read again', () => {
      const file = path.join(tmp, 'release-cached');
      fs.writeFileSync(file, 'BOARD_NAME="Apollo 3"\n');
      process.env.ARMBIAN_RELEASE_FILE = file;
      resetDeviceFamilyCache();
      expect(getDeviceFamily()).toBe('apollo-iii');
      fs.writeFileSync(file, 'BOARD_NAME="Solo Node"\n');
      expect(getDeviceFamily()).toBe('apollo-iii'); // still the cached answer
      resetDeviceFamilyCache();
      expect(getDeviceFamily()).toBe('solo-node');
    });
  });

  it.each(Object.keys(FAMILIES))('resolves %s', (name) => {
    asDevice(name);
    expect(getDeviceFamily()).toBe(
      { 'solo-node-no-usb': 'solo-node', 'stock-board': 'unknown' }[name] || name
    );
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

    it('eco is applied wherever any mode is, and ignored with a warn where none is', async () => {
      await output.handleCommand(output.modeCmdTopic, 'eco');
      if (modes.length) {
        expect(deps.settings.update).toHaveBeenCalledWith({ minerMode: 'eco' });
      } else {
        expect(deps.settings.update).not.toHaveBeenCalled();
        expect(logger.__calls.filter((c) => c.level === 'warn')).toHaveLength(1);
      }
    });

    it('never publishes a state outside the select options', async () => {
      deps.automation.getConfig.mockResolvedValue({ enabled: false });
      deps.settings.read.mockResolvedValue({ minerMode: 'super_eco' });
      deps.miner.getStats.mockResolvedValue({ stats: [] });
      const state = await output.buildMinerState();
      if (modes.includes('super_eco') || !modes.length) {
        expect(state.mode).toBe('super_eco');
      } else {
        expect(state.mode).toBe('eco'); // what the configurator applies
        expect(modes).toContain(state.mode);
      }
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
        await expect(result).rejects.toThrow(
          modes.length
            ? /"super_eco" is not available on this device \(available: eco, balanced, turbo, custom\)/
            : /no miner to run it \(no USB miner attached\)/
        );
      }
    });

    it('still rejects a mode that does not exist anywhere with the old message', async () => {
      await expect(automation.createRule(rule('ludicrous'))).rejects.toThrow(/Unknown miner mode/);
    });

    it('accepts a mode every device has — or says there is no miner to run one', async () => {
      const result = automation.createRule(rule('eco'));
      if (modes.length) await expect(result).resolves.toBeTruthy();
      else await expect(result).rejects.toThrow(/no miner to run it \(no USB miner attached\)/);
    });

    it('a rule that stops the miner is valid anywhere', async () => {
      await expect(
        automation.createRule({ ...rule('eco'), action: { type: 'off' } })
      ).resolves.toBeTruthy();
    });

    it('Settings.update validates a mode change against the device', async () => {
      const utils = require('../src/utils');
      const settingsService = require('../src/services/settings')(knex, utils);
      // The check is on a change: start from a stored mode that is not super_eco.
      await knex('settings').insert({ miner_mode: 'balanced', node_rpc_password: 'x', created_at: knex.fn.now() });
      const attempt = settingsService.update({ minerMode: 'super_eco' });
      if (modes.includes('super_eco')) {
        await expect(attempt).resolves.toBeDefined();
      } else {
        await expect(attempt).rejects.toThrow(/not available on this device|cannot be set/);
      }
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

  it('can be reordered, renamed, disabled and deleted; not re-enabled or given another invalid action', async () => {
    // Reordering an invalid enabled rule must not throw half-way through a swap.
    await expect(automation.updateRule(id, { priority: 20 })).resolves.toMatchObject({ priority: 20 });
    await expect(automation.updateRule(id, { name: 'renamed' })).resolves.toMatchObject({ name: 'renamed' });
    await expect(
      automation.updateRule(id, { action: { type: 'mode', mode: 'super_eco' } })
    ).rejects.toThrow(/not available on this device/);
    await expect(automation.updateRule(id, { enabled: false })).resolves.toMatchObject({ enabled: false });
    await expect(automation.updateRule(id, { enabled: true })).rejects.toThrow(/not available on this device/);
    await expect(automation.updateRule(id, { action: { type: 'mode', mode: 'eco' }, enabled: true })).resolves.toBeTruthy();
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

// A safety rule is too important to drop: with an unavailable mode it degrades to
// the lowest available one (what the configurator does for super_eco on legacy).
describe('a safety rule naming an unavailable mode', () => {
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
  const always = [{ signal: 'clock.time', op: 'between', values: ['00:00', '23:59'] }];

  beforeEach(async () => {
    jest.clearAllMocks();
    logger.__calls.length = 0;
    asDevice('apollo-iii');
    await knex('automation_events').del();
    await knex('automation_rules').del();
    await knex('automation_config')
      .where({ id: 1 })
      .update({ enabled: true, dry_run: true, fallback_action: 'keep', override_until: null });
  });

  it('degrades to the lowest available mode, and warns once per rule across ticks', async () => {
    const created = await automation.createRule({
      name: 'Throttle hard', is_safety: true, priority: 0, conditions: always,
      action: { type: 'mode', mode: 'super_eco' },
    });
    asDevice('legacy');

    const first = await automation.evaluate({ preview: true });
    expect(first.decision).toMatchObject({ reason: 'safety', ruleId: created.id, degradedFrom: 'super_eco' });
    expect(first.decision.target).toEqual({ type: 'mode', mode: 'eco' });

    await automation.evaluate({ preview: true });
    await automation.evaluate({ preview: true });
    const warns = logger.__calls.filter((c) => c.level === 'warn');
    expect(warns).toHaveLength(1);
    expect(warns[0].args[0]).toMatchObject({ ruleId: created.id, from: 'super_eco', to: 'eco' });
  });

  it('does not degrade where the mode exists', async () => {
    await automation.createRule({
      name: 'Throttle hard', is_safety: true, priority: 0, conditions: always,
      action: { type: 'mode', mode: 'super_eco' },
    });
    const out = await automation.evaluate({ preview: true });
    expect(out.decision.target).toEqual({ type: 'mode', mode: 'super_eco' });
    expect(out.decision.degradedFrom).toBeUndefined();
  });

  it('Settings.update only checks a change: an unrelated save resending a restored mode still works', async () => {
    const utils = require('../src/utils');
    const settingsService = require('../src/services/settings')(knex, utils);
    asDevice('apollo-iii');
    await settingsService.update({ minerMode: 'super_eco' });
    asDevice('legacy');
    await expect(settingsService.update({ minerMode: 'super_eco', minerHashrate: 10 })).resolves.toMatchObject({
      minerMode: 'super_eco',
      minerHashrate: 10,
    });
    await expect(settingsService.update({ minerMode: 'turbo' })).resolves.toMatchObject({ minerMode: 'turbo' });
    await expect(settingsService.update({ minerMode: 'super_eco' })).rejects.toThrow(/not available on this device/);
  });

  it('with no mode at all (Solo Node, no USB) it is skipped like a normal rule', async () => {
    await automation.createRule({
      name: 'Throttle hard', is_safety: true, priority: 0, conditions: always,
      action: { type: 'mode', mode: 'eco' },
    });
    asDevice('solo-node-no-usb');
    const out = await automation.evaluate({ preview: true });
    expect(out.decision.reason).toBe('fallback');
    expect(out.decision.evaluated[0]).toMatchObject({ matched: false, why: 'mode_unavailable' });
  });

  it('decide(): safety degrades, a normal rule is skipped', () => {
    const base = {
      signals: { 'clock.time': { value: '23:00', stale: false } },
      descriptors: { 'clock.time': { id: 'clock.time', type: 'time', ops: ['>'] } },
      config: { fallbackAction: 'keep', defaultHysteresis: 0 },
      state: { activeRuleId: null },
      now: new Date('2026-01-01T23:00:00Z'),
      availableModes: NO_SUPER,
    };
    const rule = (id, is_safety) => ({
      id, name: `r${id}`, enabled: true, priority: id, is_safety, match: 'all',
      conditions: [{ signal: 'clock.time', op: '>', value: '22:00' }],
      action: { type: 'mode', mode: 'super_eco' },
    });
    expect(decide({ ...base, rules: [rule(1, true)] }).target).toEqual({ type: 'mode', mode: 'eco' });
    expect(decide({ ...base, rules: [rule(1, false)] }).target).toBeNull();
  });
});

describe('USB miner detection (Solo Node)', () => {
  const dev = path.join(tmp, 'dev-flap');
  beforeEach(() => {
    fs.rmSync(dev, { recursive: true, force: true });
    fs.mkdirSync(dev, { recursive: true });
    process.env.APOLLO_USB_DEV_DIR = dev;
    resetUsbMinersCache();
  });

  it('looks for ttyACM nodes, as miner_start.sh does', () => {
    expect(hasUsbMiners()).toBe(false);
    fs.writeFileSync(path.join(dev, 'ttyUSB0'), '');
    expect(hasUsbMiners()).toBe(false);
    fs.writeFileSync(path.join(dev, 'ttyACM0'), '');
    expect(hasUsbMiners()).toBe(true);
  });

  // The board registry answers (a lost board stays "attached" for EXPIRY_MS, so a
  // blink or a replug never flips the modes), replacing the old 60 s sighting grace.
  it('a re-enumeration blink keeps the answer, a real unplug ends it once the board has expired', () => {
    fs.writeFileSync(path.join(dev, 'ttyACM0'), '');
    const t0 = 1_000_000;
    expect(hasUsbMiners(process.env, t0)).toBe(true);
    fs.rmSync(path.join(dev, 'ttyACM0'));
    // The absence is counted from the first reading that misses the board.
    expect(hasUsbMiners(process.env, t0 + 1000)).toBe(true); // blink: still present
    expect(hasUsbMiners(process.env, t0 + 1000 + EXPIRY_MS - 1)).toBe(true);
    expect(hasUsbMiners(process.env, t0 + 1000 + EXPIRY_MS + 1)).toBe(false); // gone for good
  });

  it('an unreadable dev dir counts as absent', () => {
    process.env.APOLLO_USB_DEV_DIR = path.join(tmp, 'does-not-exist');
    expect(hasUsbMiners()).toBe(false);
  });
});
