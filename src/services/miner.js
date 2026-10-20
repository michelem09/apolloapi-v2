const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const _ = require('lodash');
const moment = require('moment');
const { GraphQLError } = require('graphql');
const { getMinerRuntimeDir, getApolloIIIStatsDir, getCkpoolLogsDir } = require('../paths');
const log = require('../logger')('miner');
const transition = require('./transition');
const { getMinerBoards } = require('../minerBoards');

// Import the dev miner service for development mode
const devMinerService =
  process.env.NODE_ENV === 'development' ? require('../devMinerService') : null;

class MinerService {
  constructor(knex, utils) {
    this.knex = knex;
    this.utils = utils;
  }

  // Push the current services status to all WS subscribers immediately.
  // Uses a lazy require to avoid circular dependency (scheduler → services → miner).
  _notifyServicesStatus() {
    try {
      const { pushServicesStatus } = require('../app/scheduler');
      pushServicesStatus().catch(() => {});
    } catch (_) {}
  }

  /**
   * A manual start/stop pauses the automation rather than fighting it: a miner
   * that undoes the user's click a minute later is the fastest way to get the
   * feature switched off for good. Commands coming *from* the automation
   * obviously must not pause it.
   *
   * Lazy require: services/index builds the automation service with this one as a
   * dependency, so requiring it at module load would close the loop.
   */
  async _pauseAutomation(source) {
    if (source !== 'user') return;
    try {
      const { automation } = require('./index');
      const config = await automation.getConfig();
      if (config.enabled) await automation.setOverride({ reason: 'manual' });
    } catch (error) {
      // Never let this block a miner command (e.g. a device that has not run the
      // automation migration yet).
      log.debug({ err: error }, 'could not pause automation');
    }
  }

  // Re-evaluate + push the automation state after a *user* start/stop so the
  // automation page reflects the new miner status immediately instead of at the
  // next 60s tick. Only for user actions — the automation's own commands would
  // otherwise recurse.
  _reevaluateAutomation(source) {
    if (source !== 'user') return;
    try {
      const { evaluateAutomation } = require('../app/scheduler');
      Promise.resolve(evaluateAutomation()).catch(() => {});
    } catch (e) {
      /* scheduler not running */
    }
  }

  async start({ source = 'user' } = {}) {
    try {
      // Dev: no systemd and no monitor; the dev miner runs for as long as it
      // takes, and the row is set online by hand when it is up.
      if (process.env.NODE_ENV === 'development') {
        await transition.run(
          this.knex,
          'miner',
          'online',
          async () => {
            log.debug('starting dev miner');
            await devMinerService.startDevMiner();
          },
          { notify: () => this._notifyServicesStatus() }
        );
        log.debug('dev miner started');
      } else {
        // --no-block: on an Apollo II miner_start.sh resets the internal board and
        // sleeps ~35s before starting it, and a forking unit blocks systemctl for
        // that whole time. The reset and that wait still run in full; we just
        // don't hold the API call open for them. The service monitor reports the
        // miner coming online.
        await transition.run(
          this.knex,
          'miner',
          'online',
          () => this._execCommand('sudo systemctl start --no-block apollo-miner'),
          { notify: () => this._notifyServicesStatus() }
        );
      }
    } catch (error) {
      // Only the command's own refusal is reported as one.
      throw transition.refused('miner', 'start', error);
    }
    await this._afterAccepted(source, 'online');
  }

  // Stop the miner
  async stop({ source = 'user' } = {}) {
    try {
      // Dev: see start().
      if (process.env.NODE_ENV === 'development') {
        await transition.run(
          this.knex,
          'miner',
          'offline',
          async () => {
            log.debug('stopping dev miner');
            await devMinerService.stopDevMiner();
          },
          { notify: () => this._notifyServicesStatus() }
        );
        log.debug('dev miner stopped');
      } else {
        await transition.run(
          this.knex,
          'miner',
          'offline',
          () => this._execCommand('sudo systemctl stop --no-block apollo-miner'),
          { notify: () => this._notifyServicesStatus() }
        );
      }
    } catch (error) {
      // Only the command's own refusal is reported as one.
      throw transition.refused('miner', 'stop', error);
    }
    await this._afterAccepted(source, 'offline');
  }

