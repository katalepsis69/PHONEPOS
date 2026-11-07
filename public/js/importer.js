// Inventory import: header alias matching + a minimal .xlsx reader.
// ponytail: hand-rolled ZIP/OOXML reader (regex on machine-generated XML).
// Covers Excel/WPS/LibreOffice/Google-Sheets .xlsx exports. Legacy .xls
// (binary) is out — users get a "save as .xlsx or .csv" hint; dates land as
// serial numbers (no date columns in the inventory schema). Add SheetJS
// only if real .xls support is ever requested.

export const IMPORT_COLUMNS = ['brand', 'model_name', 'part_type', 'sku_barcode', 'cost_price',
  'price_retail', 'price_technician', 'stock_quantity', 'min_stock_alert', 'supplier', 'location'];

// Canonical names included so our own export round-trips the same path.
const HEADER_ALIASES = {
  brand: ['brand', 'manufacturer', 'make', 'brandname'],
  model_name: ['modelname', 'model', 'partname', 'name', 'productname', 'description'],
  part_type: ['parttype', 'type', 'category', 'part', 'partcategory'],
  sku_barcode: ['skubarcode', 'sku', 'barcode', 'code', 'upc', 'ean', 'productcode'],
  cost_price: ['costprice', 'cost', 'unitcost', 'purchaseprice', 'buyprice', 'capital', 'capitalprice', 'puhunan'],
  price_retail: ['priceretail', 'retail', 'retailprice', 'price', 'sellingprice', 'sellprice', 'srp'],
  price_technician: ['pricetechnician', 'technician', 'technicianprice', 'techprice', 'wholesale', 'wholesaleprice'],
  stock_quantity: ['stockquantity', 'stock', 'qty', 'quantity', 'stockqty', 'onhand', 'stockonhand', 'qtyonhand'],
  min_stock_alert: ['minstockalert', 'minstock', 'reorderpoint', 'minimumstock'],
  supplier: ['supplier', 'vendor', 'distributor'],
  location: ['location', 'bin', 'shelf', 'rack', 'storagelocation'],
};

export function normalizeHeader(h) {
  return String(h ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// headerRow (raw header strings) → { column: headerIndex | -1 }
// First alias match wins, so a duplicate "Price"/"SRP" pair maps once.
export function matchHeaders(headerRow) {
  const map = {};
  for (const col of Object.keys(HEADER_ALIASES)) map[col] = -1;
  headerRow.forEach((h, i) => {
    const n = normalizeHeader(h);
    if (!n) return;
    for (const [col, aliases] of Object.entries(HEADER_ALIASES)) {
      if (map[col] === -1 && aliases.includes(n)) { map[col] = i; break; }
    }
  });
  return map;
}

// ponytail: accept explicit PH/US and decimal-comma formats; never strip arbitrary text.
export function parseMoney(v) {
  const raw = String(v ?? '').trim();
  if (!raw) return '';
  let s = raw.replace(/^(?:₱|PHP|USD|EUR|\$|€)\s*/i, '').trim();
  if (/^\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?$/.test(s)) s = s.replace(/,/g, '');
  else if (/^\d{1,3}(?:\.\d{3})*,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,2})?$/.test(s) || !Number.isFinite(Number(s))) {
    throw new Error(`Invalid price: ${raw}. Use a non-negative amount with at most two decimal places.`);
  }
  return Number(s);
}

export function parseSku(v) {
  const s = String(v ?? '').trim();
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(s)) {
    throw new Error('Scientific-notation barcode: supply the original full code as Text in Excel. Lost digits cannot be recovered.');
  }
  return s;
}

const unescapeXml = s => String(s)
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'").replace(/&amp;/g, '&');

const colIndex = ref => [...ref].reduce((a, ch) => a * 26 + (ch.charCodeAt(0) - 64), 0) - 1;

async function inflateRaw(comp) {
  const piped = new Response(comp).body.pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

async function readZipEntries(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a readable .xlsx file — save it as .xlsx or .csv');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(off, true) !== 0x02014b50) break;
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commentLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = new TextDecoder().decode(bytes.subarray(off + 46, off + 46 + nameLen));
    const lNameLen = dv.getUint16(lho + 26, true);
    const lExtraLen = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lNameLen + lExtraLen;
    const comp = bytes.subarray(start, start + csize);
    entries.push({ name, data: method === 0 ? comp : await inflateRaw(comp) });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// .xlsx buffer → rows of string cells (numbers keep their literal text, so
// a numeric barcode like 6941234567890 arrives un-mangled).
export async function parseXlsx(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const xml = {};
  for (const { name, data } of await readZipEntries(bytes)) xml[name] = new TextDecoder().decode(data);

  // First sheet, resolved through workbook rels — internal sheet file
  // numbering does not follow tab order in every producer.
  const wb = xml['xl/workbook.xml'] || '';
  const rels = xml['xl/_rels/workbook.xml.rels'] || '';
  const rid = /r:id="([^"]+)"/.exec(/<sheet\b[^>]*>/i.exec(wb)?.[0] || '')?.[1];
  const relationship = [...rels.matchAll(/<Relationship\b[^>]*>/g)]
    .find(m => /\bId="([^"]+)"/.exec(m[0])?.[1] === rid)?.[0];
  const target = relationship && /\bTarget="([^"]+)"/.exec(relationship)?.[1];
  const sheetXml = target ? xml[`xl/${target.replace(/^\/?(xl\/)?/, '')}`] : xml['xl/worksheets/sheet1.xml'];
  if (!sheetXml) throw new Error('No worksheet found inside the .xlsx file');

  const shared = [];
  for (const m of (xml['xl/sharedStrings.xml'] || '').matchAll(/<si\b[^>]*?(?:\/>|>([\s\S]*?)<\/si>)/g)) {
    shared.push(m[1] ? [...m[1].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(t => unescapeXml(t[1])).join('') : '');
  }

  const rows = [];
  for (const m of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const c of m[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1];
      const ref = /\br="([A-Z]+)\d+"/.exec(attrs)?.[1];
      const col = ref ? colIndex(ref) : row.length;
      const t = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const inner = c[2] || '';
      let v;
      if (t === 'inlineStr') {
        v = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map(x => unescapeXml(x[1])).join('');
      } else if (t === 's') {
        v = shared[Number(/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? -1)] ?? '';
      } else {
        v = unescapeXml(/<v[^>]*>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
      }
      row[col] = v;
    }
    rows.push(row);
  }
  // Drop blank rows so rows[0] is the header wherever the sheet starts.
  return rows.filter(r => r.some(v => v != null && v !== ''));
}
