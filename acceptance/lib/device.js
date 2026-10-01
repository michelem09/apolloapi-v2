const { sshExec } = require('./ssh');

// What the device is, asked once and handed to every check.
//
// The plan called for deducing this rather than passing it in a profile: a run
// aimed at the wrong kind of unit is a class of mistake worth removing, and the
// device already knows. BOARD_NAME is the same source the UI and miner_start.sh
// read, so this agrees with them by construction.
const describeDevice = async (profile) => {
  const release = (await sshExec(profile, 'cat /etc/armbian-release 2>/dev/null || true')).stdout;
  const board = (release.match(/^BOARD_NAME="?([^"\n]+)/m) || [])[1] || '';

  const kind =
    board === 'Solo Node' ? 'solo-node' :
    board === 'Apollo 3' ? 'apollo-iii' :
    'apollo-legacy'; // the absence of a chassis identifies an Apollo I/II

  const { stdout: hostname } = await sshExec(profile, 'hostname');

  // Not every Apollo has the same services: a Solo Node runs ckpool and no
  // internal miner, a miner runs the miner and usually not ckpool.
  const hasInternalMiner = kind !== 'solo-node';

  return { board: board || '(none)', kind, hostname, hasInternalMiner };
};

module.exports = { describeDevice };
