const { gql } = require('../lib/api');
const { devicePassword, howToStore } = require('../lib/secrets');

const CHANGE = `query($input: AuthChangePasswordInput!) {
  Auth { changePassword(input: $input) { error { message } } }
}`;
const LOGIN = `query($input: AuthLoginInput!) {
  Auth { login(input: $input) { result { accessToken } error { message } } }
}`;

// Changes the real device password, then puts it back.
//
// It needs to be told the current one, because the only way to end where it
// started is to set it back explicitly: restoring the database would put back
// the hash the dashboard checks, while the Linux user would keep the password
// this run set — the two would silently disagree. So it is skipped unless the
// operator supplies it, and it never appears in the profile or on a command
// line, only in the environment of the run.
module.exports = {
  name: 'password',
  risk: 3,
  async run({ profile, token, assert, skip }) {
    const original = devicePassword();
    if (!original) {
      return skip(`store the device's current password first:\n      ${howToStore('device-password')}`);
    }

    const temporary = `acceptance-${Date.now()}`;

    const before = await gql(profile, token, LOGIN, { input: { password: original } });
    assert(
      !!before.Auth.login.result?.accessToken,
      'the supplied password is the one the device currently has'
    );

    const changed = await gql(profile, token, CHANGE, { input: { password: temporary } });
    assert(changed.Auth.changePassword.error === null, 'the password was changed');

    // From here the device is on a generated password, so every path out of this
    // block has to put the old one back — including a failing assertion. The
    // alternative is the exact divergence this check exists to prevent: the
    // snapshot restores the hash the dashboard checks, while the Linux user
    // keeps the password this run set.
    let back;
    try {
      const stale = await gql(profile, token, LOGIN, { input: { password: original } });
      assert(!stale.Auth.login.result, 'the old password stopped working');

      const fresh = await gql(profile, token, LOGIN, { input: { password: temporary } });
      assert(!!fresh.Auth.login.result?.accessToken, 'the new password logs in');
    } finally {
      back = await gql(profile, token, CHANGE, { input: { password: original } });
    }
    assert(back.Auth.changePassword.error === null, 'the original password was restored');

    const final = await gql(profile, token, LOGIN, { input: { password: original } });
    assert(!!final.Auth.login.result?.accessToken, 'the device is back on its own password');

    return { restored: true };
  },
};
