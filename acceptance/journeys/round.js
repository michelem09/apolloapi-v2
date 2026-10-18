// One round of user journeys: snapshot, run each, and owe the device its state
// back at the end no matter what happened in between.
//
// Pure orchestration. Every collaborator comes in through `deps`, which is what
// lets test/journeys-round.test.js prove the ordering — restore, then password,
// then miner off, then the final check — on a round where a journey throws, where
// the restore throws, and where both do.

const safely = async (fn, label) => {
  try {
    return await fn();
  } catch (err) {
    return { errors: [`${label}: ${err.message}`], threw: true };
  }
};

const runRound = async ({ journeys, deps, bail = false, log = () => {} }) => {
  const report = { journeys: [], restore: null, password: null, miner: null, final: null, drift: [], errors: [] };

  // If this fails nothing has been touched yet, so it is allowed to throw.
  const snap = await deps.snapshot();

  try {
    for (const journey of journeys) {
      log(`journey ${journey.id}`);
      const result = await safely(() => deps.runJourney(journey), `journey ${journey.id}`);
      const entry = result.threw
        ? { id: journey.id, name: journey.name, ok: false, durationMs: 0, error: result.errors[0] }
        : result;
      report.journeys.push(entry);

      // A failed journey leaves the device in an unknown place; the next one must
      // not start from there.
      if (!entry.ok && !entry.skipped) {
        const back = await safely(() => deps.restore(snap), 'restore after failure');
        entry.restoredAfterFailure = back;
        if (back.errors?.length) report.errors.push(...back.errors);
        if (bail) break;
      }
    }
  } finally {
    // The order below is the contract. Each step is guarded on its own, so one
    // that throws cannot skip the ones after it.
    report.restore = await safely(() => deps.restore(snap), 'restore');
    report.password = await safely(() => deps.password(), 'password');
    report.miner = await safely(() => deps.minerOff(), 'miner');
    report.final = await safely(() => deps.finalCheck(snap), 'final check');
  }

  report.drift = report.final?.drift ?? [];
  for (const part of [report.restore, report.password, report.miner, report.final]) {
    if (part?.errors?.length) report.errors.push(...part.errors);
  }

  const failed = report.journeys.some((j) => !j.ok && !j.skipped) || report.errors.length > 0 || report.drift.length > 0;
  const skipped = report.journeys.some((j) => j.skipped);
  report.exitCode = failed ? 1 : skipped ? 3 : 0;
  return report;
};

module.exports = { runRound };
