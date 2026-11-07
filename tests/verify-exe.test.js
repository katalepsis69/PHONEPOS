const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  inspectPe,
  containsSeaMarkers,
  listFilesRecursive,
  newestMtime,
  snapshotPaths,
  verifyBuildManifest
} = require('../scripts/verify-exe');
const { parseDuration } = require('../scripts/generate-license');
const { verifyCustomerRelease } = require('../scripts/release-customer');

test('inspectPe validates MZ and PE signatures', () => {
  const buffer = Buffer.alloc(256);
  buffer.write('MZ', 0, 'ascii');
  buffer.writeUInt32LE(128, 0x3c);
  buffer.write('PE\0\0', 128, 'ascii');
  assert.deepEqual(inspectPe(buffer), { peOffset: 128 });
  assert.throws(() => inspectPe(Buffer.alloc(256)), /MZ/);
});

test('license duration parser rejects values that previously became lifetime', () => {
  assert.equal(parseDuration(undefined), 0);
  assert.equal(parseDuration('0'), 0);
  assert.equal(parseDuration('365'), 365);
  for (const invalid of ['', 'abc', '-1', '1.5', 'Infinity', ' 30']) {
    assert.throws(() => parseDuration(invalid), /Validity days/);
  }
});

test('customer release verifier allows only the POS executable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'customer-release-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'TechPartsPOS.exe'), 'test executable');
    assert.deepEqual(verifyCustomerRelease(dir), ['TechPartsPOS.exe']);
    fs.writeFileSync(path.join(dir, 'LicenseGenerator.exe'), 'vendor tool');
    assert.throws(() => verifyCustomerRelease(dir), /private or live-state material/);
    fs.rmSync(path.join(dir, 'LicenseGenerator.exe'));
    fs.mkdirSync(path.join(dir, 'data'));
    assert.throws(() => verifyCustomerRelease(dir), /regular files only/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('artifact manifest rejects the wrong runtime or tool version', () => {
  const dir = fs.mkdtempSync(path.join(__dirname, 'manifest-test-'));
  const artifact = path.join(dir, 'TechPartsPOS.exe');
  const manifestPath = `${artifact}.manifest.json`;
  try {
    fs.writeFileSync(artifact, 'artifact');
    fs.writeFileSync(manifestPath, '{}');
    const input = path.relative(path.join(__dirname, '..'), __filename).replace(/\\/g, '/');
    assert.throws(() => verifyBuildManifest(artifact, {
      artifact: 'TechPartsPOS.exe', node: 'v0.0.0', postject: '1.0.0-alpha.6', inputs: [input]
    }, '1.0.0-alpha.6'), /built with/);
    assert.throws(() => verifyBuildManifest(artifact, {
      artifact: 'TechPartsPOS.exe', node: process.version, postject: 'wrong', inputs: [input]
    }, '1.0.0-alpha.6'), /postject version is stale/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('containsSeaMarkers requires both resource and sentinel markers', () => {
  const complete = Buffer.from('NODE_SEA_BLOB NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2');
  assert.equal(containsSeaMarkers(complete), true);
  assert.equal(containsSeaMarkers(Buffer.from('NODE_SEA_BLOB')), false);
});

test('recursive input and snapshot helpers detect changes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verifier-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'nested'));
    const file = path.join(dir, 'nested', 'input.js');
    fs.writeFileSync(file, 'one');
    assert.deepEqual(listFilesRecursive(dir), [file]);
    assert.equal(newestMtime([file]), fs.statSync(file).mtimeMs);
    const before = snapshotPaths([dir]);
    fs.writeFileSync(file, 'two');
    assert.notEqual(snapshotPaths([dir]), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
