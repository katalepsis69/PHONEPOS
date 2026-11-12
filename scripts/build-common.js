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

// Swap the node.exe hexagon for the brand mark without new dependencies:
// overwrite the existing RT_ICON slots in place (every brand image must fit
// its slot) and rewrite RT_GROUP_ICON to reference only the brand sizes.
// No section is resized, so the PE layout postject produced stays intact.
function setExeIcon(exePath, icoPath) {
  const buf = fs.readFileSync(exePath);
  const ico = fs.readFileSync(icoPath);
  const pe = buf.readUInt32LE(0x3c);
  const nsec = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  let sec = null;
  for (let i = 0; i < nsec; i++) {
    const off = pe + 24 + optSize + i * 40;
    if (buf.toString('ascii', off, off + 8).replace(/\0/g, '') === '.rsrc') {
      sec = { va: buf.readUInt32LE(off + 12), raw: buf.readUInt32LE(off + 20) };
      break;
    }
  }
  if (!sec) throw new Error(`${path.basename(exePath)} has no .rsrc section; cannot embed icon`);

  const slots = new Map();
  const groups = [];
  (function walk(base, level, type, id) {
    const n = buf.readUInt16LE(base + 12) + buf.readUInt16LE(base + 14);
    for (let i = 0; i < n; i++) {
      const e = base + 16 + i * 8;
      const name = buf.readUInt32LE(e);
      const off = buf.readUInt32LE(e + 4);
      if (off & 0x80000000) {
        walk(sec.raw + (off & 0x7fffffff), level + 1, level === 0 ? name : type, level === 1 ? name : id);
      } else {
        const d = sec.raw + off;
        const leaf = { entry: d, file: sec.raw + (buf.readUInt32LE(d) - sec.va), size: buf.readUInt32LE(d + 4) };
        if (type === 3) slots.set(id, leaf);
        if (type === 14) groups.push(leaf);
      }
    }
  })(sec.raw, 0, 0, 0);
  if (!groups.length) throw new Error(`${path.basename(exePath)} has no RT_GROUP_ICON; cannot embed icon`);

  const images = [];
  const count = ico.readUInt16LE(4);
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const bytes = ico.readUInt32LE(e + 8);
    const start = ico.readUInt32LE(e + 12);
    images.push({ w: ico[e], h: ico[e + 1], cc: ico[e + 2], planes: ico.readUInt16LE(e + 4), bitcount: ico.readUInt16LE(e + 6), bytes, data: ico.slice(start, start + bytes) });
  }

  const group = groups[0];
  const oldCount = buf.readUInt16LE(group.file + 4);
  const entries = [];
  for (let i = 0; i < oldCount; i++) {
    const e = group.file + 6 + i * 14;
    const w = buf[e], h = buf[e + 1], nID = buf.readUInt16LE(e + 12);
    const img = images.find(m => m.w === w && m.h === h);
    const slot = slots.get(nID);
    if (!img || !slot) continue;
    if (img.bytes > slot.size) throw new Error(`brand icon ${w || 256}x${h || 256} (${img.bytes}B) exceeds exe slot ${nID} (${slot.size}B)`);
    img.data.copy(buf, slot.file);
    buf.writeUInt32LE(img.bytes, slot.entry + 4);
    entries.push({ ...img, nID });
  }
  if (!entries.length) throw new Error('no brand icon size matches the exe icon slots');
  const groupBytes = 6 + entries.length * 14;
  if (groupBytes > group.size) throw new Error('rewritten icon group exceeds its resource slot');
  buf.writeUInt16LE(1, group.file + 2);
  buf.writeUInt16LE(entries.length, group.file + 4);
  entries.forEach((m, i) => {
    const e = group.file + 6 + i * 14;
    buf[e] = m.w; buf[e + 1] = m.h; buf[e + 2] = m.cc; buf[e + 3] = 0;
    buf.writeUInt16LE(m.planes, e + 4);
    buf.writeUInt16LE(m.bitcount, e + 6);
    buf.writeUInt32LE(m.bytes, e + 8);
    buf.writeUInt16LE(m.nID, e + 12);
  });
  buf.writeUInt32LE(groupBytes, group.entry + 4);
  fs.writeFileSync(exePath, buf);
  return entries.length;
}

module.exports = { copyExeWithRetry, generateLoaderBundle, setWindowsGuiSubsystem, setExeIcon, writeBuildManifest };
