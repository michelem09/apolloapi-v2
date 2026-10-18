const fs = require('fs');
const path = require('path');
const base = require('@playwright/test');
const { sshExec } = require('../lib/ssh');
const api = require('../lib/api');
const { waitUntil } = require('../lib/wait');
const { devicePassword } = require('../lib/secrets');
const probes = require('./probes');

// What every journey shares: the way onto the device, the way into the UI, and
// the recorder that turns a run into a report.
//
// The parent (journeys.js) opens the tunnel, mints the token and writes the
// context file named by ACCEPTANCE_JOURNEY_CTX. Secrets are not in it: the device
// password and the wifi passphrase are read from the keychain where they are used.

// Records every toast the page ever shows, in order, across navigations. Polling
// for toasts every few seconds (as the exploratory driver did) loses the short
// ones, and the defect it was looking for — the same toast twice — is exactly a
// short one. exposeFunction survives navigations; a window variable would not.
const TOAST_OBSERVER = () => {
  const SELECTOR = '[role="status"], [role="alert"], .chakra-alert';
  const seen = new WeakSet();
  const report = (el) => {
    if (seen.has(el)) return;
    seen.add(el);
    // Rendered a tick after insertion: read it once it has had the chance to fill.
    setTimeout(() => {
      const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
      // The page's own live region, not a notification.
      if (text.startsWith('Apollo OS ·')) return;
      window.__reportToast(text || '(empty toast)');
    }, 400);
  };
  const scan = (node) => {
    if (node.nodeType !== 1) return;
    if (node.matches(SELECTOR)) report(node);
    node.querySelectorAll(SELECTOR).forEach(report);
  };
  // `document` itself: an init script runs before <html> exists, so
  // documentElement is null and observing it throws.
  new MutationObserver((muts) => muts.forEach((m) => m.addedNodes.forEach(scan)))
    .observe(document, { childList: true, subtree: true });
};

// Playwright colours its messages; a report is read in a file, not a terminal.
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

const loadContext = () => {
  const file = process.env.ACCEPTANCE_JOURNEY_CTX;
  if (!file) throw new Error('ACCEPTANCE_JOURNEY_CTX is not set — journeys are started by acceptance/journeys.js');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
};

