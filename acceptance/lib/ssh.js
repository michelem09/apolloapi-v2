const { execFile } = require('child_process');
const { promisify } = require('util');

const run = promisify(execFile);

// Every command the run issues on the device goes through here: argv array, no
// shell on this side, and a timeout, so one wedged command cannot hang the run.
const sshExec = async (profile, command, { timeoutMs = 30000 } = {}) => {
  const { stdout, stderr } = await run(
    'ssh',
    [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'BatchMode=yes',
      '-o', `ConnectTimeout=${Math.ceil(timeoutMs / 1000)}`,
      `${profile.user}@${profile.host}`,
      command,
    ],
    { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }
  );
  return { stdout: stdout.trim(), stderr: stderr.trim() };
};

// Up to `attempts` tries, for the window where a device is rebooting.
const sshWait = async (profile, { attempts = 40, everyMs = 5000 } = {}) => {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await sshExec(profile, 'true', { timeoutMs: 8000 });
      return i;
    } catch {
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
  throw new Error(`device never came back over ssh after ${attempts} attempts`);
};

module.exports = { sshExec, sshWait };
