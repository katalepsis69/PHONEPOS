const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = buf => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};

// Minimal zip writer: one stored + one deflated entry proves both paths.
function buildZip(entries) {
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data, method = 0 } of entries) {
    const nameBytes = Buffer.from(name);
    const comp = method === 8 ? zlib.deflateRawSync(data) : data;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(Buffer.concat([local, nameBytes, comp]));
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(Buffer.concat([central, nameBytes]));
    offset += locals[locals.length - 1].length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

test('worksheet relationship lookup accepts Target before Id', async () => {
  const { parseXlsx } = await import('../public/js/importer.js');
  const entries = [
    { name: 'xl/workbook.xml', data: Buffer.from('<workbook><sheets><sheet name="Parts" r:id="parts.2"/></sheets></workbook>') },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from('<Relationships><Relationship Target="worksheets/parts.xml" Type="worksheet" Id="parts.2"/></Relationships>') },
    { name: 'xl/worksheets/parts.xml', data: Buffer.from('<worksheet><row r="1"><c r="A1"><v>42</v></c></row></worksheet>') },
  ];
  assert.deepEqual(await parseXlsx(buildZip(entries)), [['42']]);
});

// Sheet file name is deliberately non-default to prove rels resolution.
function buildXlsx(sheetXml, opts = {}) {
  const entries = [
    { name: 'xl/workbook.xml', data: Buffer.from(`<?xml version="1.0"?><workbook xmlns="x" xmlns:r="y"><sheets><sheet name="Parts" r:id="rId2"/></sheets></workbook>`) },
    { name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(`<?xml version="1.0"?><Relationships xmlns="p"><Relationship Id="rId1" Target="styles.xml"/><Relationship Id="rId2" Target="worksheets/MySheet.xml"/></Relationships>`) },
    { name: 'xl/worksheets/MySheet.xml', data: Buffer.from(sheetXml), method: 8 },
  ];
  if (!opts.noShared) {
    entries.push({ name: 'xl/sharedStrings.xml', data: Buffer.from(opts.shared ||
      `<?xml version="1.0"?><sst count="2" uniqueCount="2"><si><t>Part Name</t></si><si><t>LCD iPhone 15 &amp; tools</t></si></sst>`) });
  }
  return buildZip(entries);
}

test('parseXlsx reads deflate + stored entries, shared/inline strings, entities, numbers', async () => {
  const importer = await import('../public/js/importer.js');
  const sheet = `<?xml version="1.0"?><worksheet xmlns="x">` +
    `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1"><v>6941234567890</v></c><c r="D1" t="inlineStr"><is><t>In stock</t></is></c></row>` +
    `<row r="3"><c r="A2" t="s"><v>1</v></c><c r="B2"><v>1250</v></c></row>` +
    `</worksheet>`;
  const rows = await importer.parseXlsx(buildXlsx(sheet));
  assert.deepEqual(rows, [
    ['Part Name', 'LCD iPhone 15 & tools', '6941234567890', 'In stock'],
    ['LCD iPhone 15 & tools', '1250'],
  ]);
});

test('parseXlsx rejects non-zip files with a helpful hint', async () => {
  const importer = await import('../public/js/importer.js');
  await assert.rejects(() => importer.parseXlsx(Buffer.from('brand,model,qty\r\n')), /save it as \.xlsx or \.csv/);
});

test('matchHeaders maps supplier-style headers to canonical columns', async () => {
  const importer = await import('../public/js/importer.js');
  const map = importer.matchHeaders(['Part Name', 'Brand', 'Qty', 'Cost', 'SRP', 'SKU', 'Notes']);
  assert.equal(map.model_name, 0);
  assert.equal(map.brand, 1);
  assert.equal(map.stock_quantity, 2);
  assert.equal(map.cost_price, 3);
  assert.equal(map.price_retail, 4);
  assert.equal(map.sku_barcode, 5);
  assert.equal(map.supplier, -1);
  // Our own export format round-trips too.
  const own = importer.matchHeaders(['brand', 'model_name', 'part_type', 'sku_barcode', 'cost_price',
    'price_retail', 'price_technician', 'stock_quantity', 'min_stock_alert', 'supplier', 'location']);
  for (const col of Object.keys(own)) assert.ok(own[col] !== -1, `${col} should map`);
  // ...and so does the human-readable download template.
  const tpl = importer.matchHeaders(['Brand', 'Model Name', 'Part Type', 'SKU / Barcode', 'Cost Price',
    'Retail Price', 'Technician Price', 'Stock Qty', 'Min Stock Alert', 'Supplier', 'Location']);
  for (const col of Object.keys(tpl)) assert.ok(tpl[col] !== -1, `template header for ${col} should map`);
  assert.equal(importer.matchHeaders(['Wholesale']).price_technician, 0); // the UI's "Wholesale" column
});

test('money normalization rejects invalid text and barcodes never invent lost digits', async () => {
  const importer = await import('../public/js/importer.js');
  assert.equal(importer.parseMoney('₱1,250.00'), 1250);
  assert.equal(importer.parseMoney(' 1,075.25 '), 1075.25);
  assert.equal(importer.parseMoney('1.250,50'), 1250.5);
  assert.equal(importer.parseMoney('1250,50'), 1250.5);
  assert.equal(importer.parseMoney('1,250'), 1250);
  assert.equal(importer.parseMoney(''), '');
  for (const value of ['abc', '12abc34', '(50)', '-50', '1e3', '1,2,3']) {
    assert.throws(() => importer.parseMoney(value), /Invalid price/);
  }
  assert.throws(() => importer.parseSku('6.94123E+12'), /Lost digits/);
  assert.equal(importer.parseSku(' 0123 '), '0123');
  assert.equal(importer.parseSku('MP-1'), 'MP-1');
});

test('sparse worksheet coordinates retain blank columns and AA cells', async () => {
  const { parseXlsx } = await import('../public/js/importer.js');
  const rows = await parseXlsx(buildXlsx('<worksheet><row r="1"><c r="A1"><v>1</v></c><c r="C1"><v>3</v></c><c r="AA1"><v>27</v></c></row></worksheet>'));
  assert.equal(rows[0].length, 27);
  assert.equal(rows[0][0], '1');
  assert.equal(rows[0][1], undefined);
  assert.equal(rows[0][2], '3');
  assert.equal(rows[0][26], '27');
});


test('matchHeaders supports Capital and Wholesale Price aliases', async () => {
  const importer = await import('../public/js/importer.js');
  const headers = ['Brand', 'Model Name', 'Part Type', 'SKU / Barcode', 'Capital', 'Retail Price', 'Wholesale Price', 'Stock Qty', 'Min Stock Alert', 'Supplier', 'Location'];
  const map = importer.matchHeaders(headers);
  assert.equal(map.cost_price, 4);
  assert.equal(map.price_retail, 5);
  assert.equal(map.price_technician, 6);
  assert.equal(importer.matchHeaders(['Puhunan']).cost_price, 0);
  assert.equal(importer.matchHeaders(['Alert Stock']).min_stock_alert, 0);
  assert.equal(importer.matchHeaders(['Stock Alert']).min_stock_alert, 0);
});
