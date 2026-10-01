const { sshExec } = require('./ssh');

const MARKER = '/var/lib/apollo/ACCEPTANCE_OK';

// The one thing standing between this run and someone's working device.
//
// A run stops services, changes the device password, joins other networks and
// reboots. Pointed at a customer unit by a typo in a profile, that is damage,
// not a test — so the device itself has to opt in, out of band, by carrying a
// file that only someone with a shell on it can create.
const assertDeviceIsDisposable = async (profile) => {
  let marker;
  try {
    ({ stdout: marker } = await sshExec(profile, `cat ${MARKER} 2>/dev/null || true`));
  } catch (err) {
    throw new Error(`cannot reach ${profile.user}@${profile.host} over ssh: ${err.message}`);
  }

  if (!marker) {
    throw new Error(
      `refusing to run: ${profile.host} does not carry ${MARKER}.\n` +
      'This device has not been declared disposable. If it really is a test unit:\n' +
      `  ssh ${profile.user}@${profile.host} "echo 'acceptance test device' | sudo tee ${MARKER}"`
    );
  }

  const { stdout: hostname } = await sshExec(profile, 'hostname');
  return { hostname, marker };
};

module.exports = { assertDeviceIsDisposable, MARKER };
