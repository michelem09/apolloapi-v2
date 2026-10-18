const fs = require('fs');
const path = require('path');

// The report is the product of a round as much as the exit code: the first run
// found its defects (a toast shown twice, labels cut off) by reading toasts and
// screenshots, not by an assertion failing. So every journey carries what it
// SAW — toasts in order, console errors, a screenshot per step — next to what it
// asserted.

const mark = (ok) => (ok ? 'PASS' : 'FAIL');
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;

// The same toast text twice in a row is a finding, not noise.
const duplicateToasts = (toasts) => {
  const seen = new Map();
  for (const t of toasts) seen.set(t.text, (seen.get(t.text) || 0) + 1);
  return [...seen].filter(([, n]) => n > 1).map(([text, n]) => ({ text, count: n }));
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
    if (dups.length) {
      L.push('', 'Same toast shown more than once:');
      for (const d of dups) L.push(`- ${d.count}x "${d.text}"`);
    }
    if ((j.findings || []).length) {
      L.push('', 'Findings:');
      for (const f of j.findings) L.push(`- ${f}`);
    }
    if ((j.consoleErrors || []).length) {
      L.push('', 'Console errors:');
      for (const e of j.consoleErrors) L.push(`- ${e}`);
    }
    if ((j.shots || []).length) L.push('', `Screenshots: ${j.shots.map((s) => path.basename(s)).join(', ')}`);
  }
  L.push('', '## End of round');
  const m = report.miner || {};
  L.push(`- miner: ${m.off === null || m.off === undefined ? 'n/a (not checked in a local run)' : m.off ? 'OFF' : 'NOT OFF'}${m.was ? ` (was ${m.was})` : ''}; miner_stop.sh ${m.scriptRan === null || m.scriptRan === undefined ? 'n/a' : m.scriptRan ? 'ran' : 'DID NOT RUN'}`);
  const p = report.password || {};
  L.push(`- password: original ${p.loginOk === undefined ? 'not checked in a local run' : p.loginOk ? 'logs in' : 'DOES NOT LOG IN'}; Linux user ${p.linuxOk === null || p.linuxOk === undefined ? 'unchecked' : p.linuxOk ? 'matches' : 'DOES NOT MATCH'}${p.reset ? ' (set again through the API)' : ''}`);
  for (const n of report.restore?.notes || []) L.push(`- restore: ${n}`);
  if (report.drift.length) L.push(`- DRIFT after restore: ${report.drift.join('; ')}`);
  else L.push('- no drift: services, wifi, ethernet, pools, settings and config files match the start');
  if (report.errors.length) {
    L.push('', '### Errors');
    for (const e of report.errors) L.push(`- ${e}`);
  }
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

module.exports = { toMarkdown, write, duplicateToasts };
