const { join } = require('path');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs').promises;
const { GraphQLError } = require('graphql');
const util = require('util');
const { getStateDir } = require('../paths');

// Convert exec to use promises
const execPromise = util.promisify(exec);

// How long after this process first sees a finished update the compatibility
// value stays available.
//
// Only a browser that watched THIS update can legitimately be waiting for it,
// and that browser polls every three seconds. Ten minutes is generous for a
// reconnect and short enough that nothing latches: a device that has simply
// updated at some point in the past must not keep answering 100.
const COMPAT_PROGRESS_WINDOW_MS = 10 * 60 * 1000;

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

  // Scan for WiFi networks
  async scanWifi() {
    try {
      const wifiScan = await this._getWifiScan();
      return { wifiScan };
    } catch (error) {
      throw new GraphQLError(`Failed to scan WiFi networks: ${error.message}`);
    }
  }

  // Connect to WiFi network
  async connectWifi({ ssid, passphrase }) {
    try {
      await this._wifiConnect(ssid, passphrase);
      const address = await this._getIpAddress();
      return { address };
    } catch (error) {
      throw new GraphQLError(`Failed to connect to WiFi: ${error.message}`);
    }
  }

  // Disconnect from WiFi network
  async disconnectWifi() {
    try {
      await this._wifiDisconnect();
    } catch (error) {
      throw new GraphQLError(`Failed to disconnect from WiFi: ${error.message}`);
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
      timezone = detectedZone();
    }

    let available;
    try {
      const raw = await this._spawnCommand('timedatectl', ['list-timezones']);
      available = raw.split('\n').map((zone) => zone.trim()).filter(Boolean);
    } catch (e) {
      available = [];
    }
    if (!available.length) available = zoneList();
    if (timezone && !available.includes(timezone)) available = [timezone, ...available];

    return { timezone: timezone || 'UTC', available };
  }

  async setTimezone({ timezone }) {
    try {
      // Validate against what the system actually knows, and pass the value as an
      // argv element — never interpolated into a shell string.
      const { available } = await this.getTimezone();
      if (!available.includes(timezone)) {
        throw new Error(`Unknown timezone: ${timezone}`);
      }

      if (process.env.NODE_ENV === 'production') {
        await this._spawnCommand('sudo', ['timedatectl', 'set-timezone', timezone]);
      } else {
        console.log(`[DEV] Would set system timezone to ${timezone}`);
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
        console.log('Reboot command would execute in production mode');
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
        console.log('Shutdown command would execute in production mode');
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
        // eslint-disable-next-line global-require, import/no-dynamic-require
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
      console.log('Could not read the update channel:', error.message);
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

    // Remember that THIS process watched this run be alive. It is what lets the
    // compatibility progress value be offered only to a browser that was here
    // for the update, instead of to anyone who happens to poll after a restart.
    if (active === true && record && record.runId) {
      this._sawUpdateRunning = record.runId;
    }

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
      console.log('Malformed update record:', error.message);
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

      cmd.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
      });

      cmd.stderr.on('data', (data) => {
        console.error(`stderr: ${data}`);
      });

      cmd.on('close', (code) => {
        console.log(`child process exited with code ${code}`);
      });
    } catch (error) {
      throw new GraphQLError(`Failed to update firmware: ${error.message}`);
    }
  }

  // Get update progress
  async getUpdateProgress() {
    try {
      // Check if the progress file exists
      const filePath = '/tmp/update_progress';
      let fileExists = true;

      try {
        await fs.access(filePath, fs.constants.F_OK);
      } catch (error) {
        if (error.code === 'ENOENT') {
          // File doesn't exist
          console.log('update_progress file not found. Returning default progress.');
          fileExists = false;
        } else {
          throw error;
        }
      }

      if (fileExists) {
        const data = await fs.readFile(filePath);
        const progress = parseInt(data.toString(), 10);
        if (Number.isFinite(progress)) return { value: progress };
      }

      // The file is gone, so the run is over — but this query exists for one
      // caller only: the UI bundle that was loaded BEFORE the update, which is
      // the bundle the update replaces. It completes on `value >= 90` and has no
      // other way to finish.
      //
      // The updater cannot satisfy that with the file alone. It deliberately
      // stops at 88, because two gates that still roll everything back come
      // after it, and it deletes the file at the end, because a leftover
      // terminal value read as a live one is what once left devices unable to
      // take another update. So the old bundle watched 5 -> 88, lost the API,
      // reconnected, read 0, and sat on "Updating... 0%" after a SUCCESSFUL
      // update, with its close button hidden.
      //
      // The record can satisfy it: it knows the run finished and how. Only a
      // success unblocks the old modal — telling it "done" after a rollback
      // would be a lie it would render as success. A failed update leaves the
      // device on the version that bundle came from, so a page reload gets the
      // user out, and the current bundle reports the outcome properly.
      // Bounded on both sides, because this value LATCHES in the bundle it
      // serves. That bundle polls at mount with no `skip`, and its `>= 90` check
      // sits outside its own `if (updateInProgress)` — so a permanent 100 makes
      // it declare "Done!" five seconds after every mount, for the rest of the
      // device's life, hiding the Update button behind "Reload App" that
      // re-serves the same bundle. That is the exact state the record mechanism
      // was built to end, moved out of the progress file and into the API.
      //
      // The record is never cleared, so "succeeded" alone cannot bound it:
      //  - from !== to, or nothing was installed. The "Already on <version>"
      //    path records succeeded WITHOUT replacing the UI, so a device that is
      //    up to date would latch on every poll forever.
      //  - and recent, because the only legitimate reader is a browser that
      //    watched this very update and is waiting to be released.
      //
      // "Recent" measured MONOTONICALLY, from when this process first saw the
      // record — not as `Date.now() - record.updatedAt`. That difference spans
      // two readings of a clock these boards do not keep: they have no RTC, ship
      // wrong, and the minutes right after an update are exactly when NTP
      // converges and steps them. A forward step made the record look hours old
      // and withheld the value from the browser waiting for it; a backward step
      // made the age negative and did the same. It is the same trap the run_id
      // exists to avoid, walked into again one layer down.
      //
      // The API is restarted BY the update, so the process serving the
      // pre-update bundle afterwards is a fresh one that meets the record for
      // the first time right when the browser needs it.
      const record = await this._readUpdateRecord();
      if (
        record &&
        record.state === 'succeeded' &&
        record.from &&
        record.to &&
        record.from !== record.to
      ) {
        // Anchored on having seen the run LIVE, not on first noticing its
        // record. `_compatSeen` lives on this singleton, so anchoring on first
        // observation reopened the window on every unrelated apollo-api restart
        // — a crash, a manual restart, a reboot, days later — and served 100
        // again for ten minutes each time.
        //
        // `_sawUpdateRunning` is set by getUpdateStatus while the unit is up, so
        // the value is only ever offered to a process that actually watched this
        // update happen. That is exactly the process serving the pre-update
        // bundle, because the updater restarts the API before the browser
        // reconnects.
        if (this._sawUpdateRunning === record.runId) {
          if (!this._compatSeen || this._compatSeen.runId !== record.runId) {
            this._compatSeen = { runId: record.runId, at: process.hrtime.bigint() };
          }
          const elapsedMs = Number(
            (process.hrtime.bigint() - this._compatSeen.at) / 1000000n
          );
          if (elapsedMs < COMPAT_PROGRESS_WINDOW_MS) return { value: 100 };
        }
      }

      return { value: 0 };
    } catch (error) {
      console.log('Error getting update progress:', error);
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

  // Helper method to scan for WiFi networks
  async _getWifiScan() {
    return new Promise((resolve, reject) => {
      const scriptName = (process.env.NODE_ENV === 'production')
        ? 'wifi_scan'
        : 'wifi_scan_fake';

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

  // Helper method to connect to WiFi network (spawn + argv only — no shell on ssid/passphrase)
  async _wifiConnect(ssid, passphrase) {
    const isProd = process.env.NODE_ENV === 'production';
    if (!isProd) {
      await new Promise((r) => setTimeout(r, 2000));
    }

    const nmcliArgs = ['dev', 'wifi', 'connect', ssid];
    if (passphrase) {
      nmcliArgs.push('password', passphrase);
    }

    return new Promise((resolve, reject) => {
      const child = isProd
        ? spawn('sudo', ['nmcli', ...nmcliArgs], { stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn('nmcli', nmcliArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

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
        const out = (stdout + stderr).toString();
        if (code !== 0) {
          reject(new Error(out.trim() || `nmcli exited with code ${code}`));
          return;
        }
        if (out.includes('Error')) {
          const errMsg = out
            .trim()
            .replace(/^.+\(\d+\)\ /g, '')
            .replace(/\.$/g, '');
          reject(new Error(errMsg));
        } else {
          resolve();
        }
      });
    });
  }

  // Helper method to disconnect from WiFi network
  async _wifiDisconnect() {
    return new Promise((resolve, reject) => {
      let command = 'for i in $(nmcli -t c show|grep wlan); do nmcli c delete `echo $i|cut -d":" -f2`; done';

      if (process.env.NODE_ENV !== 'production') {
        command = 'sleep 2 && echo true';
      }

      exec(command, {}, (err, stdout) => {
        if (err) {
          reject(err);
        } else {
          if (stdout.includes('Error')) {
            const errMsg = stdout.trim()
              .replace(/^.+\(\d+\)\ /g, "")
              .replace(/\.$/g, "");

            reject(new Error(errMsg));
          } else {
            resolve();
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
        console.error(`Command stderr: ${stderr}`);
      }
      return stdout.trim();
    } catch (error) {
      throw error;
    }
  }
}

module.exports = (knex, utils) => new McuService(knex, utils);