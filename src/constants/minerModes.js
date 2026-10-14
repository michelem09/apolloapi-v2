/**
 * Single source of truth for the miner power modes.
 *
 * Every consumer reads from here — the automation rule validation, the
 * `miner.mode` signal descriptor, and (through that descriptor) the UI. Do not
 * re-list these anywhere else.
 *
 * `super_eco` is Apollo III only, but it is listed for every device: on Apollo
 * I/II the configurator already falls back to `eco`. A per-device list is
 * deferred; when it lands, make it device-aware in this one place and every
 * consumer follows automatically.
 */
const MINER_MODES = ['super_eco', 'eco', 'balanced', 'turbo', 'custom'];

module.exports = { MINER_MODES };
