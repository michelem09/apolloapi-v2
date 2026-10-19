// Board registry publishing: on change, never on cadence.
jest.unmock('../src/app/scheduler');

const mockRegistry = {
  started: false,
  listeners: new Set(),
  snap: { boards: [], hasMiner: true, hasUsbMiners: false, usbCount: 0, usbActiveCount: 0, deviceFamily: 'solo-node' },
  nextRefresh: false,
  snapshot() { return this.snap; },
  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  async refresh() {
    if (this.nextRefresh) for (const fn of this.listeners) fn(this.snap);
    return this.nextRefresh;
  },
  start: jest.fn(),
  stop: jest.fn(),
};
jest.mock('../src/minerBoards', () => ({ getMinerBoards: () => mockRegistry }));

jest.mock('../src/services', () => ({
  miner: { getStats: jest.fn(), checkOnline: jest.fn() },
  mcu: { getStats: jest.fn() },
  node: { getStats: jest.fn() },
  solo: { getStats: jest.fn() },
  services: { getStats: jest.fn() },
  serviceMonitor: null,
}));

describe('scheduler: minerBoards topic', () => {
  let scheduler;
  let publishSpy;
  let TOPICS;
  let services;

  const boardCalls = () => publishSpy.mock.calls.filter(([t]) => t === TOPICS.MINER_BOARDS);

  beforeEach(() => {
    jest.resetModules();
    const pubsub = require('../src/graphql/pubsub');
    TOPICS = require('../src/graphql/topics');
    services = require('../src/services');
    publishSpy = jest.spyOn(pubsub, 'publish').mockImplementation(() => {});
    mockRegistry.listeners.clear();
    mockRegistry.nextRefresh = false;
    mockRegistry.start.mockClear();
    mockRegistry.stop.mockClear();
    services.miner.getStats.mockResolvedValue({});
    services.miner.checkOnline.mockResolvedValue({});
    scheduler = require('../src/app/scheduler');
  });

  afterEach(() => publishSpy.mockRestore());

  it('pushAllStats includes the current snapshot (initial fill on WS connect)', async () => {
    await scheduler.pushAllStats();
    const calls = boardCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual({ minerBoards: { result: mockRegistry.snap, error: null } });
  });

  it('pushMinerStats refreshes the registry and publishes boards only when it changed', async () => {
    scheduler.startMinerBoards();
    expect(mockRegistry.start).toHaveBeenCalledTimes(1);

    mockRegistry.nextRefresh = false;
    await scheduler.pushAllStats(); // one MINER_BOARDS from the initial fill only
    const baseline = boardCalls().length;

    // Same reading again through pushMinerStats alone: no new board publish.
    // (pushAllStats is the only exported way in; count the delta instead.)
    await scheduler.pushAllStats();
    expect(boardCalls().length).toBe(baseline + 1); // just the unconditional initial-fill push

    mockRegistry.nextRefresh = true;
    await scheduler.pushAllStats();
    // initial-fill push + one from the listener on the changed refresh
    expect(boardCalls().length).toBe(baseline + 1 + 2);
  });

  it('startMinerBoards subscribes once and the listener publishes the snapshot', () => {
    scheduler.startMinerBoards();
    scheduler.startMinerBoards();
    expect(mockRegistry.listeners.size).toBe(1);
    expect(mockRegistry.start).toHaveBeenCalledTimes(1);

    for (const fn of mockRegistry.listeners) fn(mockRegistry.snap);
    expect(boardCalls()).toHaveLength(1);

    scheduler.stopMinerBoards();
    expect(mockRegistry.listeners.size).toBe(0);
    expect(mockRegistry.stop).toHaveBeenCalled();
  });

  it('a failing registry refresh does not stop the MINER publish', async () => {
    mockRegistry.refresh = jest.fn().mockRejectedValue(new Error('boom'));
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    await scheduler.pushAllStats();
    errSpy.mockRestore();
    expect(publishSpy.mock.calls.some(([t]) => t === TOPICS.MINER)).toBe(true);
  });
});
