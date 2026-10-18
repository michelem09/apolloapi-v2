// The values a journey types, in one place. A profile's `journeys` object
// overrides any of them (per device: the worker names the unit it mines on).
module.exports = (hostname = 'device', overrides = {}) => ({
  // The address the solo journey mines to.
  soloAddress: '36kNhMVxznYLhz3YhShXAEbBCDf5pZgojo',
  poolOption: 'Braiins',
  worker: `michelem09.${hostname}-test`,
  // Differs from `worker` so the padded save is a change after the pooled journey.
  paddedWorker: `michelem09.${hostname}-pad`,
  paddedUrl: 'stratum+tcp://stratum.braiins.com:3333',
  paddedHost: 'stratum.braiins.com',
  // How long the solo journey lets the miner hash once ckpool shows a rate.
  mineDwellMs: 60000,
  nodeLegs: { core: '28.1', knots: '29.3' },
  ...overrides,
});
