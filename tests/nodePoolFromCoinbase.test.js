// tests/nodePoolFromCoinbase.test.js
const createNodeService = require('../src/services/node');

const hex = (ascii) => Buffer.from(ascii, 'ascii').toString('hex');

describe('NodeService._extractPoolFromCoinbase', () => {
  const svc = createNodeService({}, {});
  const apollo = { id: 148, name: 'FutureBit Apollo Solo', slug: 'futurebitapollosolo' };

  it('recognises a block found by an Apollo with a custom signature (block 973262)', () => {
    const coinbase =
      '03ced90e00047888df6a0402c188340c1e04ae6ab9cf0000000000000a41706f6c6c6f252f' +
      '4675747572654269742d536f6c6f2041706f6c6c6f2052756e2062792057696c736f6e2f';
    expect(svc._extractPoolFromCoinbase(coinbase)).toEqual(apollo);
  });

  it('recognises a block found by an Apollo with the default signature', () => {
    expect(svc._extractPoolFromCoinbase(hex('\x03abc/FutureBit-mined by Solo Apollo/'))).toEqual(apollo);
  });

  it('still recognises the known pools', () => {
    expect(svc._extractPoolFromCoinbase(hex('\x03abc/Foundry USA Pool #dropgold/'))).toMatchObject({ name: 'Foundry USA' });
  });

  it('returns null for a coinbase with no tag', () => {
    expect(svc._extractPoolFromCoinbase(hex('\x03abc\x00\x01'))).toBeNull();
  });
});
