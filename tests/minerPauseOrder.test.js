// A click that systemd refuses must not pause the automation: the pause is the
// consequence of a command that was accepted, not of the attempt.

const { knex } = require('../src/db');
const makeMinerService = require('../src/services/miner');

describe('miner start/stop/restart and the automation pause', () => {
  let miner;

  beforeEach(async () => {
    await knex('service_status').where({ service_name: 'miner' }).del();
    await knex('service_status').insert({
      service_name: 'miner',
      status: 'offline',
      requested_status: 'offline',
      requested_at: 1000,
    });
    miner = makeMinerService(knex, {});
    jest.spyOn(miner, '_notifyServicesStatus').mockImplementation(() => {});
    jest.spyOn(miner, '_reevaluateAutomation').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it.each(['start', 'stop', 'restart'])('%s: pauses the automation after the command was accepted', async (action) => {
    const order = [];
    jest.spyOn(miner, '_execCommand').mockImplementation(async () => {
      order.push('command');
    });
    jest.spyOn(miner, '_pauseAutomation').mockImplementation(async () => {
      order.push('pause');
    });

    await miner[action]();

    expect(order).toEqual(['command', 'pause']);
  });

  it.each(['start', 'stop', 'restart'])('%s: a refused command does not pause the automation', async (action) => {
    jest.spyOn(miner, '_execCommand').mockRejectedValue(new Error('a terminal is required'));
    const pause = jest.spyOn(miner, '_pauseAutomation').mockResolvedValue(undefined);

    await expect(miner[action]()).rejects.toMatchObject({
      extensions: { code: 'SERVICE_COMMAND_FAILED', service: 'miner', action },
    });

    expect(pause).not.toHaveBeenCalled();
    // ...and the request that was recorded for it is gone again.
    const row = await knex('service_status').where({ service_name: 'miner' }).first();
    expect(row).toMatchObject({ status: 'offline', requested_status: 'offline' });
  });

  it('passes the source through: a command from the automation does not pause it', async () => {
    jest.spyOn(miner, '_execCommand').mockResolvedValue({ stdout: '', stderr: '' });
    const pause = jest.spyOn(miner, '_pauseAutomation');
    await miner.start({ source: 'automation' });
    expect(pause).toHaveBeenCalledWith('automation');
    // _pauseAutomation itself ignores anything but 'user'.
    const { automation } = require('../src/services');
    const setOverride = jest.spyOn(automation, 'setOverride').mockResolvedValue(undefined);
    await miner._pauseAutomation('automation');
    expect(setOverride).not.toHaveBeenCalled();
  });

  it.each(['start', 'stop', 'restart'])(
    '%s: a failure AFTER the command was accepted is logged, not reported as a refusal',
    async (action) => {
      jest.spyOn(miner, '_execCommand').mockResolvedValue({ stdout: '', stderr: '' });
      jest.spyOn(miner, '_pauseAutomation').mockRejectedValue(new Error('SQLITE_BUSY'));

      await expect(miner[action]()).resolves.toBeUndefined();

      // The request stays recorded: systemd accepted it.
      const row = await knex('service_status').where({ service_name: 'miner' }).first();
      expect(row.status).toBe('pending');
    }
  );
});
