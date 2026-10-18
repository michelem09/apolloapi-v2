const { execFileSync } = require('child_process');
const { SERVICE } = require('../lib/secrets');

// The temporary password goes into the keychain BEFORE the device is told about
// it: if the run dies between the two, the only copy of the password the device
// now has is in a place a person can find it.
//
// `security -i` reads the command from stdin, so the value is not part of any
// process's argument list while it is being stored.
const TEMP_ACCOUNT = 'device-password-temp';

const storeTemporary = (value) => {
  if (!/^[A-Za-z0-9-]+$/.test(value)) throw new Error('the temporary password must be [A-Za-z0-9-] only');
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${SERVICE} -a ${TEMP_ACCOUNT} -w ${value}\n`,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
};

const deleteTemporary = () => {
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', TEMP_ACCOUNT], { stdio: 'ignore' });
  } catch { /* not there */ }
};

module.exports = { storeTemporary, deleteTemporary, TEMP_ACCOUNT };
