// The pools page as a user drives it. Selectors are the ones that worked on the
// 2.1.4 UI in the exploratory round: the solo switch is a label, the pool preset
// is the first <select>, and the save button is "Save" or "Save & Restart".

const soloSwitch = (page) => page.locator('label[for="solo"]');
const soloInput = (page) => page.locator('input#solo');
const presetSelect = (page) => page.locator('select').first();
const urlInput = (page) => page.locator('input[name="url"]').first();
const userInput = (page) => page.locator('input[name="username"]').first();
const walletInput = (page) => page.locator('input[name="wallet"]');

const openPools = async (j) => {
  await j.open('/settings/pools');
  await presetSelect(j.page).or(walletInput(j.page)).first().waitFor({ timeout: 20000 });
};

const setSolo = async (j, on) => {
  // The page only offers the switch when the node is synced (or solo is already
  // on). Absent and wanted off is fine; absent and wanted on is a finding.
  if ((await soloSwitch(j.page).count()) === 0) {
    if (!on) return;
    throw new Error('the solo switch is not on the page — the UI only offers it when the node is synced');
  }
  const now = await soloInput(j.page).isChecked().catch(() => null);
  if (now === on) return;
  await soloSwitch(j.page).click();
  await j.page.waitForTimeout(500); // the form swaps its fields; nothing to wait on
};

// Save, and let the page answer — with a toast, which one is not asserted:
// the wording differs between releases ("Settings saved." on 2.1.4, "Starting
// miner…" on 2.2), and the report lists them for a human to read. What the device
// did is the caller's to verify; a toast only says the front end got an answer.
const saveAndWait = async (j) => {
  const since = j.toastCount();
  await j.save();
  await j.settle(since, 12000);
  return since;
};

// A save bar only appears on a CHANGE. If the form already holds the target (a
// device left there by an earlier round, or the previous journey), typing the
// target again changes nothing and there is nothing to click. Move it somewhere
// else and apply that first, so the journey's own save is a real one.
const avoidNoop = async (j, target) => {
  if ((await userInput(j.page).inputValue()) !== target) return false;
  await userInput(j.page).fill(`${target}-pre`);
  await saveAndWait(j);
  await openPools(j);
  return true;
};

module.exports = { soloSwitch, soloInput, presetSelect, urlInput, userInput, walletInput, openPools, setSolo, saveAndWait, avoidNoop };
