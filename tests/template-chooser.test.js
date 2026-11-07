const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('downloadImportTemplate generates clean empty CSV template with Capital header and zero dummy rows', async () => {
  const { IMPORT_COLUMNS, matchHeaders } = await import('../public/js/importer.js');
  const source = fs.readFileSync(path.join(__dirname, '../public/js/views/inventory.js'), 'utf8');
  const required = source.match(/const IMPORT_REQUIRED = .*;/)[0];
  const code = source.slice(source.indexOf('const IMPORT_TEMPLATE_HEADERS'), source.indexOf('// ---- Edit part'))
    .replace('export function', 'function');
  let blob, downloads = 0;
  const document = {
    body: {
      appendChild() {}
    },
    createElement: () => ({ click() { downloads++; }, remove() {} })
  };
  const context = vm.createContext({
    IMPORT_COLUMNS, document, Blob,
    URL: { createObjectURL(b) { blob = b; return 'blob:test'; }, revokeObjectURL() {} },
    setTimeout() {}
  });
  vm.runInContext(`${required}\n${code}`, context);
  context.downloadImportTemplate();
  assert.equal(downloads, 1);
  const text = await blob.text();
  const rows = text.trim().split(/\r?\n/);
  assert.equal(rows.length, 1, 'must be empty of dummy sample rows, header only');
  const headers = rows[0].split(',');
  assert.deepEqual(headers, [
    'Brand', 'Model Name', 'Part Type', 'SKU / Barcode', 'Capital',
    'Retail Price', 'Wholesale Price', 'Stock Qty', 'Min Stock Alert', 'Supplier', 'Location'
  ]);
  const mapped = matchHeaders(headers);
  for (const col of IMPORT_COLUMNS) {
    assert.ok(mapped[col] !== -1, `header for ${col} must map cleanly`);
  }
  assert.equal(mapped.cost_price, 4, 'Capital column maps to cost_price');
  assert.equal(mapped.price_technician, 6, 'Wholesale Price column maps to price_technician');
});
