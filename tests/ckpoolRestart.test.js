const childProcess = require('child_process');
const utils = require('../src/utils');
const fs = require('fs').promises;

jest.mock('fs', () => ({
  promises: {
    mkdir: jest.fn(),
    readFile: jest.fn(),
    writeFile: jest.fn(),
    access: jest.fn(),
    stat: jest.fn(),
    rename: jest.fn(),
    unlink: jest.fn(),
    readdir: jest.fn(),
  },
}));

jest.mock('child_process', () => ({ exec: jest.fn() }));

// A settings save must not start a ckpool the user stopped: only turning solo
// mining on starts it, every other conf change uses try-restart.
describe('ckpool systemctl actions', () => {
  const realEnv = process.env.NODE_ENV;
  const enoent = () => Object.assign(new Error('nope'), { code: 'ENOENT' });

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    process.env.NODE_ENV = 'production';
    // Set here: the jest config resets mock implementations between tests.
    childProcess.exec.mockImplementation((cmd, options, callback) => {
      const cb = typeof options === 'function' ? options : callback;
      cb(null, { stdout: 'ok', stderr: '' });
    });
    fs.mkdir.mockResolvedValue();
    fs.access.mockRejectedValue(enoent());
    fs.readFile.mockRejectedValue(enoent());
    fs.stat.mockRejectedValue(enoent());
    fs.readdir.mockResolvedValue([]);
    fs.rename.mockResolvedValue();
    fs.unlink.mockResolvedValue();
    fs.writeFile.mockResolvedValue();
  });

  afterEach(() => {
    process.env.NODE_ENV = realEnv;
  });

  const ckpoolCmds = () =>
    childProcess.exec.mock.calls
      .map(([cmd]) => cmd)
      .filter((cmd) => /systemctl .*ckpool/.test(cmd));

  describe('manageBitcoinConf', () => {
    it('on -> on: try-restart, never restart or start', async () => {
      await utils.auth.manageBitcoinConf({ nodeEnableSoloMining: true }, { soloWasEnabled: true });
      expect(ckpoolCmds()).toEqual([
        'sudo systemctl enable ckpool',
        'sudo systemctl try-restart ckpool',
      ]);
    });

    it('off -> on: enable and start', async () => {
      await utils.auth.manageBitcoinConf({ nodeEnableSoloMining: true }, { soloWasEnabled: false });
      expect(ckpoolCmds()).toEqual([
        'sudo systemctl enable ckpool',
        'sudo systemctl start ckpool',
      ]);
    });

    it('on -> off: stop and disable, as before', async () => {
      await utils.auth.manageBitcoinConf({ nodeEnableSoloMining: false }, { soloWasEnabled: true });
      expect(ckpoolCmds()).toEqual([
        'sudo systemctl stop ckpool',
        'sudo systemctl disable ckpool',
      ]);
    });

    it('boot path (no options): enable and restart, unchanged', async () => {
      await utils.auth.manageBitcoinConf({ nodeEnableSoloMining: true });
      expect(ckpoolCmds()).toEqual([
        'sudo systemctl enable ckpool',
        'sudo systemctl restart ckpool',
      ]);
    });
  });

  describe('changeNodeRpcPassword', () => {
    const { knex } = require('../src/db');
    beforeEach(async () => {
      await knex('settings').del();
      await knex('settings').insert({});
      fs.readFile.mockImplementation(async (file) =>
        String(file).endsWith('api.conf')
          ? 'rpcuser=futurebit\nrpcpassword=old\n'
          : '{"btcd":[{"pass": "old","notify":true}]}'
      );
      fs.access.mockResolvedValue();
      fs.stat.mockResolvedValue({ mode: 0o100644 });
    });

    it('try-restarts ckpool when solo mining is on', async () => {
      await utils.auth.changeNodeRpcPassword({ nodeEnableSoloMining: true });
      expect(ckpoolCmds()).toEqual(['sudo systemctl try-restart ckpool']);
    });

    it('leaves ckpool alone when solo mining is off', async () => {
      await utils.auth.changeNodeRpcPassword({ nodeEnableSoloMining: false });
      expect(ckpoolCmds()).toEqual([]);
    });
  });
});
