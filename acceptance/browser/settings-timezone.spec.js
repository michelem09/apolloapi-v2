const { test, expect } = require('@playwright/test');

const PASSWORD = process.env.ACCEPTANCE_DEVICE_PASSWORD;
// Against a dev instance the backend logs the timezone change instead of making
// it, so anything downstream of the system clock cannot be asserted there. The
// save bar and the caption are UI state and hold either way.
const REAL_DEVICE = process.env.ACCEPTANCE_REAL_DEVICE === '1';

test.skip(!PASSWORD, 'set ACCEPTANCE_DEVICE_PASSWORD to drive the UI');

// Never name a zone from memory: the list comes from `timedatectl` on a device
// and from the platform's own ICU data in dev, and they do not hold the same
// names — "UTC" is in one and not the other. Pick from what the page offers.
const anotherZone = async (select, current) => {
  const values = await select.locator('option').evaluateAll((os) => os.map((o) => o.value));
  const other = values.find((v) => v && v !== current);
  if (!other) throw new Error('the zone list offers nothing to switch to');
  return other;
};

// Signing in is the gate to everything else, so it is step one rather than a
// fixture: if it breaks, the rest of this file failing tells you nothing.
const signIn = async (page) => {
  await page.goto('/signin');
  await page.locator('input[type="password"]').fill(PASSWORD);
  await page.locator('button[type="submit"], button:has-text("Sign")').first().click();
  await page.waitForURL(/\/overview/, { timeout: 30000 });
};

test('signing in reaches the dashboard', async ({ page }) => {
  await signIn(page);
  await expect(page).toHaveURL(/\/overview/);
});

test('the timezone panel keeps naming the zone the device is on', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/system');

  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Europe/Rome' }) });
  await expect(select).toBeVisible();

  const current = await select.inputValue();
  const caption = page.getByText(/Device is on /);
  await expect(caption).toContainText(current);

  // Pick a different zone WITHOUT saving: the caption must still name the zone
  // the device is actually on. Bound to the pending selection, as it was, it
  // announced a change that had not happened.
  const other = await anotherZone(select, current);
  await select.selectOption(other);

  await expect(select).toHaveValue(other);
  await expect(caption).toContainText(current);
  await expect(caption).not.toContainText(`Device is on ${other}`);
});

// Verified to fail on the defect it guards only against a REAL device: in dev
// the backend logs the zone change instead of making it, and the baseline ends
// up right by a different route. Against a device it is the regression of
// 2026-09-30 — the bar stayed lit on a change already applied, until a reload.
test('saving a timezone closes the save bar without a reload', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings/system');

  const select = page.locator('select').filter({ has: page.locator('option', { hasText: 'Europe/Rome' }) });
  await expect(select).toBeVisible();
  const original = await select.inputValue();
  const target = await anotherZone(select, original);

  await select.selectOption(target);

  // The bar is the whole point of this test: it appears on a change…
  const save = page.getByRole('button', { name: /^Save$/ });
  await expect(save).toBeVisible();

  await save.click();

  // …and it has to go away by itself. It used to stay lit on a change that had
  // already been applied, until the page was reloaded.
  await expect(save).toBeHidden({ timeout: 30000 });

  // And on a real device the warning that a restart is owed must now be on
  // screen, because services already running keep logging the old zone.
  if (REAL_DEVICE) {
    await expect(page.getByText(/Restart the system/i)).toBeVisible();
  }

  // Put the device back where it was found — but only if it actually moved.
  // In dev the backend logs the change instead of making it, so the panel
  // settles back on the original and there is nothing to undo; asking for the
  // bar then would wait for a change that never happened.
  if ((await select.inputValue()) !== original) {
    await select.selectOption(original);
    const back = page.getByRole('button', { name: /^Save$/ });
    // Tolerant on purpose: whether picking the original counts as a change
    // depends on where the baseline ended up, and this step is housekeeping —
    // it must put the device back, not assert about the bar a second time.
    if (await back.isVisible().catch(() => false)) {
      await back.click();
      await expect(back).toBeHidden({ timeout: 30000 });
    }
  }
});
