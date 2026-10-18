const { test, expect } = require('../fixtures');
const C = require('../common');

const ENUM_OF = { core: { '28.1': 'core_28_1' }, knots: { '29.3': 'knots_29_3' } };

// Journey 10 — regression: a node software picked before the settings arrive.
//
// Settings → Node seeds its form from the settings query. A click made before that
// response lands is overwritten when it does, without a word: the selection
// reverts and the Save bar never appears. A real user on a slow link does exactly
// this, so the journey does it on purpose and reproducibly: the settings response
// is held for HOLD_MS by routing the GraphQL call, the version is clicked the
// moment its button is visible, and only after the held response has been
// delivered does it look at the page. Expected to FAIL on a build with the defect.
// Nothing is saved: the pending change is discarded.
const HOLD_MS = 4000;

test('a click before the settings arrive is kept', async ({ j }) => {
  const { core, knots } = j.cfg.nodeLegs;
  const current = (await C.currentSettings(j))?.nodeSoftware;
  const target = current === ENUM_OF.knots[knots]
    ? { family: 'core', version: core }
    : { family: 'knots', version: knots };

  await j.step('sign in', () => j.signIn());

  let released = null;
  await j.page.route('**/graphql', async (route) => {
    const body = route.request().postData() || '';
    if (/GET_SETTINGS/.test(body) && !released) {
      released = (async () => {
        await new Promise((r) => setTimeout(r, HOLD_MS));
        await route.continue();
      })();
      return released;
    }
    return route.continue();
  });

  const re = new RegExp(`^\\s*${target.version.replace('.', '\\.')}\\b`);
  const button = j.page.getByRole('button', { name: re });
  let clickedBeforeSettings = false;

  await j.step(`open Settings → Node and click ${target.family} ${target.version} at once`, async () => {
    await j.page.goto('/settings/node');
    await button.first().waitFor({ state: 'visible', timeout: 30000 });
    clickedBeforeSettings = released !== null; // the held request was issued and not yet answered
    await (target.family === 'knots' ? button.last() : button.first()).click();
    await j.shot('clicked-early');
  });

  await j.step('let the held settings response arrive, then look', async () => {
    j.must(released, 'the settings query was never seen: the page asks for something else now');
    await released;
    await j.page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await j.page.waitForTimeout(2500); // the form re-seeds itself in an effect after the response
    await j.shot('after-settings-arrived');
  });

  try {
    await j.step('the pick is still there: the Save bar is showing', async () => {
      j.must(clickedBeforeSettings, 'inconclusive: the settings had already arrived when the click happened');
      await expect(j.page.getByRole('button', { name: /^Save/ }).first()).toBeVisible({ timeout: 5000 });
    });
  } finally {
    // Never saved. Put the form back if the bar is up.
    const discard = j.page.getByRole('button', { name: /Discard/i });
    if (await discard.isVisible().catch(() => false)) await discard.click().catch(() => {});
  }
});
