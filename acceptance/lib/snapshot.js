const { sshExec } = require('./ssh');

const DIR = '/var/lib/apollo/acceptance-snapshot';

// What a run is allowed to break, it must be able to put back.
//
// The database is the whole configured state of the app, so a copy of it — plus
// the sqlite sidecars, which carry writes the main file does not yet have — is
// what turns a failed run into a restore instead of a re-image. The system
// timezone lives outside the DB, so it is recorded separately.
const takeSnapshot = async (profile) => {
  const db = (await sshExec(profile, 'grep -m1 ^DATABASE_URL= /opt/apolloapi/.env | cut -d= -f2-')).stdout;
  if (!db) throw new Error('could not read DATABASE_URL from the device .env');

  const timezone = (await sshExec(profile, 'timedatectl show -p Timezone --value')).stdout;

  await sshExec(profile, `sudo mkdir -p ${DIR} && sudo rm -f ${DIR}/*`);
  // -wal and -shm may not exist; losing them is not an error.
  await sshExec(
    profile,
    `sudo cp "${db}" ${DIR}/db && for s in -wal -shm; do sudo cp "${db}$s" ${DIR}/db$s 2>/dev/null || true; done`
  );

  return { db, timezone, at: new Date().toISOString() };
};

const restoreSnapshot = async (profile, snapshot) => {
  const notes = [];

  // Stop the writer first: restoring a sqlite file under a running process
  // leaves it with stale pages and a sidecar that no longer matches.
  await sshExec(profile, 'sudo systemctl stop apollo-api', { timeoutMs: 60000 });
  await sshExec(
    profile,
    `sudo cp ${DIR}/db "${snapshot.db}" && for s in -wal -shm; do sudo cp ${DIR}/db$s "${snapshot.db}$s" 2>/dev/null || sudo rm -f "${snapshot.db}$s"; done`
  );

  const now = (await sshExec(profile, 'timedatectl show -p Timezone --value')).stdout;
  if (now !== snapshot.timezone) {
    await sshExec(profile, `sudo timedatectl set-timezone ${snapshot.timezone}`);
    notes.push(`timezone put back to ${snapshot.timezone}`);
    // Precise about what this costs: the running services already hold the zone
    // the device started on, which is the one just restored — nothing is wrong
    // with their logs. But rebootPending reads the mtime of /etc/localtime, and
    // that cannot tell "changed" from "changed and changed back", so the panel
    // will claim a restart is owed until the next boot. Conservative, not wrong.
    notes.push('the panel will report a restart owed until the next boot, though the zone is back where it started');
  }

  await sshExec(profile, 'sudo systemctl start apollo-api', { timeoutMs: 60000 });
  return notes;
};

module.exports = { takeSnapshot, restoreSnapshot, DIR };
