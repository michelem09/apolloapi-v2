const { execFileSync } = require('child_process');

const SERVICE = 'apollo-acceptance';

// Secrets come from the operating system's own store, or from the environment —
// never from the profile.
//
// Not ceremony: the profile sits in the working tree, and a file there is one
// `git add -f`, one stray .gitignore edit or one screen share away from being
// public. The keychain hands the value to this process and to nothing else, and
// it is the same arrangement already in use for the ssh keys that every command
// in this suite rides on.
const fromKeychain = (account) => {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-s', SERVICE, '-a', account, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim() || null;
  } catch {
    return null; // not stored, or not macOS
  }
};

// The environment wins, so a one-off run can override without touching the store.
const secret = (envName, account) => process.env[envName] || fromKeychain(account) || null;

const devicePassword = () => secret('ACCEPTANCE_DEVICE_PASSWORD', 'device-password');
const wifiPassphrase = () => secret('ACCEPTANCE_WIFI_PASSPHRASE', 'wifi-passphrase');

const howToStore = (account) =>
  `security add-generic-password -s ${SERVICE} -a ${account} -w  # prompts, nothing in your shell history`;

module.exports = { devicePassword, wifiPassphrase, howToStore, SERVICE };