  // Restart the miner
  async restart({ source = 'user' } = {}) {
    try {
      // Dev: see start().
      if (process.env.NODE_ENV === 'development') {
        await transition.run(
          this.knex,
          'miner',
          'online',
          async () => {
            log.debug('restarting dev miner');
            await devMinerService.restartDevMiner();
          },
          { notify: () => this._notifyServicesStatus() }
        );
        log.debug('dev miner restarted');
      } else {
        // --no-block: see start(). The 35s device-side wait is unchanged; the
        // API returns at once and the service monitor tracks the miner online.
        await transition.run(
          this.knex,
          'miner',
          'online',
          () => this._execCommand('sudo systemctl restart --no-block apollo-miner'),
          { notify: () => this._notifyServicesStatus() }
        );
      }
    } catch (error) {
      // Only the command's own refusal is reported as one.
      throw transition.refused('miner', 'restart', error);
    }
    await this._afterAccepted(source, 'online');
  }

  // What follows a command that systemd (or the dev miner) ACCEPTED. A failure
  // here is not a refusal and must not be reported as one ("Could not start the
  // miner" over a miner that is starting): it is logged. The pause comes only now,
  // so a click that was refused does not pause the automation.
  async _afterAccepted(source, devStatus) {
    try {
      if (process.env.NODE_ENV === 'development') await this._setDevStatus(devStatus);
      await this._pauseAutomation(source);
      this._reevaluateAutomation(source);
    } catch (error) {
      log.warn({ err: error }, 'follow-up of an accepted miner command failed');
    }
  }

  // In development the ServiceMonitor is disabled, so whoever ran the dev miner
  // records its arrival (and announces it, like the end of any transition).
  async _setDevStatus(status) {
    await this.knex('service_status')
      .where({ service_name: 'miner' })
      .update({ status, last_checked: Date.now() });
    this._notifyServicesStatus();
  }

  // Boards known to the registry, read fresh (a cheap sysfs/stat scan).
  async getBoards() {
    const registry = getMinerBoards();
    await registry.refresh();
    return registry.snapshot();
  }

  // Get miner statistics
  async getStats() {
    try {
      // Fetch settings and pools
      const settingsService = require('./settings')(this.knex, this.utils);
      const poolsService = require('./pools')(this.knex, this.utils);

      const settings = await settingsService.read();
      const pools = await poolsService.list();

      // Get miner stats
      let stats = [];
      let ckpool = null;

      try {
        stats = await this._getMinerStats(settings, pools.pools);
      } catch (statsError) {
        log.error({ err: statsError }, 'error getting miner stats');
        // Continue with empty stats array instead of failing completely
      }

      try {
        ckpool = await this._getCkpoolStats(settings, pools.pools);
      } catch (ckpoolError) {
        log.error({ err: ckpoolError }, 'error getting ckpool stats');
        // Continue with null ckpool data instead of failing completely
      }

      return { stats, ckpool };
    } catch (error) {
      log.error({ err: error }, 'error in getStats');
      // Return empty data instead of throwing error
      return { stats: [], ckpool: null };
    }
  }

  // Check if miner is online
  async checkOnline() {
    try {
      // Initialize default values
      const initialUserStatus = {
        requestedStatus: null,
        requestedAt: null,
      };

      // Fetch requested status from database
      let dbStatus = await this.knex('service_status')
        .select(
          'requested_status as requestedStatus',
          'requested_at as requestedAt'
        )
        .where({ service_name: 'miner' })
        .first();

      if (!dbStatus) {
        dbStatus = initialUserStatus;
      }

      // Check if miner is online
      const online = await this._isMinerOnline(dbStatus);
      online.timestamp = new Date().toISOString();

      return { online };
    } catch (error) {
      throw new GraphQLError(`Failed to check miner status: ${error.message}`);
    }
  }

