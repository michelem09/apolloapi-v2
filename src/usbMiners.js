const fs = require('fs');

/**
 * Are USB miners attached? The same question `miner_start.sh` asks before it
 * starts external hashboards: does `/dev/ttyACM*` match anything. Reused rather
 * than inferred from stat files, which only exist after the miner has run and so
 * say nothing while it is off (exactly when an automation rule wants to start it).
 *
 * The device nodes persist while a board is plugged in, whether or not the miner
 * runs, so this does not follow the miner's own start/stop. It can still blink
 * when a board re-enumerates (a USB reset, a hub hiccup), so a sighting counts
 * for GRACE_MS: a flap shorter than that never changes the answer.
 */
const GRACE_MS = 60 * 1000;

let lastSeenAt = null;

function devDir(env = process.env) {
  return env.APOLLO_USB_DEV_DIR || '/dev';
}

function hasUsbMiners(env = process.env, now = Date.now()) {
  let present = false;
  try {
    present = fs.readdirSync(devDir(env)).some((name) => name.startsWith('ttyACM'));
  } catch (e) {
    // Unreadable: treated as absent, but the grace window still applies.
  }
  if (present) lastSeenAt = now;
  return present || (lastSeenAt !== null && now - lastSeenAt < GRACE_MS);
}

const resetUsbMinersCache = () => {
  lastSeenAt = null;
};

module.exports = { hasUsbMiners, resetUsbMinersCache, GRACE_MS };
