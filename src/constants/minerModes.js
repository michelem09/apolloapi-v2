/**
 * Single source of truth for the miner power modes.
 *
 * Two lists, on purpose:
 *
 * - `MINER_MODES` is the universe: what the DB CHECK and the GraphQL enum accept.
 *   It always includes `super_eco`, because settings can be restored onto another
 *   device and must keep loading.
 * - `availableMinerModes()` is what THIS device can actually run, and is what
 *   every consumer that offers or accepts a choice reads — the automation rule
 *   validator, the `miner.mode` signal descriptor (and through it the UI), and
 *   the MQTT select/command path. Do not re-list modes anywhere else.
 *
 * `super_eco` is Apollo III only. On Apollo I/II (and a Solo Node, which only
 * drives USB boards) the configurator would quietly fall back to `eco`, so
 * offering it would promise something the hardware does not do. When the
 * device cannot be identified (dev machine, CI) nothing is restricted.
 */
const { getDeviceFamily } = require('../deviceFamily');

const MINER_MODES = ['super_eco', 'eco', 'balanced', 'turbo', 'custom'];
const APOLLO_III_ONLY = ['super_eco'];

function availableMinerModes(family = getDeviceFamily()) {
  if (family === 'unknown' || family === 'apollo-iii') return [...MINER_MODES];
  return MINER_MODES.filter((mode) => !APOLLO_III_ONLY.includes(mode));
}

module.exports = { MINER_MODES, availableMinerModes };
