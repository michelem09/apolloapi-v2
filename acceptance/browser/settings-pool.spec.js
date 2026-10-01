const { test, expect } = require('@playwright/test');
const { devicePassword } = require('../lib/secrets');

const PASSWORD = devicePassword();
const KIND = process.env.ACCEPTANCE_DEVICE_KIND;

// The pool panel, exercised WITHOUT saving.
//
// Deliberate: saving here rewrites miner_config and restarts the miner, which on
// a device that is actually mining costs real work and would point it at a pool
// nobody chose. The valuable part needs no save — that an edit lights the bar,
// that discarding puts the form back, and that the panel does not lose the
// user's pool on the way. Applying a pool is covered in the container tier,
// down to the binary's command line.
test.describe('settings — pool', () => {
  test.skip(!PASSWORD, 'set the device password in the keychain to drive the UI');
  // A Solo Node has no pools tab: settings/[tab].js maps solo|node|system|logs|
  // extra and falls back to the Solo tab for anything else, so this would wait
  // on a field that is never rendered rather than failing with a reason.
  test.skip(KIND === 'solo-node', 'a Solo Node has no pools tab');

  const signIn = async (page) => {
    await page.goto('/signin');
    await page.locator('input[type="password"]').fill(PASSWORD);
    await page.locator('button[type="submit"], button:has-text("Sign")').first().click();
    await page.waitForURL(/\/overview/, { timeout: 30000 });
  };

  test('editing lights the save bar, discarding puts the pool back', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings/pools');

    const username = page.locator('input[name="username"]').first();
    await expect(username).toBeVisible();

    const original = await username.inputValue();
    expect(original.length).toBeGreaterThan(0); // a configured device has one

    const save = page.getByRole('button', { name: /^Save$/ });
    const discard = page.getByRole('button', { name: /Discard/i });
    await expect(save).toBeHidden();

    await username.fill(`${original}-acceptance`);
    await expect(save).toBeVisible();
    await expect(discard).toBeVisible();

    // Discard is the only exit here: nothing on this device may be saved by a
    // check, and the bar must not survive it.
    await discard.click();
    await expect(username).toHaveValue(original);
    await expect(save).toBeHidden();
  });

  test('the miner keeps the pool it had', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings/pools');

    const username = page.locator('input[name="username"]').first();
    await expect(username).toBeVisible();
    const before = await username.inputValue();

    // A reload must show what the device holds, not what was typed and dropped.
    await page.reload();
    await expect(page.locator('input[name="username"]').first()).toHaveValue(before);
  });
});