const test = base.test.extend({
  j: async ({ page }, use, testInfo) => {
    const ctx = loadContext();
    const id = path.basename(testInfo.file).replace(/\.spec\.js$/, '');
    const started = Date.now();
    const rec = {
      id,
      name: testInfo.title,
      steps: [],
      toasts: [],
      consoleErrors: [],
      shots: [],
      notes: {},
      findings: [],
      skipped: null,
    };
    let shotNo = 0;
    const at = () => `t+${((Date.now() - started) / 1000).toFixed(1)}s`;

    await page.exposeFunction('__reportToast', (text) => rec.toasts.push({ at: at(), text }));
    await page.addInitScript(TOAST_OBSERVER);
    page.on('console', (m) => {
      if (m.type() === 'error') rec.consoleErrors.push(m.text().slice(0, 300));
    });
    page.on('pageerror', (e) => rec.consoleErrors.push(`pageerror: ${String(e).slice(0, 300)}`));

    const profile = ctx.profile;
    const ssh = async (command, opts) => {
      if (ctx.local) throw new Error('no device in a local run');
      return (await sshExec(profile, command, opts)).stdout;
    };
    const token = ctx.token;

    const j = {
      id,
      ctx,
      page,
      profile,
      local: !!ctx.local,
      kind: ctx.deviceKind,
      cfg: ctx.journeys || {},
      ssh,
      gql: (doc, vars) => api.gql(profile, token, doc, vars),
      gqlWrite: (doc, vars) => api.gqlWrite(profile, token, doc, vars),
      waitUntil,
      probes,
      password: devicePassword,

      // A step the UI performs.
      step: async (name, fn) => {
        const t0 = Date.now();
        try {
          const out = await base.test.step(name, fn);
          rec.steps.push({ name, ok: true, ms: Date.now() - t0 });
          return out;
        } catch (err) {
          rec.steps.push({ name, ok: false, ms: Date.now() - t0, detail: plain(err.message).split('\n')[0] });
          throw err;
        }
      },

      // A claim the DEVICE confirms. `fn` returns a short detail string for the
      // report, or throws. Against a local dev backend there is no device, and a
      // check that did not run must not show up as a pass: it is recorded as
      // skipped, and the round exits 3.
      verify: async (name, fn) => {
        if (j.local) {
          rec.steps.push({ name, ok: true, device: true, ms: 0, detail: 'SKIPPED — no device in a local run' });
          rec.localSkips = (rec.localSkips || 0) + 1;
          return null;
        }
        const t0 = Date.now();
        try {
          const detail = await base.test.step(`device: ${name}`, fn);
          rec.steps.push({ name, ok: true, device: true, ms: Date.now() - t0, detail: typeof detail === 'string' ? detail : undefined });
          return detail;
        } catch (err) {
          rec.steps.push({ name, ok: false, device: true, ms: Date.now() - t0, detail: plain(err.message).split('\n')[0] });
          throw err;
        }
      },

      must: (cond, message) => {
        if (!cond) throw new Error(message);
      },

      note: (key, value) => { rec.notes[key] = value; },

      shot: async (name) => {
        shotNo += 1;
        const file = path.join(ctx.out, `${id}-${String(shotNo).padStart(2, '0')}-${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        rec.shots.push(file);
      },

      toasts: () => rec.toasts.map((t) => t.text),

      // Wait for a toast matching `re` that was not there before `since`.
      waitForToast: async (re, { since = 0, timeoutMs = 20000 } = {}) => {
        const r = await waitUntil(async () => rec.toasts.slice(since).some((t) => re.test(t.text)), {
          timeoutMs,
          everyMs: 250,
        });
        if (!r.ok) throw new Error(`no toast matching ${re} within ${timeoutMs / 1000} s (saw: ${JSON.stringify(rec.toasts.slice(since).map((t) => t.text))})`);
      },
      toastCount: () => rec.toasts.length,

      // Something a human should look at that is not an assertion: it goes in the
      // report under Findings and does not fail the journey.
      finding: (text) => { rec.findings.push(text); },

      // After a save: give the page time to say something. Silence is not a
      // failure — what the device did is judged separately — but a save that says
      // nothing at all is worth a line in the report (the password change is one).
      settle: async (since, timeoutMs = 12000) => {
        const r = await waitUntil(async () => rec.toasts.length > since, { timeoutMs, everyMs: 250 });
        if (!r.ok) rec.findings.push(`no toast within ${timeoutMs / 1000} s of a save (step ${rec.steps.length + 1})`);
        return r.ok;
      },

      skip: (reason) => {
        rec.skipped = reason;
        base.test.skip(true, reason);
      },

      // The redirect to /signin is client side and takes a moment: going to a page
      // and checking the URL at once sees the page, not the redirect.
      signIn: async (pw = devicePassword()) => {
        if (!pw) throw new Error('no device password: store it in the keychain (see the README)');
        await page.goto('/overview');
        await page.waitForURL(/\/signin/, { timeout: 8000 }).catch(() => {});
        if (!/signin/.test(page.url())) return;
        await page.locator('input[type="password"]').fill(pw);
        await page.locator('button[type="submit"], button:has-text("Sign")').first().click();
        await page.waitForURL(/\/overview/, { timeout: 30000 });
      },

      // Open a page that edits settings and wait until its settings have arrived.
      //
      // A click before they do is lost without a word: the form re-seeds itself
      // from the late response and overwrites the selection (the node software
      // pick that vanished). A fixed sleep is a guess about the network; this
      // waits for the response, then for the page to go quiet.
      open: async (route) => {
        const settled = page.waitForResponse(
          (r) => r.url().includes('/graphql') && /Settings|Pool/.test(r.request().postData() || ''),
          { timeout: 20000 }
        ).catch(() => null);
        await page.goto(route);
        await settled;
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
      },

      save: async () => {
        await page.getByRole('button', { name: /^Save/ }).first().click();
      },
    };

    try {
      await use(j);
    } finally {
      // Where it stopped, for whoever reads the report.
      if (testInfo.status !== 'passed' && testInfo.status !== 'skipped') {
        await j.shot('failure').catch(() => {});
      }
      rec.ok = testInfo.status === 'passed';
      if (testInfo.status === 'skipped' && !rec.skipped) rec.skipped = 'skipped';
      rec.error = testInfo.error?.message ? plain(testInfo.error.message).split('\n')[0] : null;
      rec.durationMs = Date.now() - started;
      fs.mkdirSync(ctx.out, { recursive: true });
      fs.writeFileSync(path.join(ctx.out, `${id}.json`), JSON.stringify(rec, null, 2));
    }
  },
});

module.exports = { test, expect: base.expect, TOAST_OBSERVER };
