/**
 * Diagnostic bundle — the thing that is missing today when a user opens an issue.
 *
 * Collects device state + logs into one JSON blob the user can attach to a support
 * request. Two rules shape the whole design:
 *
 *  1. EVERYTHING IS SCRUBBED. The bundle leaves the device by definition, so it
 *     runs through redact.js unconditionally — there is no "raw" mode to pick by
 *     mistake. What was scrubbed is stated in the bundle itself.
 *  2. NO SECTION CAN BREAK THE BUNDLE. A device with no miner, a stopped node, a
 *     journal that isn't there: each section fails to `{ error }` on its own, so a
 *     partial bundle still reaches support. A bundle that throws is worth nothing.
 */
const { exec } = require('child_process');
const { promisify } = require('util');
const { scrubValue } = require('./redact');
const log = require('../../logger')('diagnostics');

const execAsync = promisify(exec);

const BUNDLE_VERSION = 1;
const DEFAULT_LOG_LINES = 200;
const MAX_LOG_LINES = 1000;
const MAX_AUTOMATION_EVENTS = 50;
const SECTION_TIMEOUT_MS = 15000;

// systemd units worth having when something went wrong.
const UNITS = ['apollo-api', 'apollo-ui-v2', 'apollo-miner', 'node', 'ckpool'];

class DiagnosticsService {
  constructor(knex, deps = {}) {
    this.knex = knex;
    this.deps = deps; // { mcu, services, settings, pools, automation, node }
  }

  /**
   * Run one section in isolation: a failure is recorded, never thrown. Bounded in
   * time too — some sources reach the network (version check) or a wedged service,
   * and a support bundle that hangs is a support bundle nobody sends.
   */
  async _section(name, fn, timeoutMs = SECTION_TIMEOUT_MS) {
    try {
      let timer;
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      try {
        return await Promise.race([fn(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      log.debug({ err: error, section: name }, 'diagnostics section failed');
      return { error: error.message || String(error) };
    }
  }

  _isProduction() {
    return process.env.NODE_ENV === 'production';
  }

  /**
   * journalctl is the only log source that behaves the same for every unit. Off a
   * device (dev laptop) it simply isn't there — that's an `error` on the section,
   * not a failure of the bundle.
   */
  async _journal(args, lines) {
    if (!this._isProduction()) {
      return { skipped: 'not a device (NODE_ENV !== production)' };
    }
    const { stdout } = await execAsync(
      `journalctl ${args} -n ${lines} --no-pager -o short-iso`,
      { maxBuffer: 8 * 1024 * 1024 }
    );
    // Not scrubbed here: the whole bundle goes through scrubValue() once at the end,
    // and journal text is by far the biggest part of it. Scrubbing twice would run
    // five global regexes over a megabyte of text a second time, synchronously, on
    // an aarch64 SBC — blocking the event loop (and the WS pushes) while a support
    // bundle is generated.
    return { content: stdout || '' };
  }

  async _command(command) {
    if (!this._isProduction()) {
      return { skipped: 'not a device (NODE_ENV !== production)' };
    }
    const { stdout } = await execAsync(command, { maxBuffer: 1024 * 1024 });
    return (stdout || '').trim(); // scrubbed once, with the whole bundle
  }

  /**
   * Build the bundle. Returns a plain object; the caller serializes it.
   */
  async collect({ logLines } = {}) {
    const lines = Math.min(Math.max(parseInt(logLines) || DEFAULT_LOG_LINES, 1), MAX_LOG_LINES);
    const { mcu, services, settings, pools, automation } = this.deps;

    const [versions, serviceStatus, system, deviceSettings, poolList, automationState, logs] =
      await Promise.all([
        this._section('versions', () => mcu.getVersion()),
        this._section('services', () => services.getStats()),
        this._section('system', async () => ({
          stats: await mcu.getStats(),
          timezone: await mcu.getTimezone().catch(() => null),
          arch: process.arch,
          platform: process.platform,
          nodeVersion: process.version,
          uptimeSeconds: Math.round(process.uptime()),
          kernel: await this._command('uname -a').catch(() => null),
          disk: await this._command('df -h /').catch(() => null),
        })),
        this._section('settings', async () => settings.read()),
        this._section('pools', async () => (await pools.list()).pools),
        this._section('automation', async () => ({
          config: await automation.getConfig(),
          recentEvents: await automation.listEvents(MAX_AUTOMATION_EVENTS),
        })),
        // Budgeted for its children: the units are read sequentially, each with its
        // own timeout, so the parent must outlast their sum. A shorter parent would
        // discard every unit already collected and hand support a bundle with no
        // logs — the one thing they actually need.
        this._section(
          'logs',
          async () => {
            const collected = {};
            for (const unit of UNITS) {
              collected[unit] = await this._section(`log:${unit}`, () =>
                this._journal(`-u ${unit}`, lines)
              );
            }
            // The point of the persistent journal (see LOGGING_REDESIGN §2.7): after
            // an abrupt hang or an unexplained restart, the evidence is in the boot
            // BEFORE this one. Without this the bundle answers everything except the
            // question the user actually asked.
            collected.previousBoot = await this._section('log:previousBoot', () =>
              this._journal('-b -1', lines)
            );
            return collected;
          },
          SECTION_TIMEOUT_MS * (UNITS.length + 2)
        ),
      ]);

    const bundle = {
      bundleVersion: BUNDLE_VERSION,
      generatedAt: new Date().toISOString(),
      privacy: {
        redacted: true,
        note:
          'Passwords, tokens and pool/RPC credentials are removed, including where ' +
          'they appear in log lines as key=value or as command arguments. Bitcoin ' +
          'addresses are masked to their first and last 4 characters. WiFi network ' +
          'names are removed from settings and from the log forms we recognise ' +
          '(ssid=…, nmcli connect …) — free-form log text may still name your ' +
          'network. This file contains device logs: review it before sharing.',
      },
      versions,
      services: serviceStatus,
      system,
      settings: deviceSettings,
      pools: poolList,
      automation: automationState,
      logs,
    };

    // Belt and braces: every section is scrubbed again as a whole, so a field added
    // to any upstream service later is covered by default instead of by memory.
    return scrubValue(bundle);
  }

  /**
   * What the GraphQL layer hands to the UI: a ready-to-save file payload.
   */
  async bundle({ logLines } = {}) {
    const collected = await this.collect({ logLines });
    const content = JSON.stringify(collected, null, 2);
    const stamp = collected.generatedAt.replace(/[:.]/g, '-');

    log.info({ sizeBytes: Buffer.byteLength(content) }, 'diagnostic bundle generated');

    return {
      filename: `apollo-diagnostics-${stamp}.json`,
      content,
      sizeBytes: Buffer.byteLength(content),
      generatedAt: collected.generatedAt,
    };
  }
}

module.exports = (knex, deps) => new DiagnosticsService(knex, deps);
