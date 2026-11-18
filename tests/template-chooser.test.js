const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('downloadImportTemplate generates clean empty CSV template with Capital header and zero dummy rows', async () => {
  const { IMPORT_COLUMNS, matchHeaders } = await import('../public/js/importer.js');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/views/inventory.js'), 'utf8');
  const required = source.match(/const IMPORT_REQUIRED = .*;/)[0];
  const code = source.slice(source.indexOf('const PROFILE_TEMPLATE_SLUGS'), source.indexOf('// ---- Edit part'))
    .replace('export function', 'function');
  let blob, downloads = 0, lastFilename = '';
  const document = {
    body: {
      appendChild() {}
    },
    createElement: () => {
      const el = { download: '', click() { downloads++; lastFilename = el.download; }, remove() {} };
      return el;
    }
  };
  const context = vm.createContext({
    IMPORT_COLUMNS, document, Blob,
    URL: { createObjectURL(b) { blob = b; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout() {}
  });
  vm.runInContext(`${required}\n${code}`, context);
  context.downloadImportTemplate();
  assert.equal(downloads, 1);
  assert.equal(lastFilename, 'phone-repair-import-template.csv');
  const text = await blob.text();
  const rows = text.trim().split(/\r?\n/);
  assert.equal(rows.length, 1, 'must be empty of dummy sample rows, header only');
  const headers = rows[0].split(',');
  assert.deepEqual(headers, [
    'Brand', 'Device / Model', 'Part Type', 'Barcode', 'Capital',
    'Retail Price', 'Wholesale Price', 'Stock Count', 'Low Stock Alert', 'Supplier', 'Shelf / Bin'
  ]);
  const mapped = matchHeaders(headers);
  for (const col of IMPORT_COLUMNS) {
    assert.ok(mapped[col] !== -1, `header for ${col} must map cleanly`);
  }
  assert.equal(mapped.cost_price, 4, 'Capital column maps to cost_price');
  assert.equal(mapped.price_technician, 6, 'Wholesale Price column maps to price_technician');

  // Per-profile templates emit plain-English columns and matching filenames.
  for (const [mode, expectedFilename, expectedCols] of [
    ['grocery', 'grocery-import-template.csv', ['item_name', 'brand', 'part_type', 'uom', 'allow_fractional', 'sku_barcode', 'stock_quantity']],
    ['pc', 'pc-electronics-import-template.csv', ['brand', 'model_name', 'part_type', 'track_serial', 'stock_quantity']],
    ['retail', 'retail-import-template.csv', ['item_name', 'brand', 'part_type', 'uom', 'allow_fractional', 'stock_quantity']],
    ['service', 'service-labor-import-template.csv', ['item_name', 'brand', 'part_type', 'sku_barcode', 'stock_quantity']],
    ['hybrid', 'hybrid-import-template.csv', ['profile', 'item_name', 'brand', 'model_name', 'part_type', 'uom', 'allow_fractional', 'track_serial', 'stock_quantity']]
  ]) {
    context.downloadImportTemplate(mode);
    assert.equal(lastFilename, expectedFilename);
    const profHeaders = (await blob.text()).trim().split(/\r?\n/)[0].split(',');
    const profMap = matchHeaders(profHeaders);
    for (const col of expectedCols) {
      assert.ok(Number.isInteger(profMap[col]) && profMap[col] >= 0, `${mode} template header must map ${col}`);
    }
  }
});
