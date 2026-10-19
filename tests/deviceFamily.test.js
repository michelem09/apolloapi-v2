const fs = require('fs');
const os = require('os');
const path = require('path');
const { getDeviceFamily, parseBoardName, familyOf, resetDeviceFamilyCache } = require('../src/deviceFamily');

describe('deviceFamily', () => {
  let dir;
  beforeEach(() => {
    resetDeviceFamilyCache();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'family-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fam = (text) => {
    const file = path.join(dir, `r${Math.random()}`);
    fs.writeFileSync(file, text);
    return getDeviceFamily({ ARMBIAN_RELEASE_FILE: file });
  };

  test('maps the real BOARD_NAMEs', () => {
    expect(fam('BOARD_NAME="Apollo 3"\n')).toBe('apollo-iii');
    expect(fam('BOARD_NAME="Solo Node"\n')).toBe('solo-node');
    expect(fam('BOARD_NAME="FutureBit Apollo II"\n')).toBe('legacy');
    expect(fam('BOARD_NAME="Rock 5B Plus"\n')).toBe('unknown');
  });

  test('missing file is unknown and not cached', () => {
    const file = path.join(dir, 'later');
    expect(getDeviceFamily({ ARMBIAN_RELEASE_FILE: file })).toBe('unknown');
    fs.writeFileSync(file, 'BOARD_NAME=\'Solo Node\'\n');
    expect(getDeviceFamily({ ARMBIAN_RELEASE_FILE: file })).toBe('solo-node');
  });

  test('parser: last assignment wins, comment is empty', () => {
    expect(parseBoardName('BOARD_NAME=a\nexport BOARD_NAME="b c"\n')).toBe('b c');
    expect(parseBoardName('BOARD_NAME=#x\n')).toBeNull();
    expect(familyOf('FutureBit Apollo III')).toBe('unknown');
  });
});
