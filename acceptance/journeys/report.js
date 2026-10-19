const fs = require('fs');
const path = require('path');

// The report is the product of a round as much as the exit code: the first run
// found its defects (a toast shown twice, labels cut off) by reading toasts and
// screenshots, not by an assertion failing. So every journey carries what it
// SAW — toasts in order, console errors, a screenshot per step — next to what it
// asserted.

const mark = (ok) => (ok ? 'PASS' : 'FAIL');
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// The same toast text twice at the same moment is a finding, not noise: the app
// fired the notification twice. `windowMs` is "the same moment"; the same text
// minutes apart is just the same event happening again. Without timestamps every
// repeat counts.
const duplicateToasts = (toasts, windowMs = 1500) => {
  const groups = new Map();
  for (const t of toasts) {
    const list = groups.get(t.text) || [];
    list.push(t);
    groups.set(t.text, list);
  }
  const out = [];
  for (const [text, list] of groups) {
    let best = 1;
    let run = 1;
    for (let i = 1; i < list.length; i += 1) {
      const close = list[i].ms === undefined || list[i - 1].ms === undefined || list[i].ms - list[i - 1].ms <= windowMs;
      run = close ? run + 1 : 1;
      best = Math.max(best, run);
    }
    if (best > 1) out.push({ text, count: best });
  }
  return out;
};

// What a person still has to do on the device after the round, said plainly. The
// last line of the report: whoever reads only that must know whether the device is
// safe. Empty is the only good answer.
const leftToDo = (report, meta = {}) => {
  if (meta.local) return [];
  const host = meta.host || '<device>';
  const todo = [];
  const m = report.miner || {};
  if (m.off !== true) {
    todo.push(`the miner may be running: ssh ${host} "sudo systemctl stop apollo-miner && sudo /opt/apolloapi/backend/apollo-miner/miner_stop.sh"`);
  } else if (m.scriptRan === false && !m.remedied) {
    todo.push(`run miner_stop.sh by hand (the board was not reset): ssh ${host} "sudo /opt/apolloapi/backend/apollo-miner/miner_stop.sh"`);
  }
  const p = report.password || {};
  if (p.loginOk !== true || p.linuxOk === false || (report.password === null || report.password?.threw)) {
    todo.push('the original password is NOT confirmed: check the dashboard login and `ssh` with it; if wrong, set it again (Settings → System, or the API with a minted token)');
  }
  if ((report.drift || []).length) todo.push(`undo the drift: ${report.drift.join('; ')}`);
  const restoreErrors = [...(report.restore?.errors || []), ...(report.restoreErrorsAfterFailure || [])];
  if (report.restore?.threw || restoreErrors.length) todo.push(`the restore did not finish cleanly: ${[...restoreErrors].join('; ') || 'it threw'}`);
  if (report.final?.threw) todo.push('the final check did not run: verify the device by hand');
  return todo;
};

const toMarkdown = (report, meta = {}) => {
  const L = [];
  L.push(`# Journey round — ${meta.host || 'device'} — ${meta.startedAt || ''}`);
  L.push('');
  const verdict = report.exitCode === 0 ? 'PASS' : report.exitCode === 3 ? 'SKIPS (proved nothing for those)' : 'FAIL';
  L.push(`**${verdict}** — ${report.journeys.length} journeys, ${secs(meta.durationMs || 0)}`);
  L.push('');
  L.push('| journey | result | time | toasts | console errors |');
  L.push('|---|---|---|---|---|');
  for (const j of report.journeys) {
    const res = j.skipped ? `SKIP (${j.skipped})` : mark(j.ok);
    L.push(`| ${j.id} ${j.name || ''} | ${res} | ${secs(j.durationMs || 0)} | ${(j.toasts || []).length} | ${(j.consoleErrors || []).length} |`);
  }
  for (const j of report.journeys) {
    L.push('');
    L.push(`## ${j.id} ${j.name || ''} — ${j.skipped ? 'SKIP' : mark(j.ok)}`);
    if (j.error) L.push(`\n> ${String(j.error).split('\n')[0]}`);
    if (j.skipped) L.push(`\nSkipped: ${j.skipped}`);
    for (const s of j.steps || []) {
      L.push(`- ${s.ok === null ? '–' : s.ok ? '✓' : '✗'} ${s.device ? '[device] ' : ''}${s.name} (${secs(s.ms || 0)})${s.detail ? ` — ${s.detail}` : ''}`);
    }
    const dups = duplicateToasts(j.toasts || []);
    if ((j.toasts || []).length) {
      L.push('', 'Toasts, in order:');
      for (const t of j.toasts) L.push(`- ${t.at}: ${t.text}`);
    }
    const findings = [
      ...(j.findings || []),
      ...dups.map((d) => `toast shown ${d.count}x at the same moment: "${d.text}"`),
    ];
    if (findings.length) {
      L.push('', 'Findings:');
      for (const f of findings) L.push(`- ${f}`);
    }
    if ((j.consoleErrors || []).length) {
      L.push('', 'Console errors:');
      for (const e of j.consoleErrors) L.push(`- ${e}`);
    }
    if ((j.shots || []).length) L.push('', `Screenshots: ${j.shots.map((s) => path.basename(s)).join(', ')}`);
  }
  L.push('', '## End of round');
  const m = report.miner || {};
  L.push(`- miner: ${m.off === null || m.off === undefined ? 'n/a (not checked in a local run)' : m.off ? 'OFF' : 'NOT OFF'}${m.was ? ` (was ${m.was})` : ''}; miner_stop.sh ${m.scriptRan === null || m.scriptRan === undefined ? 'n/a' : m.scriptRan ? 'ran' : m.remedied ? 'DID NOT RUN on the last stop — run by hand at the end, board reset' : 'DID NOT RUN'}`);
  for (const n of m.notes || []) L.push(`  - ${n}`);
  const p = report.password || {};
  L.push(`- password: original ${p.loginOk === undefined ? 'not checked in a local run' : p.loginOk ? 'logs in' : 'DOES NOT LOG IN'}; Linux user ${p.linuxOk === null || p.linuxOk === undefined ? 'unchecked' : p.linuxOk ? 'matches' : 'DOES NOT MATCH'}${p.reset ? ' (set again through the API)' : ''}`);
  for (const n of report.restore?.notes || []) L.push(`- restore: ${n}`);
  if (report.drift.length) L.push(`- DRIFT after restore: ${report.drift.join('; ')}`);
  else L.push('- no drift: services, wifi, ethernet, pools, settings and config files match the start');
  if ((report.transport || []).length) {
    L.push('', '### API transport');
    for (const e of report.transport) L.push(`- ${e.at}: ${e.what}${e.detail ? ` — ${e.detail}` : ''}`);
  }
  if (report.errors.length) {
    L.push('', '### Errors');
    for (const e of report.errors) L.push(`- ${e}`);
  }
  L.push('', `LEFT TO DO BY HAND: ${leftToDo(report, meta).join(' | ') || 'nothing'}`);
  return `${L.join('\n')}\n`;
};

const write = (dir, report, meta) => {
  fs.mkdirSync(dir, { recursive: true });
  const json = path.join(dir, 'report.json');
  const md = path.join(dir, 'report.md');
  fs.writeFileSync(json, JSON.stringify({ meta, ...report }, null, 2));
  fs.writeFileSync(md, toMarkdown(report, meta));
  return { json, md };
};

module.exports = { toMarkdown, write, duplicateToasts, leftToDo };
