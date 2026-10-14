// requireActual: the shared jest setup mocks child_process for the service tests,
// and this one needs to really run bash.
const { execFileSync } = jest.requireActual('child_process');
const path = require('path');

// The rollback tests are bash: they source backend/update as a library and drive
// the real backup/restore functions against a real temporary tree. Running them
// through jest means they gate every `yarn test` and the release workflow, rather
// than being a script someone has to remember to run.
describe('updater rollback (failure injection)', () => {
  it('recovers the device on every injected failure', () => {
    const script = path.join(__dirname, 'rollback.test.sh');
    try {
      execFileSync('bash', [script], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      throw new Error(
        `bash exited ${err.status} (${err.message})\n${err.stdout || ''}${err.stderr || ''}`
      );
    }
  }, 60000);
});
