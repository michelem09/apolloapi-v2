const fs = require('fs');
const path = require('path');
const { test, expect } = require('../fixtures');
const { storeTemporary, deleteTemporary } = require('../keychain');

const LOGIN = `query($input: AuthLoginInput!) {
  Auth { login(input: $input) { result { accessToken } error { message } } }
}`;
const CHANGE = `mutation($input: AuthChangePasswordInput!) {
  Auth { changePassword(input: $input) { error { message } } }
}`;

// Journey 8 — change the device password from the UI, sign out and in with the
// new one, then put the original back from the UI.
//
// The temporary password is stored in the keychain before the device hears of it.
// If the UI path fails, the original is restored through the API (the run's token
// is minted from the device's secret, so it works whatever the password is). The
// temporary one is deleted only once the original is confirmed — on the dashboard
// AND on the Linux user.
test('password: change, sign in, change back', async ({ j }) => {
  const original = j.password();
  if (!original) j.skip('store the device password first (see the README)');

  const login = async (pw) => !!(await j.gql(LOGIN, { input: { password: pw } })).Auth.login.result?.accessToken;
  const viaApi = async (pw) => {
    const out = await j.gqlWrite(CHANGE, { input: { password: pw } });
    if (out.Auth.changePassword.error) throw new Error(out.Auth.changePassword.error.message);
  };
  const changeInUi = async (pw, label) => {
    await j.open('/settings/system');
    const inputs = j.page.locator('input[type="password"]');
    await inputs.first().waitFor({ timeout: 20000 });
    j.must((await inputs.count()) >= 2, `expected two password inputs, found ${await inputs.count()}`);
    await inputs.nth(0).fill(pw);
    await inputs.nth(1).fill(pw);
    await j.shot(`${label}-filled`);
    const since = j.toastCount();
    // The password save gave no toast at all on 2.1.4, so the response is what
    // says it went through; toasts, if any, are only recorded.
    const answered = j.page.waitForResponse((r) => /changePassword/.test(r.request().postData() || ''), { timeout: 30000 });
    await j.save({ label: 'password', stillThere: async () => (await inputs.nth(0).inputValue()) === pw && (await inputs.nth(1).inputValue()) === pw });
    const res = await answered;
    j.must(!(await res.json()).data?.Auth?.changePassword?.error, 'Auth.changePassword answered with an error');
    await j.settle(since, 8000);
    await j.shot(`${label}-saved`);
  };

  await j.verify('the stored password is the device\'s current one (refusing to start otherwise)', async () => {
    j.must(await login(original), 'the keychain password does not log in');
  });
  if (j.local && !(await login(original))) j.skip('the local backend does not accept the configured password');

  const temporary = `acc-${Date.now().toString(36)}-Tmp`;
  storeTemporary(temporary);
  // Tells the parent that this round touched the password, even if this process
  // dies before the end: it will set the original again unconditionally.
  fs.writeFileSync(path.join(j.ctx.out, 'password.touched'), temporary.length.toString());

  let restored = false;
  try {
    await j.step('sign in', () => j.signIn(original));
    await j.step('change the password to the temporary one in Settings → System', () => changeInUi(temporary, 'to-temp'));

    await j.verify('the dashboard takes the new password and refuses the old', async () => {
      j.must(await login(temporary), 'the temporary password does not log in');
      j.must(!(await login(original)), 'the old password still logs in');
    });
    await j.verify('the Linux user has the new password', async () => {
      j.must(await j.probes.linuxPasswordMatches(j.ssh, temporary), 'getent shadow does not match the temporary password');
    });

    await j.step('sign out and sign in with the new password', async () => {
      await j.page.goto('/signout').catch(() => {});
      await j.page.context().clearCookies();
      await j.page.evaluate(() => window.localStorage.clear()).catch(() => {});
      await j.signIn(temporary);
      await expect(j.page).toHaveURL(/\/overview/);
      await j.shot('signed-in-with-temp');
    });

    await j.step('change it back in Settings → System', () => changeInUi(original, 'to-original'));
    restored = await login(original);
    j.must(restored, 'the original password does not log in after the UI restore');
    await j.verify('the Linux user is back on the original', async () => {
      j.must(await j.probes.linuxPasswordMatches(j.ssh, original), 'getent shadow does not match the original password');
    });
  } finally {
    if (!restored) {
      try {
        await viaApi(original);
        restored = await login(original);
        j.note('restoredViaApi', restored);
      } catch (err) {
        j.note('undoFailed', err.message);
      }
    }
    // Only now is the temporary one disposable.
    if (restored && (j.local || (await j.probes.linuxPasswordMatches(j.ssh, original).catch(() => false)))) {
      deleteTemporary();
    } else {
      j.note('keptTemporary', 'the original could not be confirmed everywhere: the temporary password stays in the keychain as device-password-temp');
    }
  }
});
