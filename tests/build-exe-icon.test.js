const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { setExeIcon } = require('../scripts/build-common');
const { inspectPe } = require('../scripts/verify-exe');

const ICO = path.join(__dirname, '..', 'installer', 'TechPartsPOS.ico');

function readIconResources(buf) {
  const pe = buf.readUInt32LE(0x3c);
  const nsec = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  let sec = null;
  for (let i = 0; i < nsec; i++) {
    const off = pe + 24 + optSize + i * 40;
    if (buf.toString('ascii', off, off + 8).replace(/\0/g, '') === '.rsrc') {
      sec = { va: buf.readUInt32LE(off + 12), raw: buf.readUInt32LE(off + 20) };
    }
  }
  const slots = new Map();
  const groups = [];
  (function walk(base, level, type, id) {
    const n = buf.readUInt16LE(base + 12) + buf.readUInt16LE(base + 14);
    for (let i = 0; i < n; i++) {
      const e = base + 16 + i * 8;
      const name = buf.readUInt32LE(e);
      const off = buf.readUInt32LE(e + 4);
      if (off & 0x80000000) walk(sec.raw + (off & 0x7fffffff), level + 1, level === 0 ? name : type, level === 1 ? name : id);
      else {
        const d = sec.raw + off;
        const leaf = { file: sec.raw + (buf.readUInt32LE(d) - sec.va), size: buf.readUInt32LE(d + 4) };
        if (type === 3) slots.set(id, leaf);
        if (type === 14) groups.push(leaf);
      }
    }
  })(sec.raw, 0, 0, 0);
  return { slots, groups };
}

function icoEntries() {
  const ico = fs.readFileSync(ICO);
  const out = [];
  for (let i = 0; i < ico.readUInt16LE(4); i++) {
    const e = 6 + i * 16;
    const bytes = ico.readUInt32LE(e + 8);
    const start = ico.readUInt32LE(e + 12);
    out.push({ w: ico[e], h: ico[e + 1], bytes, data: ico.slice(start, start + bytes) });
  }
  return out;
}

test('setExeIcon replaces the Node hexagon with the brand mark in place', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-exe-icon-'));
  try {
    const exe = path.join(dir, 'branded.exe');
    fs.copyFileSync(process.execPath, exe);
    const sizes = setExeIcon(exe, ICO);
    assert.ok(sizes >= 4, 'the brand ico covers the standard icon sizes');

    const buf = fs.readFileSync(exe);
    inspectPe(buf);
    const { slots, groups } = readIconResources(buf);
    assert.strictEqual(groups.length, 1);
    const g = groups[0];
    const count = buf.readUInt16LE(g.file + 4);
    assert.strictEqual(count, sizes);
    const entries = icoEntries();
    for (let i = 0; i < count; i++) {
      const e = g.file + 6 + i * 14;
      const w = buf[e], h = buf[e + 1];
      const bytes = buf.readUInt32LE(e + 8);
      const nID = buf.readUInt16LE(e + 12);
      const img = entries.find(m => m.w === w && m.h === h);
      assert.ok(img, `group entry ${w}x${h} must come from the brand ico`);
      assert.strictEqual(bytes, img.bytes, 'group bytesInRes must match the brand image');
      const slot = slots.get(nID);
      assert.strictEqual(slot.size, img.bytes, 'RT_ICON data entry size must match');
      assert.ok(buf.slice(slot.file, slot.file + img.bytes).equals(img.data), 'slot must hold the brand image bytes');
      assert.strictEqual(buf.readUInt32LE(slot.file), 0x474e5089, 'brand images are PNG-compressed');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('setExeIcon refuses an image that cannot fit its resource slot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pos-exe-icon-big-'));
  try {
    const exe = path.join(dir, 'branded.exe');
    fs.copyFileSync(process.execPath, exe);
    const fake = Buffer.alloc(6 + 16 + 8);
    fake.writeUInt16LE(1, 2);
    fake.writeUInt16LE(1, 4);
    fake[6] = 0; fake[7] = 0; // 256x256
    fake.writeUInt32LE(1e9, 6 + 8); // claims a gigabyte
    fake.writeUInt32LE(22, 6 + 12);
    const fakePath = path.join(dir, 'huge.ico');
    fs.writeFileSync(fakePath, fake);
    assert.throws(() => setExeIcon(exe, fakePath), /exceeds exe slot/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});