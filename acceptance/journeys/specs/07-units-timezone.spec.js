const { test, expect } = require('../fixtures');
const C = require('../common');

const zoneSelect = (page) =>
  page.locator('select').filter({ has: page.locator('option', { hasText: 'Europe/Rome' }) });

// Journey 7 — temperature unit and time zone, changed and put back.
//
// Both live in Settings → System. The unit is judged by the setting the API holds
// and by the Miner page's °F; the zone by timedatectl on the device (a dev
// backend only logs the change, so there the page is all that can be judged).
test('temperature unit and time zone', async ({ j }) => {
  await j.step('sign in', () => j.signIn());

  const startUnit = (await C.currentSettings(j))?.temperatureUnit;
  // The device's own answer when there is one; the page's, when there is not.
  let startZone = j.local ? null : await j.probes.timezone(j.ssh);
  j.note('start', { unit: startUnit, zone: startZone });

  const saveBar = async () => {
    const since = j.toastCount();
    await j.save();
    await j.settle(since, 12000);
  };

  try {
    // ---- temperature unit
    const flipped = startUnit === 'f' ? 'c' : 'f';
    const want = { f: /Fahrenheit/, c: /Celsius/ };
    await j.step(`switch the unit to ${flipped === 'f' ? '°F' : '°C'} and save`, async () => {
      await j.open('/settings/system');
      await j.page.getByLabel(want[flipped]).check({ force: true });
      await j.shot('unit-picked');
      await saveBar();
    });
    await j.verify(`the API holds temperatureUnit=${flipped}`, async () => {
      j.must((await C.currentSettings(j)).temperatureUnit === flipped, 'Settings.temperatureUnit did not change');
    });
    await j.step('the Miner page uses the new unit', async () => {
      await j.page.goto('/miner');
      await j.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      await j.shot('miner-page-unit');
      // The Miner page shows temperatures only while the miner reports them.
      const minerOn = j.local ? false : (await j.probes.unitState(j.ssh, 'apollo-miner')) === 'active';
      if (flipped === 'f' && minerOn) await expect(j.page.locator('body')).toContainText('°F', { timeout: 30000 });
      else if (flipped === 'f') j.finding('the Miner page was not checked for °F: the miner is not running, so it reports no temperatures');
    });
    await j.step('put the unit back', async () => {
      await j.open('/settings/system');
      await j.page.getByLabel(want[flipped === 'f' ? 'c' : 'f']).check({ force: true });
      await saveBar();
    });
    await j.verify('the API holds the original unit', async () => {
      j.must((await C.currentSettings(j)).temperatureUnit === startUnit, 'the unit did not go back');
    });

    // ---- time zone
    let target;
    await j.step('pick another time zone and save', async () => {
      await j.open('/settings/system');
      const select = zoneSelect(j.page);
      await expect(select).toBeVisible();
      const current = await select.inputValue();
      startZone = startZone || current;
      const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
      // From what the page offers: the device and the dev backend do not list the same names.
      target = values.find((v) => v && v !== current && v !== 'UTC') || values.find((v) => v && v !== current);
      await select.selectOption(target);
      await j.shot('zone-picked');
      const bar = j.page.getByRole('button', { name: /^Save/ }).first();
      await expect(bar).toBeVisible();
      await bar.click();
      // The bar has to close by itself; it once stayed lit on an applied change.
      await expect(bar).toBeHidden({ timeout: 30000 });
      await j.shot('zone-saved');
    });
    await j.verify('timedatectl follows the choice', async () => {
      const now = await j.probes.timezone(j.ssh);
      j.must(now === target, `timedatectl reports ${now}, wanted ${target}`);
    });
    await j.step('put the time zone back', async () => {
      await j.open('/settings/system');
      const select = zoneSelect(j.page);
      if ((await select.inputValue()) !== startZone && startZone) {
        await select.selectOption(startZone);
        const bar = j.page.getByRole('button', { name: /^Save/ }).first();
        await bar.click();
        await expect(bar).toBeHidden({ timeout: 30000 });
      }
    });
    await j.verify('timedatectl is back on the original zone', async () => {
      const now = await j.probes.timezone(j.ssh);
      j.must(now === startZone, `timedatectl reports ${now}, wanted ${startZone}`);
    });
  } finally {
    try {
      if ((await C.currentSettings(j))?.temperatureUnit !== startUnit) await C.updateSettings(j, { temperatureUnit: startUnit });
    } catch (err) {
      j.note('undoFailed', err.message);
    }
    if (!j.local) {
      try {
        if ((await j.probes.timezone(j.ssh)) !== startZone) {
          await j.gqlWrite(
            `mutation($input: McuSetTimezoneInput!) { Mcu { setTimezone(input: $input) { error { message } } } }`,
            { input: { timezone: startZone } }
          );
        }
      } catch (err) {
        j.note('undoFailed', err.message);
      }
    }
  }
});
