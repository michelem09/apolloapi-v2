const { getMinerBoards, resetMinerBoards } = require('./minerBoards');

/**
 * Are USB miners attached? Delegates to the board registry (src/minerBoards.js):
 * a board is "attached" while it is known, including the 5 s..15 min it spends
 * `disconnected`, so a flap never changes the answer.
 *
 * This supersedes the 60 s GRACE_MS of the v2.2 version (a sighting-based grace
 * on the /dev/ttyACM* listing); the export is kept so callers and the forward
 * merge stay unchanged, but the registry's debounce/expiry do the work now.
 */
const GRACE_MS = 60 * 1000;

function hasUsbMiners(env = process.env, now = Date.now()) {
  const registry = getMinerBoards();
  registry.refreshSync({ env, now });
  return registry.snapshot().usbCount > 0;
}

const resetUsbMinersCache = () => resetMinerBoards();

module.exports = { hasUsbMiners, resetUsbMinersCache, GRACE_MS };
