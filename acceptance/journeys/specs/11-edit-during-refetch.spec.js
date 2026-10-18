const { test, expect } = require('../fixtures');
const C = require('../common');

// Journey 11 — regression probe: an edit made while the refetch after a save is
// still in flight.
//
// Hypothesis (from a round where a saved time zone never reached the device): the
// settings page reloads its settings after a save, and when that response lands
// it replaces the whole form, wiping whatever was picked in the meantime. A person
// on a slow link does exactly this: saves, then keeps going.
//
// Reproduced deterministically instead of by speed: Save the temperature unit,
// hold the settings refetch that follows with a route, pick a different time zone
// while it is held, release it, and look. The pick must survive, with the Save bar
// still up. If it does not, the defect exists. Nothing about the zone is saved: the
// pending change is discarded, and the unit is put back through the API.
const HOLD_MS = 5000;

const zoneSelect = (page) =>
  page.locator('select').filter({ has: page.locator('option', { hasText: 'Europe/Rome' }) });

test('a pick made while the post-save refetch is in flight survives it', async ({ j }) => {
  const startUnit = (await C.currentSettings(j))?.temperatureUnit;
  const flipped = startUnit === 'f' ? 'c' : 'f';
  const want = { f: /Fahrenheit/, c: /Celsius/ };

  await j.step('sign in', () => j.signIn());

  let armed = false;
  let heldIssued;
  const issued = new Promise((r) => { heldIssued = r; });
  let released = null;
  await j.page.route('**/graphql', async (route) => {
    const body = route.request().postData() || '';
    if (armed && !released && /GET_SETTINGS/.test(body)) {
      heldIssued();
      released = (async () => {
        await new Promise((r) => setTimeout(r, HOLD_MS));
        await route.continue();
      })();
      return released;
    }
    return route.continue();
  });

  try {
    await j.step('open Settings → System and change the temperature unit', async () => {
      await j.open('/settings/system');
      await j.page.getByLabel(want[flipped]).check({ force: true });
    });

    let chosen;
    await j.step('press Save without waiting, and pick a time zone while the refetch is held', async () => {
      armed = true;
      // Not j.save(): that waits for the save to finish, which is the thing to avoid here.
      await j.page.getByRole('button', { name: /^Save/ }).first().click();
      const seen = await Promise.race([issued.then(() => true), new Promise((r) => setTimeout(() => r(false), 20000))]);
      j.must(seen, 'inconclusive: no settings refetch followed the save, so there was nothing to race');
      const select = zoneSelect(j.page);
      await expect(select).toBeVisible();
      const current = await select.inputValue();
      const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
      chosen = values.find((v) => v && v !== current);
      await select.selectOption(chosen);
      await j.shot('zone-picked-during-refetch');
    });

    await j.step('release the refetch and let the page settle', async () => {
      await released;
      await j.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await j.page.waitForTimeout(2500); // the form re-seeds in an effect after the response
      await j.shot('after-refetch');
    });

    await j.step('the pick survived, and the Save bar is still up', async () => {
      const kept = await zoneSelect(j.page).inputValue();
      if (kept !== chosen) j.finding(`edit lost during refetch: the time zone picked while the settings refetch was in flight reverted from ${chosen} to ${kept}`);
      expect(kept, 'the time zone picked during the refetch').toBe(chosen);
      await expect(j.page.getByRole('button', { name: /^Save/ }).first()).toBeVisible({ timeout: 5000 });
    });
  } finally {
    // Never save the zone. Drop the pending pick, and put the unit back.
    const discard = j.page.getByRole('button', { name: /Discard/i });
    if (await discard.isVisible().catch(() => false)) await discard.click().catch(() => {});
    try {
      if ((await C.currentSettings(j))?.temperatureUnit !== startUnit) await C.updateSettings(j, { temperatureUnit: startUnit });
    } catch (err) {
      j.note('undoFailed', err.message);
    }
  }
});
