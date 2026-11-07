// phone-repair-pos/scripts/build-common.js
const fs = require('node:fs');
const path = require('node:path');

function copyExeWithRetry(exeName, targetExePath) {
  try {
    fs.copyFileSync(process.execPath, targetExePath, fs.constants.COPYFILE_EXCL);
    return true;
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EEXIST') {
      throw new Error(`${path.basename(targetExePath)} could not be staged; remove the stale staging directory and retry`, { cause: err });
    }
    throw err;
  }
}

function writeBuildManifest(outputDir, artifact, inputs) {
  const postjectPackage = require('../node_modules/postject/package.json');
  const manifest = {
    artifact,
    built_at: new Date().toISOString(),
    node: process.version,
    runtime: path.basename(process.execPath),
    postject: postjectPackage.version,
    inputs: inputs.map(file => path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/')).sort()
  };
  fs.writeFileSync(path.join(outputDir, `${artifact}.manifest.json`), JSON.stringify(manifest, null, 2) + '\n');
}

function generateLoaderBundle({ banner = '', staticFiles = null, modules = {}, entryCode = '' }) {
  let modulesCode = '';
  for (const [modId, code] of Object.entries(modules)) {
    modulesCode += `
__modules__['${modId}'] = {
  fn: (module, exports, require) => {
${code}
  }
};
`;
  }

  return `
${banner}
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const readline = require('node:readline');
const { DatabaseSync } = require('node:sqlite');
const { json } = require('node:stream/consumers');
const { parseArgs } = require('node:util');

${staticFiles ? `global.__EMBEDDED_STATIC__ = ${JSON.stringify(staticFiles)};` : ''}

const __modules__ = {};

function __require__(id) {
  let cleanId = id.replace(/\\\\/g, '/');
  if (cleanId.endsWith('.js')) cleanId = cleanId.slice(0, -3);
  if (!cleanId.startsWith('./')) cleanId = './' + cleanId;

  if (__modules__[cleanId]) {
    if (!__modules__[cleanId].loaded) {
      const module = { exports: {} };
      __modules__[cleanId].fn(module, module.exports, __require__);
      __modules__[cleanId].exports = module.exports;
      __modules__[cleanId].loaded = true;
    }
    return __modules__[cleanId].exports;
  }
  return require(id);
}

${modulesCode}

${entryCode}
`;
}

function setWindowsGuiSubsystem(exePath) {
  try {
    const fd = fs.openSync(exePath, 'r+');
    const buf = Buffer.alloc(512);
    fs.readSync(fd, buf, 0, 512, 0);
    const peOffset = buf.readUInt32LE(0x3c);

    const peBuf = Buffer.alloc(256);
    fs.readSync(fd, peBuf, 0, 256, peOffset);
    if (peBuf.toString('ascii', 0, 4) !== 'PE\0\0') {
      fs.closeSync(fd);
      return false;
    }

    const magic = peBuf.readUInt16LE(24);
    // Subsystem sits at optional-header offset 68 in BOTH PE formats; 44 in
    // PE32 is MajorImageVersion, and writing there corrupted a field while
    // leaving the console subsystem untouched.
    const subsystemOffset = peOffset + 24 + 68;

    const subBuf = Buffer.alloc(2);
    subBuf.writeUInt16LE(2, 0); // IMAGE_SUBSYSTEM_WINDOWS_GUI = 2
    fs.writeSync(fd, subBuf, 0, 2, subsystemOffset);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    console.warn(`Warning: Could not set GUI subsystem: ${err.message}`);
    return false;
  }
}

module.exports = { copyExeWithRetry, generateLoaderBundle, setWindowsGuiSubsystem, writeBuildManifest };
