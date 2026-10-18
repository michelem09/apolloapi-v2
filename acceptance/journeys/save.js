// "Save, and wait until the save is DONE", with the page and the clock injected so
// the rules can be tested without a browser.
//
// Two races taught these rules. A check on the device 0.1 s after the click read
// the old value because the bar still said "Saving…". And an edit made while the
// refetch after the previous save was in flight was wiped when it landed, so the
// next Save wrote something else. Hence: wait for the bar to be gone, and if the
// edit is no longer in the form when Save is about to be pressed, say so and stop
// rather than save a different thing.
const doSave = async ({ click, isBusy, stillThere, label = 'edit', timeoutMs = 45000, waitUntil, findings, stepNo = () => 0 }) => {
  if (stillThere && !(await stillThere())) {
    findings.push(`edit lost before save: ${label} was no longer in the form when Save was about to be pressed`);
    throw new Error(`edit lost before save (${label})`);
  }
  await click();
  const r = await waitUntil(async () => !(await isBusy()), { timeoutMs, everyMs: 300 });
  // A bar that never closes is a finding, not a failure: the device decides whether
  // the save happened.
  if (!r.ok) findings.push(`the save bar was still up ${timeoutMs / 1000} s after Save (step ${stepNo() + 1})`);
  return r.ok;
};

module.exports = { doSave };
