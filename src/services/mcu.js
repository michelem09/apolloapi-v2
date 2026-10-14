const { join } = require('path');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs').promises;
const { GraphQLError } = require('graphql');
const util = require('util');
const log = require('../logger')('mcu');
const os = require('os');
const { getStateDir } = require('../paths');

// Convert exec to use promises
const execPromise = util.promisify(exec);

class McuService {
  constructor(knex, utils) {
    this.knex = knex;
    this.utils = utils;
  }

  // Get MCU stats
  async getStats() {
    try {
      const stats = await this._getOsStats();
      stats.timestamp = new Date().toISOString();
      return { stats };
    } catch (error) {
      throw new GraphQLError(`Failed to get MCU stats: ${error.message}`);
    }
  }

  /**
   * Read the system timezone and the list the device can be set to.
   *
   * Devices ship with the factory image default (America/New_York), which most
   * owners never change: it skews journal timestamps, the DB timestamps behind
   * the charts, and — since the automation reads the wall clock — the hour at
   * which a time rule fires.
   */
  async getTimezone() {
    // The device runs Linux with systemd, but a dev machine (macOS) has no
    // timedatectl. Fall back to the platform's own IANA data so the feature is
    // testable locally instead of exploding with spawn ENOENT.
    const detectedZone = () => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      } catch (e) {
        return 'UTC';
      }
    };
    const zoneList = () => {
      try {
        if (typeof Intl.supportedValuesOf === 'function') {
          return Intl.supportedValuesOf('timeZone');
        }
      } catch (e) {
        /* fall through */
      }
      return [detectedZone(), 'UTC', 'Europe/Rome', 'America/New_York'];
    };

    let timezone;
    try {
      timezone = (await this._spawnCommand('timedatectl', ['show', '-p', 'Timezone', '--value'])).trim();
    } catch (e) {
      timezone = '';
    }
    // An empty read is a failed read. Left as '' it would surface as "the device
    // is on UTC", and picking UTC to confirm that would hit the no-op guard in
    // setTimezone below — a device stuck on a zone the UI cannot correct.
    if (!timezone) timezone = detectedZone();

    let available;
    try {
      const raw = await this._spawnCommand('timedatectl', ['list-timezones']);
      available = raw.split('\n').map((zone) => zone.trim()).filter(Boolean);
    } catch (e) {
      available = [];
    }
    if (!available.length) available = zoneList();
    if (timezone && !available.includes(timezone)) available = [timezone, ...available];

    return {
      timezone: timezone || 'UTC',
      available,
      rebootPending: await this._timezoneRebootPending(),
    };
  }

  /**
   * True when the zone was changed after this boot.
   *
   * Changing it does not reach the processes already running: each one read the
   * zone at startup, so ckpool and rsyslog keep writing the old local time into
   * the very logs the UI shows. `timedatectl set-timezone` rewrites the
   * /etc/localtime symlink, so its mtime against the boot time says whether a
   * reboot is still owed — durable state on the device, not a flag in someone's
   * browser, so the warning survives a reload and comes back on another machine.
   */
  async _timezoneRebootPending() {
    try {
      const { mtimeMs } = await fs.lstat('/etc/localtime');
      return mtimeMs > Date.now() - os.uptime() * 1000;
    } catch (e) {
      // No /etc/localtime (macOS dev, a container): nothing to warn about.
      return false;
    }
  }

  async setTimezone({ timezone }) {
    try {
      // Validate against what the system actually knows, and pass the value as an
      // argv element — never interpolated into a shell string.
      const current = await this.getTimezone();
      if (!current.available.includes(timezone)) {
        throw new Error(`Unknown timezone: ${timezone}`);
      }

      // Re-picking the zone it is already on must not rewrite /etc/localtime:
      // that would ask for a reboot nobody needs.
      if (timezone === current.timezone) return current;

      if (process.env.NODE_ENV === 'production') {
        await this._spawnCommand('sudo', ['timedatectl', 'set-timezone', timezone]);
      } else {
        log.debug({ timezone }, '[dev] would set system timezone');
      }

      return this.getTimezone();
    } catch (error) {
      throw new GraphQLError(`Failed to set timezone: ${error.message}`);
    }
  }

  // Reboot device
  async reboot() {
    try {
      if (process.env.NODE_ENV === 'production') {
        await this._execCommand('sudo reboot');
      } else {
        log.debug('reboot command would execute in production mode');
      }
    } catch (error) {
      throw new GraphQLError(`Failed to reboot device: ${error.message}`);
    }
  }

  // Shutdown device
  async shutdown() {
    try {
      if (process.env.NODE_ENV === 'production') {
        await this._execCommand('sudo shutdown -h now');
      } else {
        log.debug('shutdown command would execute in production mode');
      }
    } catch (error) {
      throw new GraphQLError(`Failed to shutdown device: ${error.message}`);
    }
  }

  // What this device is running.
  //
  // version.json is written by the updater from the release it installed, so it is
  // the only file that reflects what actually happened. package.json is the
  // fallback for a device that has never taken a tarball update.
  _installedVersion() {
    const root = join(__dirname, '..', '..');
    for (const file of ['version.json', 'package.json']) {
      try {
        const parsed = require(join(root, file));
        if (parsed && parsed.version) return parsed.version;
      } catch (error) {
        // try the next one
      }
    }
    return null;
  }

  // Where the updater fetches from, read exactly as backend/update reads it so the
  // two can never disagree about which channel this device is on.
  async _channelUrl() {
    const defaults = { base: 'https://github.com/jstefanop', repo: 'apolloapi-v2', channel: 'stable' };
    let conf = {};
    try {
      const raw = await fs.readFile(join(getStateDir(), 'source.conf'), 'utf8');
      // Parsed exactly as conf_get in backend/update parses it, because the two
      // disagreeing means the banner names a channel the updater does not use.
      // Neither inline comments nor CR were stripped here: on the shipped
      // comment-heavy example file `APOLLO_CHANNEL=dev  # switch before shipping`
      // yielded the whole trailing comment, and on a CRLF file every key was
      // dropped — silently sending a fork device to the official stable channel.
      for (const line of raw.split(/\r?\n/)) {
        const match = line.match(/^\s*(APOLLO_[A-Z_]+)=(.*)$/);
        if (!match) continue;
        const value = match[2]
          .replace(/\s+#.*$/, '')      // inline comment
          .trim()
          .replace(/^["']|["']$/g, '');
        if (value) conf[match[1]] = value;
      }
    } catch (error) {
      // No source.conf: this device has not been switched yet, use the defaults.
    }
    const base = conf.APOLLO_GIT_BASE || defaults.base;
    const repo = conf.APOLLO_API_REPO || defaults.repo;
    const channel = conf.APOLLO_CHANNEL || defaults.channel;
    return `${base}/${repo}/releases/download/channel-${channel}/${channel}.json`;
  }

  // The version this device could install, taken from the signed update channel —
  // the same manifest backend/update gates on.
  //
  // It used to come from jstefanop/apolloui-v2@main/package.json over plain HTTP:
  // a different source from the one the updater installs against, unsigned, and
  // unrelated to the release. The banner and the OTA channel could never agree,
  // and on a device pointed at a fork the comparison never converged at all, so
  // the update button was either permanently offered or never shown.
  //
  // Null when the channel cannot be reached: offering an update we cannot name is
  // worse than staying quiet.
  async _availableVersion() {
    const now = Date.now();
    if (this._versionCache && now - this._versionCache.at < 5 * 60 * 1000) {
      return this._versionCache.value;
    }
    let value = null;
    try {
      const url = await this._channelUrl();
      const response = await axios.get(url, { timeout: 15000 });
      if (response && response.data && typeof response.data.version === 'string') {
        value = response.data.version;
      }
    } catch (error) {
      log.warn({ err: error }, 'could not read the update channel');
    }
    this._versionCache = { at: now, value };
    return value;
  }

  // Get application version
  async getVersion() {
    const installed = this._installedVersion();
    const available = await this._availableVersion();
    return {
      // `result` keeps its old meaning — the version out there — so a browser
      // still running an older UI bundle keeps working during the swap.
      result: available || installed,
      installed,
      available,
    };
  }

  // What the last update run is doing, or did.
  //
  // Two things together, because either alone lies. The record says what the
  // updater believes; systemd says whether it is still there to believe it. A
  // record stuck on "running" with no unit alive means the updater was killed —
  // a state the previous design could not express at all, and which silently
  // latched service recovery off.
  //
  // The run_id is what lets a client recognise ITS update. Before it, the client
  // compared the browser's clock against the device's to decide whether a record
  // was its own — on boards with no RTC, whose clock is known to ship wrong, and
  // in the minutes right after a restart when NTP has not converged.
  async getUpdateStatus() {
    // Sequential, and in this order, which is the whole point.
    //
    // Run in parallel, these two are sampled at different instants: the file read
    // resolves in about a millisecond, the systemctl fork in tens of them. So a
    // record could be read while the updater was still at "starting services",
    // the unit could exit before systemctl replied, and the guard below would
    // rewrite a healthy, completed update as `interrupted` — telling the user the
    // updater had died without recording anything, about an update that had just
    // installed cleanly.
    //
    // Asking systemd FIRST removes the window instead of narrowing it: the
    // updater writes its terminal record before it exits, so `running === false`
    // means that write has already happened, and the record read afterwards
    // cannot still say "running" unless the run really was killed.
    const active = await this._updateUnitActive();
    const record = await this._readUpdateRecord();

    // Only a definite "the unit is gone" may contradict a record that says the
    // run is alive. `null` means systemd could not be asked, and rewriting a live
    // run to a terminal state on the strength of a failed fork is how a healthy
    // update got reported as dead with no way back.
    if (record && record.state === 'running' && active === false) {
      return { running: false, record: { ...record, state: 'interrupted' } };
    }
    // Unknown reports as not running — the client waits on that, which is the
    // recoverable direction — while the record is passed through untouched.
    return { running: active === true, record };
  }

  // true | false | null, and the null matters.
  //
  // `is-active` exits 3 for inactive and 4 for no-such-unit, so the catch is the
  // NORMAL path and cannot be treated as "anything went wrong means not
  // running". A fork that fails for any other reason — EAGAIN or ENOMEM while
  // the box unpacks and backs up hundreds of megabytes, which is the memory
  // pressure this whole redesign exists to remove, or a hung dbus — would
  // otherwise answer "not running" about a run that is very much alive. One such
  // answer was enough: the record still says `running`, so it was rewritten to
  // `interrupted`, which is terminal, so the client stopped polling and told the
  // user the update had died — permanently, mid-swap, while suggesting a reboot.
  //
  // null is "we could not ask", which leaves the record alone.
  async _updateUnitActive() {
    try {
      const { stdout } = await execPromise('systemctl is-active apollo-update.service');
      // Exit 0 means `active` and nothing else — `activating` exits 3 and is
      // handled in the catch. Testing for it here too would be a dead branch
      // suggesting this side decides something it cannot see, which is the shape
      // of the defect the catch was just reordered to remove.
      return stdout.trim() === 'active';
    } catch (error) {
      // What systemd SAID first, then the exit code. The other order made the
      // `activating` case unreachable — is-active exits 3 for it, so the code
      // check always fired first — while the success path above classified
      // `activating` as not running. Two opposite intentions for one state, and
      // neither exercised. A transient unit is `activating` only momentarily,
      // but during that moment the run is very much alive.
      const said = (error && error.stdout ? String(error.stdout) : '').trim();
      if (said === 'active' || said === 'activating' || said === 'reloading') return true;
      if (said === 'inactive' || said === 'failed' || said === 'deactivating') return false;
      if (error && (error.code === 3 || error.code === 4)) return false;
      return null;
    }
  }

  // Null when no update has ever run, or when the file is unreadable or
  // malformed: the one file whose job is to explain a failure must not become a
  // second one on a device that is otherwise fine.
  async _readUpdateRecord() {
    const filePath = join(getStateDir(), 'last-update.json');
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      return null;
    }
    try {
      const record = JSON.parse(raw);
      if (!record || typeof record.state !== 'string') return null;
      return {
        runId: record.run_id || null,
        state: record.state,
        phase: record.phase || null,
        progress: typeof record.progress === 'number' ? record.progress : null,
        from: record.from || null,
        to: record.to || null,
        reason: record.reason || null,
        startedAt: record.started_at || null,
        updatedAt: record.updated_at || null,
      };
    } catch (error) {
      log.warn({ err: error }, 'malformed update record');
      return null;
    }
  }

  // Update firmware
  async update() {
    try {
      let scriptName = 'update';
      if (process.env.NODE_ENV === 'development') scriptName = 'update.fake';

      const updateScript = join(__dirname, '../../backend', scriptName);
      const cmd = spawn(process.env.NODE_ENV === 'development' ? 'bash' : 'sudo',
        process.env.NODE_ENV === 'development' ? [updateScript] : ['bash', updateScript]);

      // info, not debug: an update is rare, high-stakes, and the device reboots
      // right after — if this is not in the journal at the production level, a
      // failed update leaves no trace anywhere and is undiagnosable after the fact.
      cmd.stdout.on('data', (data) => {
        log.info({ output: data.toString().trim() }, 'update script stdout');
      });

      cmd.stderr.on('data', (data) => {
        log.warn({ output: data.toString().trim() }, 'update script stderr');
      });

      cmd.on('close', (code) => {
        if (code === 0) log.info({ code }, 'update script finished');
        else log.error({ code }, 'update script exited non-zero');
      });

      // The update runs for many minutes and reports through its own record
      // (last-update.json) and progress marker, so its OUTCOME is not awaited here —
      // unlike the format launcher, which detaches at once. But the spawn itself
      // must be: a process that cannot even start ('error' — sudo or bash
      // missing, EACCES) used to be reported as a started update, and with no
      // 'error' listener the event would crash the whole API.
      await new Promise((resolve, reject) => {
        cmd.once('spawn', resolve);
        cmd.once('error', reject);
      });
    } catch (error) {
      throw new GraphQLError(`Failed to update firmware: ${error.message}`);
    }
  }

  // Get update progress
  // The live progress value, or 0. Nothing else.
  //
  // Its only consumer is the UI bundle loaded BEFORE an update — the bundle the
  // update replaces — which polls this and completes on `value >= 90`. The
  // updater deliberately stops at 88, because two gates that still roll
  // everything back come after it, so on the first tarball update that browser
  // reaches 88, loses the API, reconnects, reads 0, and sits there until the
  // page is reloaded. Once per device, ever, and a reload fixes it.
  //
  // Four rounds were spent trying to close that gap from here, and each shape
  // traded one failure for another: a permanent 100 latched "Reload App" for
  // good; a wall-clock window was defeated by the clock steps these RTC-less
  // boards make right after an update; a monotonic window anchored on first
  // observation reopened on every unrelated API restart; a liveness flag was
  // unreachable by the one client that needed it, because that bundle does not
  // know `updateStatus` exists.
  //
  // They failed for one reason: this reconstructs, from device state, a signal
  // about a browser that never touches that state. The honest answer is that a
  // pre-update bundle cannot be released from here, so it is not attempted. A
  // reload is the recovery, it is needed once, and it costs nothing to explain.
  async getUpdateProgress() {
    try {
      const raw = await fs.readFile('/tmp/update_progress', 'utf8');
      const progress = parseInt(raw, 10);
      return { value: Number.isFinite(progress) ? progress : 0 };
    } catch (error) {
      if (error.code !== 'ENOENT') {
        log.error({ err: error }, 'error getting update progress');
      }
      return { value: 0 };
    }
  }


  // Helper method to get OS stats
  async _getOsStats() {
    return new Promise((resolve, reject) => {
      const scriptName = (process.env.NODE_ENV === 'production')
        ? 'os_stats'
        : 'os_stats_fake';

      const scriptPath = join(__dirname, '../../backend', scriptName);

      exec(scriptPath, {}, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          try {
            const result = JSON.parse(stdout.toString());
            resolve(result);
          } catch (err) {
            reject(err);
          }
        }
      });
    });
  }

  // Helper method to get IP address
  async _getIpAddress() {
    return new Promise((resolve, reject) => {
      let command = "ip -4 addr list wlan0 | grep inet | cut -d' ' -f6 | cut -d/ -f1";

      if (process.env.NODE_ENV !== 'production') {
        command = 'echo "127.0.0.1"';
      }

      exec(command, {}, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          const address = stdout.trim();
          resolve(address);
        }
      });
    });
  }

  // Run a command with an argv array: no shell, so no argument can be turned into
  // one (same rule as the nmcli and chpasswd paths).
  _spawnCommand(command, args) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  // Helper method to execute shell commands
  async _execCommand(command) {
    try {
      const { stdout, stderr } = await execPromise(command);
      if (stderr) {
        log.warn({ stderr }, 'command produced stderr');
      }
      return stdout.trim();
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (knex, utils) => new McuService(knex, utils);