  // Reset the block found flag
  async resetBlockFoundFlag() {
    try {
      const blockFoundFlagFile = path.join(getCkpoolLogsDir(), 'BLOCKFOUND.log');

      try {
        // Check if file exists before attempting to delete it
        await fs.access(blockFoundFlagFile, fs.constants.F_OK);
        await fs.unlink(blockFoundFlagFile);
        log.info('block found flag reset successfully');
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // Only throw if error is not "file not found"
          throw err;
        }
      }
    } catch (error) {
      throw new GraphQLError(`Failed to reset block found flag: ${error.message}`);
    }
  }

  // Helper method to check if miner is online
  async _isMinerOnline(dbStatus) {
    try {
      // USB stat files live in the runtime dir; the III stat file may live in a
      // different one (APOLLO_III_STATS_DIR), and both count as "miner is up".
      const statsDirs = [
        ...new Set([getMinerRuntimeDir(), getApolloIIIStatsDir()]),
      ];
      const statsFilePattern = /^apollo-miner.*$/;

      // Define thresholds
      const recentThresholdMs = 15000; // 15 seconds
      const pendingThresholdMs = 60000; // 60 seconds
      const pendingStopTimeoutMs = 5000; // 5 seconds

      // Get current time
      const currentTime = Date.now();
      const requestedAtTime = dbStatus.requestedAt
        ? new Date(dbStatus.requestedAt).getTime()
        : 0;

      // List the stat files of every dir; a missing dir is simply empty
      const statsFiles = [];
      let anyDirExists = false;
      for (const dir of statsDirs) {
        let files;
        try {
          files = await fs.readdir(dir);
        } catch (err) {
          if (err.code === 'ENOENT') continue;
          throw err;
        }
        anyDirExists = true;
        for (const file of files) {
          if (statsFilePattern.test(file)) statsFiles.push(path.join(dir, file));
        }
      }

      // No dir, or no stats files: check requested status and pending threshold
      if (!anyDirExists || statsFiles.length === 0) {
        if (
          dbStatus.requestedStatus === 'online' &&
          currentTime - requestedAtTime <= pendingThresholdMs
        ) {
          return { status: 'pending' };
        }
        return { status: 'offline' };
      }

      // Find the most recently modified file
      let latestFile = null;
      let latestMtime = 0;

      for (const filePath of statsFiles) {
        const stats = await fs.stat(filePath);

        if (stats.mtimeMs > latestMtime) {
          latestMtime = stats.mtimeMs;
          latestFile = filePath;
        }
      }

      if (!latestFile) {
        return { status: 'offline' };
      }

      // Check how recently the file was updated
      const timeSinceLastUpdate = currentTime - latestMtime;

      // Handle case where requested_status is null (e.g., fresh installation)
      // In this case, just check if files are being updated without pending logic
      if (!dbStatus.requestedStatus || dbStatus.requestedStatus === null) {
        if (timeSinceLastUpdate <= recentThresholdMs) {
          return { status: 'online' };
        } else {
          return { status: 'offline' };
        }
      }

      // Determine status based on requested status and file update time
      if (dbStatus.requestedStatus === 'online') {
        if (timeSinceLastUpdate <= recentThresholdMs) {
          return { status: 'online' };
        } else if (currentTime - requestedAtTime <= pendingThresholdMs) {
          return { status: 'pending' };
        } else {
          return { status: 'offline' };
        }
      }

      if (dbStatus.requestedStatus === 'offline') {
        if (timeSinceLastUpdate > recentThresholdMs) {
          return { status: 'offline' };
        } else if (currentTime - requestedAtTime <= pendingStopTimeoutMs) {
          return { status: 'pending' };
        } else {
          return { status: 'offline' };
        }
      }

      return { status: 'error' };
    } catch (error) {
      log.error({ err: error }, 'error checking miner status');
      return { status: 'error' };
    }
  }

  // Parse a single stat file written by apollo-miner (USB) or apollo-miner-3 (III).
  // Returns the parsed object with int_<key> renaming applied, or null if
  // the file is empty / malformed.
  async _parseStatFileEntry(filePath, fileDetails) {
    try {
      const data = await fs.readFile(filePath);
      let received = data.toString('utf8').trim();

      if (!received) {
        log.debug({ filePath }, 'skipping empty stat file');
        return null;
      }

      received = received
        .replace(/\-nan/g, '0')
        .replace(/[^\x00-\x7F]/g, '')
        .replace('}{', '},{')
        .replace(String.fromCharCode(0), '')
        .replace(/[^\}]+$/, '');

      if (!received.startsWith('{') || !received.endsWith('}')) {
        log.debug({ filePath }, 'invalid JSON format in stat file, skipping');
        return null;
      }

      try {
        received = JSON.parse(received);
      } catch (parseError) {
        log.debug({ filePath, err: parseError }, 'failed to parse JSON in stat file');
        return null;
      }

      // The miner rewrites this file while we read it, and reports fields it has
      // no measurement for yet as empty strings — which GraphQL cannot coerce
      // into Float or Int, so a single restart replaced the whole miner page
      // with "Float cannot represent non numeric value". Empty means "no reading",
      // which is what null is for; the schema already allows it.
      const blankToNull = (value) => {
        if (value === '') return null;
        if (Array.isArray(value)) return value.map(blankToNull);
        if (value && typeof value === 'object') {
          for (const key of Object.keys(value)) value[key] = blankToNull(value[key]);
        }
        return value;
      };
      received = blankToNull(received);

      received.uuid = fileDetails.id;
      received.version = fileDetails.version;

      received.master.intervals = _.mapKeys(
        received.master.intervals,
        (value, name) => `int_${name}`
      );
      received.pool.intervals = _.mapKeys(
        received.pool.intervals,
        (value, name) => `int_${name}`
      );
      received.fans = _.mapKeys(received.fans, (value, name) => `int_${name}`);
      received.slots = _.mapKeys(received.slots, (value, name) => `int_${name}`);

      let offset = new Date().getTimezoneOffset();
      offset *= -1;
      received.date = moment(`${received.date}`, 'YYYY-MM-DD HH:mm:ss')
        .utcOffset(offset)
        .format();

      return received;
    } catch (fileError) {
      log.debug({ filePath, err: fileError }, 'error processing stat file');
      return null;
    }
  }

  // Helper method to get miner stats
  async _getMinerStats(settings, pools) {
    const stats = [];

    // --- USB boards (apollo-miner) ---
    try {
      const statsDir = getMinerRuntimeDir();
      const statsFilePattern = /^apollo-miner.*$/;
      let statsFiles = await fs.readdir(statsDir);
      // The Apollo III stat file lives in the same dir but is read separately.
      statsFiles = statsFiles.filter(
        (f) => statsFilePattern.test(f) && f !== 'apollo-miner-3.json'
      );

      const findFileDetails = (fileName) => {
        const match = fileName.match(/^(apollo-miner)(?:-v(\d+))?\.(.+)$/);
        if (match) {
          const [, , version, id] = match;
          const fileVersion = version ? 'v' + version : 'v1';
          return { version: fileVersion, id };
        }
        return null;
      };

      await Promise.all(
        statsFiles.map(async (file) => {
          const details = findFileDetails(file);
          if (!details) {
            log.debug({ file }, 'could not extract details from filename, skipping');
            return;
          }
          const parsed = await this._parseStatFileEntry(
            `${statsDir}/${file}`,
            details
          );
          if (parsed) stats.push(parsed);
        })
      );
    } catch (err) {
      // Directory may not exist on Solo Node devices with no USB units.
      if (err.code !== 'ENOENT') throw err;
    }

    // --- Apollo III internal hashboards (single stat file) ---
    // One file named `apollo-miner-3.json` (no UID), same schema as Apollo II,
    // written alongside the USB stat files. The backend miner script launches
    // the III binary; there is no separate systemd unit.
    try {
      const iiiStatsDir = getApolloIIIStatsDir();
      const iiiPath = `${iiiStatsDir}/apollo-miner-3.json`;
      await fs.access(iiiPath);
      const parsed = await this._parseStatFileEntry(iiiPath, {
        version: 'v3',
        id: '3',
      });
      if (parsed) stats.push(parsed);
    } catch (err) {
      if (err.code !== 'ENOENT') {
        log.debug({ err }, 'apollo III stats scan failed');
      }
    }

    // A stat file outlives its board: on II/III miner_start.sh clears the
    // enumerated ones only at start, so the file of a USB board gone for good
    // would sit in the totals forever. The registry forgets a board after its
    // expiry; whatever it no longer lists is dropped here. Only once the
    // registry is running — before that its snapshot is empty, not authoritative.
    const registry = getMinerBoards();
    if (registry.started) {
      try {
        registry.refreshSync(); // a board that just appeared must not be dropped
      } catch (e) {
        log.warn({ err: e }, 'board registry refresh failed');
      }
      const known = new Set(registry.snapshot().boards.map((b) => b.id));
      return stats.filter((s) => known.has(s.uuid));
    }
    return stats;
  }

  // Helper method to get ckpool stats
  // Enhancement to the _getCkpoolStats method in src/services/node.js

  async _getCkpoolStats(settings, pools) {
    return new Promise((resolve, reject) => {
      (async () => {
        // Get ckpool data
        let ckpoolData = null;
        let blockFound = false;

        try {
          if (settings?.nodeEnableSoloMining) {
            const ckpoolPoolStatsFile = path.join(getCkpoolLogsDir(), 'pool/pool.status');

            const ckpoolUsersStatsDir = path.join(getCkpoolLogsDir(), 'users/');

            // Check for block found in ckpool log
            const ckpoolLogFile = path.join(getCkpoolLogsDir(), 'ckpool.log');

            const blockFoundFlagFile = path.join(getCkpoolLogsDir(), 'BLOCKFOUND.log');

            try {
              // Check if block found flag exists
              await fs.access(blockFoundFlagFile, fs.constants.F_OK);
              blockFound = true;
            } catch (err) {
              // Flag file doesn't exist, check log for "BLOCK ACCEPTED"
              if (err.code === 'ENOENT') {
                try {
                  const logContent = await fs.readFile(ckpoolLogFile, 'utf8');
                  if (logContent.includes('BLOCK ACCEPTED')) {
                    // Block found! Create the flag file
                    await fs.writeFile(
                      blockFoundFlagFile,
                      new Date().toISOString()
                    );
                    blockFound = true;
                  }
                } catch (logErr) {
                  log.warn({ err: logErr }, 'error reading ckpool log');
                }
              } else {
                throw err;
              }
            }

            try {
              // Check if the directory exists
              await fs.stat(ckpoolUsersStatsDir);
            } catch (err) {
              if (err.code === 'ENOENT') {
                // Directory does not exist
                resolve(ckpoolData); // Resolve with null data
                return;
              }
              throw err; // Re-throw other errors
            }

            // Get list of user files
            let filenames = await fs.readdir(ckpoolUsersStatsDir);
            filenames = filenames.filter(async (filename) => {
              // Skip .DS_Store files
              if (filename.match(/\.ds_store/i)) return false;
              
              // Check file modification time
              const filePath = path.join(ckpoolUsersStatsDir, filename);
              const stats = await fs.stat(filePath);
              const fileAge = Date.now() - stats.mtimeMs;
              const oneDayInMs = 24 * 60 * 60 * 1000;
              
              // Skip files older than 1 day
              return fileAge <= oneDayInMs;
            });
            
            // Wait for all async filter operations to complete
            filenames = await Promise.all(filenames);

            // Process each user file
            const usersDataPromises = filenames.map(async (filename) => {
              try {
                const ckpoolUsersStatsFile = path.join(ckpoolUsersStatsDir, filename);
                const ckpoolUsersData = await fs.readFile(ckpoolUsersStatsFile, 'utf8');
                
                // Skip empty files
                if (!ckpoolUsersData.trim()) {
                  log.debug({ filename }, 'skipping empty solo file');
                  return null;
                }

                // Clean and validate JSON data
                let cleanedData = ckpoolUsersData
                  .trim()
                  .replace(/\-nan/g, '0')
                  .replace(/[^\x00-\x7F]/g, '')
                  .replace('}{', '},{')
                  .replace(String.fromCharCode(0), '')
                  .replace(/[^\}]+$/, '');

                // Validate JSON structure
                if (!cleanedData.startsWith('{') || !cleanedData.endsWith('}')) {
                  log.debug({ filename }, 'invalid JSON format in solo file, skipping');
                  return null;
                }

                try {
                  return JSON.parse(cleanedData);
                } catch (parseError) {
                  log.debug({ filename, err: parseError }, 'failed to parse JSON in solo file');
                  return null;
                }
              } catch (fileError) {
                log.debug({ filename, err: fileError }, 'error processing solo file');
                return null;
              }
            });

            const usersData = (await Promise.all(usersDataPromises)).filter(data => data !== null);

            // Parse pool stats file
            let poolData = {};
            try {
              poolData = await this._parseFileToJsonArray(ckpoolPoolStatsFile);
            } catch (poolError) {
              log.debug({ err: poolError }, 'error parsing pool stats file');
            }

            ckpoolData = {
              pool: poolData,
              users: usersData,
              blockFound: blockFound,
            };
          }

          resolve(ckpoolData);
        } catch (err) {
          reject(err);
        }
      })();
    });
  }

  // Helper method to parse file to JSON array
  async _parseFileToJsonArray(filePath) {
    try {
      // Read the file content
      const fileContent = await fs.readFile(filePath, 'utf8');

      // Divide the file content into lines
      const lines = fileContent.split('\n');

      const allKeys = {};

      // Analyze each line
      lines.forEach((line) => {
        if (line.trim() !== '') {
          try {
            const jsonObject = JSON.parse(line);

            // Add the keys to the allKeys object
            Object.entries(jsonObject).forEach(([key, value]) => {
              if (!allKeys[key]) {
                allKeys[key] = null;
              }
              allKeys[key] = value;
            });
          } catch (error) {
            log.debug({ err: error }, 'error parsing a line of the stats file');
          }
        }
      });

      return allKeys;
    } catch (error) {
      log.warn({ err: error }, 'error reading the stats file');
      return {};
    }
  }

  // Helper method to execute shell commands
  _execCommand(command) {
    return new Promise((resolve, reject) => {
      exec(command, (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim());
      });
    });
  }
}

module.exports = (knex, utils) => new MinerService(knex, utils);
