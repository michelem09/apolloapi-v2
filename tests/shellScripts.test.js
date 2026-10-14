// requireActual: the shared jest setup mocks child_process for the service tests,
// and these need to really run bash.
const { execFileSync } = jest.requireActual('child_process');
const path = require('path');

// Shell tests that stub the system commands and drive the real backend scripts.
// Running them through jest puts them in every `yarn test`.
describe.each(['miner_start.test.sh', 'update_system.test.sh'])('%s', (name) => {
  it('passes', () => {
    try {
      execFileSync('bash', [path.join(__dirname, name)], { encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      throw new Error(`bash exited ${err.status}\n${err.stdout || ''}${err.stderr || ''}`);
    }
  }, 60000);
});
