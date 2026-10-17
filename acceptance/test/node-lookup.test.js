// Offline tier: runs the command the suite sends to the device, with sh, against
// a scratch tree standing in for the device's filesystem.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { nodeLookupCommand } = require('../lib/api');

const fakeNode = (p) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '#!/bin/sh\n');
  fs.chmodSync(p, 0o755);
};

const lookup = ({ runtime, nvm, onPath }) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-lookup-'));
  try {
    const paths = {
      runtime: path.join(root, 'runtime/node/bin/node'),
      nvmGlob: path.join(root, 'nvm/versions/node/*/bin/node'),
    };
    if (runtime) fakeNode(paths.runtime);
    (nvm || []).forEach((v) => fakeNode(path.join(root, `nvm/versions/node/${v}/bin/node`)));
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    if (onPath) fakeNode(path.join(bin, 'node'));
    // sh and ls only: the PATH holds nothing else, so `command -v node` is ours to decide.
    for (const c of ['ls', 'tail']) fs.symlinkSync(execFileSync('sh', ['-c', `command -v ${c}`]).toString().trim(), path.join(bin, c));
    const out = execFileSync('/bin/sh', ['-c', nodeLookupCommand(paths)], { env: { PATH: bin } }).toString().trim();
    return { out: out.replaceAll(fs.realpathSync(root), '<root>').replaceAll(root, '<root>') };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
};

test('the runtime wins even when PATH and nvm also have a node', () => {
  assert.equal(lookup({ runtime: true, nvm: ['v21.6.2'], onPath: true }).out, '<root>/runtime/node/bin/node');
});

test('without the runtime (a 2.1.x device) PATH is next', () => {
  assert.equal(lookup({ nvm: ['v21.6.2'], onPath: true }).out, '<root>/bin/node');
});

test('with only nvm, the highest-sorted nvm node is used', () => {
  assert.equal(lookup({ nvm: ['v20.1.0', 'v21.6.2'] }).out, '<root>/nvm/versions/node/v21.6.2/bin/node');
});

test('nothing anywhere gives an empty answer, which deviceNode turns into an error', () => {
  assert.equal(lookup({}).out, '');
});
