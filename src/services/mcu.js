const { join } = require('path');
const { exec, spawn } = require('child_process');
const axios = require('axios');
const fs = require('fs').promises;
const { GraphQLError } = require('graphql');
const util = require('util');
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
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*(APOLLO_[A-Z_]+)=(.*)$/);
        if (match) conf[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
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

      if (!fileExists) {
        return { value: 0 };
      }

      // Read the progress value from the file
      const data = await fs.readFile(filePath);
      const progress = parseInt(data.toString());

      return { value: progress };
    } catch (error) {
      console.log('Error getting update progress:', error);
      return { value: 0 };
    }
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
    const [running, record] = await Promise.all([
      this._updateUnitActive(),
      this._readUpdateRecord(),
    ]);

    // An update the client is waiting on that is neither running nor finished.
    if (record && record.state === 'running' && !running) {
      return { running: false, record: { ...record, state: 'interrupted' } };
    }
    return { running, record };
  }

  async _updateUnitActive() {
    try {
      const { stdout } = await execPromise('systemctl is-active apollo-update.service');
      return stdout.trim() === 'active';
    } catch (error) {
      return false; // inactive, failed, unknown — all "not running"
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
      for (const line of raw.split('\n')) {
        const match = line.match(/^\s*(APOLLO_[A-Z_]+)=(.*)$/);
        if (match) conf[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
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

      if (!fileExists) {
        return { value: 0 };
      }

      // Read the progress value from the file
      const data = await fs.readFile(filePath);
      const progress = parseInt(data.toString());

      return { value: progress };
    } catch (error) {
      console.log('Error getting update progress:', error);
      return { value: 0 };
    }
  }

  // What the last update attempt did.
  //
  // The updater stops this API partway through, so progress polling goes dark for
  // the minutes that matter and the UI reconnects knowing nothing. This record is
  // written to the state dir — not /tmp — so it survives both that window and a
  // reboot, and is the only way the UI can say "the update failed and your device
  // was restored" instead of showing a blackout the user has to interpret.
  //
  // Returns null when no update has ever run, or when the file is unreadable or
  // malformed: a broken outcome record must not turn into an API error on a device
  // that is otherwise fine.
  async getLastUpdate() {
    const filePath = join(getStateDir(), 'last-update.json');
    let raw;
    try {
      raw = await fs.readFile(filePath, 'utf8');
    } catch (error) {
      return null; // never updated, or no state dir yet
    }

    try {
      const record = JSON.parse(raw);
      if (!record || typeof record.result !== 'string') return null;
      return {
        result: record.result,
        from: record.from || null,
        to: record.to || null,
        reason: record.reason || null,
        startedAt: record.started_at || null,
        finishedAt: record.finished_at || null,
      };
    } catch (error) {
      console.log('Malformed last-update record:', error.message);
      return null;
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