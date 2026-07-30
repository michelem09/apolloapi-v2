const utils = require('../src/utils');

describe('authentication utilities', () => {
  // Three bcrypt operations at cost factor 12, through bcryptjs (pure JS, no native
  // binding): ~2s on an idle laptop, and several times that when jest runs it
  // alongside 40 other suites. That is the work being asked for, not a hang — so it
  // gets a timeout that fits it instead of failing the suite at the default 10s.
  const BCRYPT_TIMEOUT_MS = 60000;

  it('hashes and verifies passwords', async () => {
    const hash = await utils.auth.hashPassword('correct horse battery staple');

    await expect(
      utils.auth.comparePassword('correct horse battery staple', hash)
    ).resolves.toBe(true);
    await expect(utils.auth.comparePassword('wrong', hash)).resolves.toBe(false);
  }, BCRYPT_TIMEOUT_MS);

  it('rejects empty password comparisons', () => {
    expect(utils.auth.comparePassword('', 'hash')).toBe(false);
    expect(utils.auth.comparePassword('password', '')).toBe(false);
  });

  it('creates an access token', () => {
    expect(utils.auth.generateAccessToken().accessToken).toEqual(
      expect.any(String)
    );
  });
});
