// phone-repair-pos/src/inventory.js
const { txn, audit } = require('./audit');
const { enqueueRow, enqueueDelete } = require('./sync');
const { money } = require('./money');
const { getDefaultRetailMarkup, getDefaultWholesaleMarkup } = require('./settings');

function decorateItem(row) {
  if (!row) return row;
  row.price_wholesale = row.price_technician;
  row.display_name = row.item_name || partLabel(row);
  return row;
}

function listInventory(db, { search = '', brand = '', part_type = '', lowStockOnly = false, include_archived = false, profile = '', limit, offset } = {}) {
  const everStockedSql = '(EXISTS (SELECT 1 FROM stock_movements sm WHERE sm.inventory_id = inventory.id) OR EXISTS (SELECT 1 FROM sale_items si WHERE si.inventory_id = inventory.id))';
  let query = `SELECT inventory.*, ${everStockedSql} AS ever_stocked FROM inventory WHERE 1=1`;
  const params = [];

  if (!include_archived) {
    query += ' AND archived = 0';
  }

  if (search) {
    // ponytail: escape LIKE wildcards in user input
    const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
    const term = `%${esc(search)}%`;
    query += ' AND (model_name LIKE ? ESCAPE \'\\\' OR brand LIKE ? ESCAPE \'\\\' OR part_type LIKE ? ESCAPE \'\\\' OR sku_barcode LIKE ? ESCAPE \'\\\' OR item_name LIKE ? ESCAPE \'\\\' OR category LIKE ? ESCAPE \'\\\')';
    params.push(term, term, term, term, term, term);
  }

  if (brand) {
    query += ' AND brand = ?';
    params.push(brand);
  }

  if (part_type) {
    query += ' AND (part_type = ? OR category = ?)';
    params.push(part_type, part_type);
  }

  if (lowStockOnly) {
    query += ' AND (stock_quantity <= 0 OR stock_quantity <= min_stock_alert)';
  }

  query += ' ORDER BY brand ASC, model_name ASC, part_type ASC';
  const lane = profile === 'active' ? activeBusinessType(db) : str(profile);
  const filterByLane = Boolean(lane && lane !== 'hybrid' && lane !== 'all');
  // ponytail: optional pagination — unbounded listInventory is fine at <500 SKUs
  // (current catalog), but a 20k-row JSON blocks the sync event loop. Frontend
  // opts in with limit/offset; existing calls stay uncapped for backward compat.
  if (!filterByLane && (limit != null || offset != null)) {
    const cap = Math.min(2000, Math.max(1, Number(limit) || 2000));
    const off = Math.max(0, Number(offset) || 0);
    query += ' LIMIT ? OFFSET ?';
    params.push(cap, off);
  }
  let rows = db.prepare(query).all(...params).map(decorateItem);
  if (filterByLane) {
    rows = rows.filter(r => itemVisibleInProfile(r, lane));
    if (limit != null || offset != null) {
      const cap = Math.min(2000, Math.max(1, Number(limit) || 2000));
      const off = Math.max(0, Number(offset) || 0);
      rows = rows.slice(off, off + cap);
    }
  }
  return rows;
}

function getInventoryItem(db, id) {
  const row = db.prepare('SELECT * FROM inventory WHERE id = ?').get(id);
  return row ? decorateItem(row) : null;
}

function getInventoryByBarcode(db, barcode, { profile = '' } = {}) {
  if (!barcode || typeof barcode !== 'string') return null;
  const clean = barcode.trim();
  if (!clean) return null;
  const row = db.prepare('SELECT * FROM inventory WHERE sku_barcode = ? COLLATE NOCASE').get(clean);
  if (!row) return null;
  const item = decorateItem(row);
  const lane = profile === 'active' ? activeBusinessType(db) : str(profile);
  if (lane && lane !== 'hybrid' && lane !== 'all' && !itemVisibleInProfile(item, lane)) return null;
  return item;
}

// Store-profile lanes. 'shared' explicitly spans every profile; '' stays untagged
// legacy until assigned (falling back to itemMatchesProfile).
const PROFILE_LANES = new Set(['phone', 'pc', 'grocery', 'retail', 'service', 'shared']);

function activeBusinessType(db) {
  return db.prepare("SELECT value FROM shop_settings WHERE key = 'business_type'").get()?.value || 'hybrid';
}

function itemMatchesProfile(item, profile) {
  if (!profile || profile === 'hybrid') return true;

  const b = String(item?.brand || '').trim().toLowerCase();
  const m = String(item?.model_name || '').trim().toLowerCase();
  const pt = String(item?.part_type || '').trim().toLowerCase();
  const cat = String(item?.category || '').trim().toLowerCase();
  const name = String(item?.item_name || '').trim().toLowerCase();
  const combined = `${b} ${m} ${pt} ${cat} ${name}`;

  const isPcPart = (
    /\b(gpu|cpu|motherboard|mobo|ram|ddr4|ddr5|ddr3|nvme|ssd|hdd|power supply|psu|pc case|cooler|thermal paste|graphics card|processor|geforce|radeon|ryzen|intel core)\b/i.test(combined) ||
    /^(asus|gigabyte|msi|kingston|corsair|amd|intel|deepcool|fantech|western digital|seagate|nvidia|asrock|zotac|palit)$/i.test(b)
  );

  const isPhoneBrand = /^(apple|iphone|samsung|xiaomi|redmi|iredmi|poco|infinix|inifnix|tecno|realme|oppo|vivo|huawei|huawe|honor|itel|pixel|nokia|motorola)$/i.test(b);

  const isPhonePart = (
    /\b(lcd|oled|amoled|incell|screen|touchscreen|flex cable|charging flex|charging board|charging port|camera glass|back cam|front cam|air piece|earpiece|ear piece|center case|midframe|middle frame|power swich|power switch|back cover|back glass|housing|soldering tip)\b/i.test(combined) ||
    ((/\bbatt(?:ery)?\b/i.test(combined)) && (isPhoneBrand || /\b(iphone|iph|galaxy|redmi|iredmi|note|poco|infinix|inifnix|tecno|realme|oppo|vivo|huawei|huawe|samsung|apple|pixel|honor)\b/i.test(combined))) ||
    (!isPcPart && (isPhoneBrand || /^(gx|jk|ca|orig|wf|swich|power swich|charging flex|charging board|air piece|center case)$/i.test(pt)) && !name && !item?.allow_fractional)
  );

  if (profile === 'phone') return isPhonePart;
  if (profile === 'pc') return isPhonePart ? false : isPcPart;
  if (profile === 'grocery') {
    if (isPhonePart) return false;
    if (isPcPart && !/\b(peripherals|mouse|keyboard|cable|usb)\b/i.test(combined)) return false;
    return true;
  }
  if (profile === 'retail') return !isPhonePart;
  if (profile === 'service') return !(isPhonePart || isPcPart);
  return true;
}

function itemVisibleInProfile(item, profile) {
  if (!profile || profile === 'hybrid') return true;
  if (item?.profile === 'shared') return true;
  if (item?.profile) return item.profile === profile;
  return itemMatchesProfile(item, profile);
}

// Trust boundary for text fields: control characters never enter a stored
// value. Formula-prefix defanging happens in the CSV export writer so
// hand-typed values stay displayable in the app.
const str = v => (v ?? '').toString().replace(/[\u0000-\u001F\u007F]/g, '').trim();
// The catalog columns have no reason to hold an absurd string; movement notes
// and refs stay unbounded because a manager's explanation is not a defect.
const cap = s => s.slice(0, 200);
const roundQty = q => Math.round((Number(q) || 0) * 1000) / 1000;
const parseBoolFlag = v => (v === true || /^(1|true|yes)$/i.test(String(v ?? '').trim())) ? 1 : 0;

// Client op_id dedup for the stock-moving writes that have no per-table op_id
// column (adjustments, imports, part creation). Both helpers must run inside
// the same transaction as the write they gate, so a crash cannot strand a
// recorded op with no effect. Rows prune after 2 days.
const opIdOf = v => {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (s.length > 64) throw new Error('op_id too long');
  return s;
};
function opReplayed(db, opId) {
  if (!opId) return null;
  return db.prepare('SELECT entity_id FROM op_log WHERE op_id = ?').get(opId) || null;
}
function opRecord(db, opId, entityId = null) {
  db.prepare('INSERT INTO op_log (op_id, entity_id, created_at) VALUES (?, ?, ?)').run(opId, entityId, new Date().toISOString());
  try { db.prepare("DELETE FROM op_log WHERE created_at < datetime('now', '-2 days')").run(); } catch (_) {}
}

function validateInventory(data) {
  const rawItemName = cap(str(data.item_name || data.name));
  const brand = cap(str(data.brand)) || (rawItemName ? 'General' : '');
  if (!brand) throw new Error('Brand is required');

  const model_name = cap(str(data.model_name)) || (rawItemName ? rawItemName : '');
  if (!model_name) throw new Error('Model name is required');

  const part_type = cap(str(data.part_type || data.category)) || (rawItemName ? 'General' : '');
  if (!part_type) throw new Error('Part type is required');

  const cost_price = money(data.cost_price ?? 0);
  if (cost_price < 0) throw new Error('Cost price cannot be negative');

  const price_retail = money(data.price_retail ?? 0);
  if (price_retail < 0) throw new Error('Retail price cannot be negative');

  const price_technician = money(data.price_wholesale ?? data.price_technician ?? 0);
  if (price_technician < 0) throw new Error('Wholesale price cannot be negative');

  // parseBoolFlag, not Number truthiness: the CSV path accepts "true"/"yes"
  // and the API path must not quietly disagree with it.
  const allow_fractional = parseBoolFlag(data.allow_fractional);
  const stock_quantity = Number(data.stock_quantity ?? 0);
  if (allow_fractional) {
    if (!Number.isFinite(stock_quantity) || stock_quantity < 0) {
      throw new Error('Stock quantity must be a non-negative number');
    }
  } else {
    if (!Number.isInteger(stock_quantity) || stock_quantity < 0) {
      throw new Error('Stock quantity must be a non-negative integer');
    }
  }
  const clean_stock_quantity = allow_fractional ? Math.round(stock_quantity * 1000) / 1000 : stock_quantity;

  const rawMinAlert = data.min_stock_alert;
  const min_stock_alert = rawMinAlert == null || String(rawMinAlert).trim() === '' ? 3 : Number(rawMinAlert);
  if (!Number.isFinite(min_stock_alert) || min_stock_alert < 0) {
    throw new Error('Minimum stock alert must be a non-negative number');
  }

  const item_name = rawItemName || null;
  const category = cap(str(data.category || data.part_type || ''));
  const uom = cap(str(data.uom || 'pcs')) || 'pcs';
  const track_serial = Number(data.track_serial) ? 1 : 0;
  const profile = str(data.profile);
  if (profile && !PROFILE_LANES.has(profile)) throw new Error(`Unknown store profile "${profile}"`);

  return {
    brand,
    model_name,
    part_type,
    item_name,
    category,
    uom,
    allow_fractional,
    track_serial,
    profile,
    sku_barcode: cap(str(data.sku_barcode)).toUpperCase() || null,
    cost_price,
    price_retail,
    price_technician,
    stock_quantity: clean_stock_quantity,
    min_stock_alert,
    supplier: cap(str(data.supplier)),
    location: cap(str(data.location))
  };
}

// The stock ledger: every quantity change writes one row, so
// SUM(stock_movements.delta) == inventory.stock_quantity at all times.
// created_at is ISO-with-Z (SQLite's bare CURRENT_TIMESTAMP is zone-less UTC
// and V8 reads that shape as local time — 8h skew on UTC+8 machines).
function recordStockMovement(db, { inventory_id, delta, reason, note = '', ref = '' }) {
  const res = db.prepare('INSERT INTO stock_movements (inventory_id, delta, reason, note, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(inventory_id, Number(delta), str(reason) || 'correction', str(note), str(ref), new Date().toISOString());
  enqueueRow(db, 'stock_movements', Number(res.lastInsertRowid));
}

// Universal label: uses specific product name if defined, else brand + model - part type
const partLabel = item => item.item_name || `${item.brand} ${item.model_name} - ${item.part_type}`;

function createInventoryItem(db, data, meta = {}, ctx = {}) {
  const v = validateInventory(data);
  // Lane ownership: a non-hybrid register stamps its active profile on every
  // new item (unless marked 'shared' or explicitly preserved by seeding);
  // hybrid honors whatever profile the form sent.
  const mode = activeBusinessType(db);
  const profile = (ctx.preserveProfile && v.profile)
    ? v.profile
    : (v.profile === 'shared' ? 'shared' : (mode !== 'hybrid' ? mode : v.profile));
  return txn(db, () => {
    const opId = opIdOf(meta.op_id);
    const replay = opReplayed(db, opId);
    if (replay) return getInventoryItem(db, replay.entity_id);
    const item = db.prepare(`
      INSERT INTO inventory (brand, model_name, part_type, sku_barcode, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert, supplier, location, item_name, category, uom, allow_fractional, track_serial, profile)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(v.brand, v.model_name, v.part_type, v.sku_barcode, v.cost_price, v.price_retail, v.price_technician, v.stock_quantity, v.min_stock_alert, v.supplier, v.location, v.item_name, v.category, v.uom, v.allow_fractional, v.track_serial, profile);
    if (opId) opRecord(db, opId, item.id);
    enqueueRow(db, 'inventory', item.id);
    if (v.stock_quantity !== 0) {
      recordStockMovement(db, { inventory_id: item.id, delta: v.stock_quantity, reason: meta.reason || 'opening_balance', note: meta.note });
    }
    audit(db, ctx.actor, ctx.elevated, 'inventory', 'create', {
      id: item.id, part: partLabel(v), cost_price: v.cost_price, price_retail: v.price_retail,
      price_technician: v.price_technician, stock: v.stock_quantity
    });
    return decorateItem(item);
  });
}

function updateInventoryItem(db, id, data, meta = {}, ctx = {}) {
  const existing = getInventoryItem(db, id);
  if (!existing) return null;

  // Optimistic-concurrency guard for the edit modal's absolute "set stock to":
  // the modal sends the count it loaded; if a sale on another seat moved the
  // shelf in between, refuse instead of silently resurrecting the units.
  if (meta.expected_stock !== undefined && meta.expected_stock !== null
    && Number(meta.expected_stock) !== existing.stock_quantity) {
    const err = new Error(`Stock changed since the form loaded (form said ${Number(meta.expected_stock)}, shelf now ${existing.stock_quantity}). Reopen the part and save again.`);
    err.statusCode = 409;
    throw err;
  }
  // Double-submit dedup on the same key as adjustments and imports.
  const opId = opIdOf(meta.op_id);
  if (opId) {
    const replay = opReplayed(db, opId);
    if (replay) return getInventoryItem(db, id);
  }

  const v = validateInventory({
    ...existing,
    price_wholesale: data.price_wholesale !== undefined ? data.price_wholesale : (data.price_technician !== undefined ? data.price_technician : existing.price_wholesale),
    ...data
  });
  return txn(db, () => {
    const item = db.prepare(`
      UPDATE inventory SET
        brand = ?, model_name = ?, part_type = ?, sku_barcode = ?, cost_price = ?,
        price_retail = ?, price_technician = ?, stock_quantity = ?, min_stock_alert = ?,
        supplier = ?, location = ?, item_name = ?, category = ?, uom = ?,
        allow_fractional = ?, track_serial = ?, profile = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING *
    `).get(v.brand, v.model_name, v.part_type, v.sku_barcode, v.cost_price, v.price_retail, v.price_technician, v.stock_quantity, v.min_stock_alert, v.supplier, v.location, v.item_name, v.category, v.uom, v.allow_fractional, v.track_serial, v.profile, id);
    enqueueRow(db, 'inventory', id);

    // "Set stock to" in the edit modal lands here; log the diff so the ledger
    // invariant and the history modal stay honest.
    const delta = v.allow_fractional
      ? roundQty(v.stock_quantity - existing.stock_quantity)
      : (v.stock_quantity - existing.stock_quantity);
    if (delta !== 0) {
      recordStockMovement(db, { inventory_id: id, delta, reason: meta.reason || 'correction', note: meta.note });
    }
    audit(db, ctx.actor, ctx.elevated, 'inventory', 'update', {
      id, part: partLabel(v),
      before: { cost_price: existing.cost_price, price_retail: existing.price_retail, price_technician: existing.price_technician, stock_quantity: existing.stock_quantity },
      after: { cost_price: v.cost_price, price_retail: v.price_retail, price_technician: v.price_technician, stock_quantity: v.stock_quantity }
    });
    if (opId) opRecord(db, opId, id);
    return item;
  });
}

function adjustStock(db, id, deltaQty, meta = {}, ctx = {}) {
  const rawDelta = Number(deltaQty);
  if (isNaN(rawDelta) || !Number.isFinite(rawDelta)) {
    throw new Error('Stock adjustment delta must be a finite number');
  }
  const before = getInventoryItem(db, id);
  if (!before) return null;
  const allowFrac = Boolean(before.allow_fractional);
  if (!allowFrac && !Number.isInteger(rawDelta)) {
    throw new Error('Stock adjustment delta must be an integer');
  }
  const delta = allowFrac ? roundQty(rawDelta) : rawDelta;
  if (allowFrac && rawDelta !== 0 && delta === 0) {
    throw new Error('Stock adjustment delta is too small');
  }
  return txn(db, () => {
    const opId = opIdOf(meta.op_id);
    const replay = opReplayed(db, opId);
    if (replay) return getInventoryItem(db, replay.entity_id);
    // ponytail: WHERE stock_quantity+? >=0 makes check+update atomic — fixes TOCTOU oversell
    const updated = db.prepare(`
      UPDATE inventory
      SET stock_quantity = CASE WHEN COALESCE(allow_fractional, 0) = 1 THEN ROUND(stock_quantity + ?, 3) ELSE stock_quantity + ? END,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND ROUND(stock_quantity + ?, 6) >= 0
      RETURNING *
    `).get(delta, delta, id, delta) || null;
    if (!updated) {
      const cur = getInventoryItem(db, id);
      if (!cur) return null;
      throw new Error(`Insufficient stock: cannot reduce stock below 0 (current: ${cur.stock_quantity}, delta: ${delta})`);
    }
    if (opId) opRecord(db, opId, id);
    enqueueRow(db, 'inventory', id);
    recordStockMovement(db, { inventory_id: id, delta, reason: meta.reason, note: meta.note, ref: meta.ref });
    audit(db, ctx.actor, ctx.elevated, 'inventory', 'adjust_stock', {
      id, part: partLabel(updated), delta, reason: meta.reason || '', before: before.stock_quantity, after: updated.stock_quantity
    });
    return updated;
  });
}

function listStockMovements(db, id, limit = 100) {
  return db.prepare('SELECT * FROM stock_movements WHERE inventory_id = ? ORDER BY id DESC LIMIT ?').all(id, limit);
}

function archiveInventoryItem(db, id, archived, ctx = {}) {
  return txn(db, () => {
    const item = db.prepare('UPDATE inventory SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *')
      .get(archived ? 1 : 0, id) || null;
    if (item) {
      enqueueRow(db, 'inventory', id);
      audit(db, ctx.actor, ctx.elevated, 'inventory', archived ? 'archive' : 'unarchive', { id, part: partLabel(item) });
    }
    return item;
  });
}

function normalizeRow(r) {
  if (!r || typeof r !== 'object') return {};
  const res = { ...r };
  const pick = (...keys) => keys.find(k => r[k] != null);
  const assign = (field, ...keys) => {
    if (res[field] != null) return;
    const hit = pick(...keys);
    if (hit !== undefined) res[field] = r[hit];
  };
  assign('cost_price', 'Capital', 'Cost Price', 'Cost');
  assign('price_retail', 'Retail Price', 'Retail');
  assign('price_technician', 'Wholesale Price', 'Wholesale', 'Technician Price', 'technician_price');
  assign('sku_barcode', 'Barcode', 'SKU / Barcode', 'SKU', 'Service Code');
  assign('brand', 'Brand', 'Provider / Brand');
  assign('model_name', 'Device / Model', 'Model Name');
  assign('part_type', 'Part Type', 'Component Type', 'Category / Type');
  assign('stock_quantity', 'Stock Count', 'Stock Qty', 'Stock Quantity', 'Stock to Add');
  assign('min_stock_alert', 'Low Stock Alert', 'Min Stock Alert', 'Alert Stock', 'Stock Alert');
  assign('supplier', 'Supplier');
  assign('location', 'Shelf / Bin', 'Bench / Area', 'Location');
  assign('item_name', 'Item Name', 'Service Name', 'Product Name', 'Name');
  assign('category', 'Category');
  assign('uom', 'Unit', 'UOM');
  assign('allow_fractional', 'Sell by Weight or Decimal', 'Allow Fractional');
  assign('track_serial', 'Requires Serial No.', 'Track Serial');
  assign('profile', 'Shop Type', 'Shop Profile', 'Profile');
  return res;
}

const PROFILE_EXPORT_SLUGS = {
  phone: 'phone-repair',
  pc: 'pc-electronics',
  grocery: 'grocery',
  retail: 'retail',
  service: 'service-labor',
  hybrid: 'hybrid'
};

function profileFileSlug(mode) {
  return PROFILE_EXPORT_SLUGS[mode] || 'phone-repair';
}

function buildInventoryExport(db) {
  const mode = activeBusinessType(db);
  const items = listInventory(db, { profile: 'active' });
  const slug = profileFileSlug(mode);
  const yesNo = v => (Number(v) ? 'Yes' : 'No');
  let headers, rows;
  if (mode === 'pc') {
    headers = ['Brand', 'Device / Model', 'Component Type', 'Barcode', 'Capital', 'Retail Price', 'Wholesale Price', 'Stock Count', 'Low Stock Alert', 'Requires Serial No.', 'Supplier', 'Shelf / Bin'];
    rows = items.map(i => [i.brand, i.model_name, i.part_type, i.sku_barcode ?? '', i.cost_price, i.price_retail, i.price_technician, i.stock_quantity, i.min_stock_alert, yesNo(i.track_serial), i.supplier ?? '', i.location ?? '']);
  } else if (mode === 'grocery' || mode === 'retail') {
    headers = ['Item Name', 'Brand', 'Category', 'Unit', 'Sell by Weight or Decimal', 'Barcode', 'Capital', 'Retail Price', 'Wholesale Price', 'Stock Count', 'Low Stock Alert', 'Supplier', 'Shelf / Bin'];
    rows = items.map(i => [i.item_name || i.model_name, i.brand, i.category || i.part_type, i.uom || 'pcs', yesNo(i.allow_fractional), i.sku_barcode ?? '', i.cost_price, i.price_retail, i.price_technician, i.stock_quantity, i.min_stock_alert, i.supplier ?? '', i.location ?? '']);
  } else if (mode === 'service') {
    headers = ['Service Name', 'Provider / Brand', 'Category', 'Service Code', 'Capital', 'Retail Price', 'Wholesale Price', 'Stock Count', 'Low Stock Alert', 'Supplier', 'Bench / Area'];
    rows = items.map(i => [i.item_name || i.model_name, i.brand, i.category || i.part_type, i.sku_barcode ?? '', i.cost_price, i.price_retail, i.price_technician, i.stock_quantity, i.min_stock_alert, i.supplier ?? '', i.location ?? '']);
  } else if (mode === 'hybrid') {
    headers = ['Shop Type', 'Item Name', 'Brand', 'Device / Model', 'Category / Type', 'Unit', 'Sell by Weight or Decimal', 'Requires Serial No.', 'Barcode', 'Capital', 'Retail Price', 'Wholesale Price', 'Stock Count', 'Low Stock Alert', 'Supplier', 'Shelf / Bin'];
    rows = items.map(i => [i.profile || '', i.item_name || '', i.brand, i.model_name, i.part_type, i.uom || 'pcs', yesNo(i.allow_fractional), yesNo(i.track_serial), i.sku_barcode ?? '', i.cost_price, i.price_retail, i.price_technician, i.stock_quantity, i.min_stock_alert, i.supplier ?? '', i.location ?? '']);
  } else {
    headers = ['Brand', 'Device / Model', 'Part Type', 'Barcode', 'Capital', 'Retail Price', 'Wholesale Price', 'Stock Count', 'Low Stock Alert', 'Supplier', 'Shelf / Bin'];
    rows = items.map(i => [i.brand, i.model_name, i.part_type, i.sku_barcode ?? '', i.cost_price, i.price_retail, i.price_technician, i.stock_quantity, i.min_stock_alert, i.supplier ?? '', i.location ?? '']);
  }
  return { mode, filename: `${slug}-inventory.csv`, headers, rows };
}

// CSV import: hoisted prepares, one txn. Refused rows no longer refuse the
// whole file (client complaint, 2026-11-14): every good row applies and every
// bad row comes back in result.errors as "Row N: reason" so the caller can
// state it. A client op_id still makes the whole file idempotent: a timeout
// retry re-answers the first summary instead of receiving every row's
// quantity a second time.
function importInventory(db, rows, ctx = {}, meta = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No rows to import');
  const defaultRet = meta.retail_markup != null && meta.retail_markup !== '' ? Number(meta.retail_markup) : getDefaultRetailMarkup(db);
  const defaultWho = meta.wholesale_markup != null && meta.wholesale_markup !== '' ? Number(meta.wholesale_markup) : getDefaultWholesaleMarkup(db);
  const bySku = db.prepare('SELECT * FROM inventory WHERE sku_barcode = ? COLLATE NOCASE');
  const byTriple = db.prepare(`SELECT * FROM inventory WHERE brand = ? COLLATE NOCASE AND (model_name = ? COLLATE NOCASE OR item_name = ? COLLATE NOCASE) AND (part_type = ? COLLATE NOCASE OR category = ? COLLATE NOCASE) ORDER BY id LIMIT 1`);
  const errors = [];
  const steps = [];
  const applied = [];
  const seenNewSkus = new Set();
  rows.forEach((raw, idx) => {
    try {
      const r = normalizeRow(raw);
      const sku = str(r.sku_barcode) || null;
      const rawName = str(r.item_name || r.name);
      const brand = str(r.brand) || (rawName ? 'General' : '');
      const model = str(r.model_name) || rawName;
      const part_type = str(r.part_type || r.category) || (rawName ? 'General' : '');
      let match = sku ? bySku.get(sku) : null;
      if (!match && brand && model && part_type) match = byTriple.get(brand, model, model, part_type, part_type);
      const hasFracFlag = r.allow_fractional != null && str(r.allow_fractional) !== '';
      const allowFrac = hasFracFlag ? parseBoolFlag(r.allow_fractional) === 1 : Boolean(match?.allow_fractional);
      const rawQty = Number(r.stock_quantity ?? 0);
      if (allowFrac) {
        if (!Number.isFinite(rawQty)) throw new Error('stock_quantity must be a number');
      } else {
        if (!Number.isInteger(rawQty)) throw new Error('stock_quantity must be an integer');
      }
      const qty = allowFrac ? roundQty(rawQty) : rawQty;
      if (match) {
        // Pre-validate the floor adjustStock enforces (audit 2026-11-14-b,
        // finding 1): a reduction past the part's stock is a row error now
        // instead of a transaction abort that refuses the whole file.
        if (qty < 0 && Number(match.stock_quantity) + qty < 0) {
          throw new Error(`Insufficient stock: cannot reduce ${partLabel(match)} by ${Math.abs(qty)} (current: ${match.stock_quantity})`);
        }
        const fields = {};
        for (const k of ['cost_price', 'price_retail', 'price_technician', 'min_stock_alert']) if (str(r[k]) !== '') fields[k] = Number(r[k]);
        for (const k of ['sku_barcode', 'supplier', 'location', 'item_name', 'category', 'uom', 'profile']) if (str(r[k]) !== '') fields[k] = str(r[k]);
        for (const k of ['allow_fractional', 'track_serial']) if (r[k] != null && str(r[k]) !== '') fields[k] = parseBoolFlag(r[k]);
        if (meta.auto_price && fields.cost_price != null && fields.cost_price > 0) {
          const costChanged = match.cost_price == null || Number(match.cost_price) !== fields.cost_price;
          if (fields.price_retail == null && (costChanged || !match.price_retail)) {
            fields.price_retail = money(fields.cost_price * (1 + defaultRet / 100));
          }
          if (fields.price_technician == null && (costChanged || !match.price_technician)) {
            fields.price_technician = money(fields.cost_price * (1 + defaultWho / 100));
          }
        }
        const hasFields = Object.keys(fields).length > 0;
        steps.push(() => {
          if (hasFields) updateInventoryItem(db, match.id, fields, { reason: 'receive', note: 'CSV import' }, ctx);
          if (qty !== 0) adjustStock(db, match.id, qty, { reason: 'receive', note: 'CSV import' }, ctx);
          return 'updated';
        });
        applied.push({ row: idx + 1, label: partLabel(match), quantity: qty, action: 'updated' });
      } else {
        // Two rows minting the same brand-new SKU both pass the catalog
        // pre-check, then the second insert hits the NOCASE UNIQUE constraint
        // and rolls back the whole file with a generic 500. Name the row instead.
        if (sku) {
          const skuKey = sku.toLowerCase();
          if (seenNewSkus.has(skuKey)) throw new Error(`Duplicate SKU in this file: ${sku} (an earlier row already creates it)`);
          seenNewSkus.add(skuKey);
        }
        const rowData = {
          ...r,
          allow_fractional: allowFrac ? 1 : 0,
          track_serial: r.track_serial != null && str(r.track_serial) !== '' ? parseBoolFlag(r.track_serial) : (r.track_serial ?? 0)
        };
        const costVal = Number(rowData.cost_price ?? 0);
        if (meta.auto_price && costVal > 0) {
          if (rowData.price_retail == null || str(rowData.price_retail) === '' || Number(rowData.price_retail) === 0) {
            rowData.price_retail = money(costVal * (1 + defaultRet / 100));
          }
          if (rowData.price_technician == null || str(rowData.price_technician) === '' || Number(rowData.price_technician) === 0) {
            rowData.price_technician = money(costVal * (1 + defaultWho / 100));
          }
        }
        // The sheet may carry no separate item-name column: hand the existing
        // General fallbacks in validateInventory the model name to fall back
        // from, so a name + quantity sheet imports without brand/type columns.
        if (!str(rowData.item_name) && str(rowData.model_name)) rowData.item_name = rowData.model_name;
        validateInventory({ ...rowData, stock_quantity: qty });
        const snap = { ...rowData, stock_quantity: qty };
        steps.push(() => { createInventoryItem(db, snap, { reason: 'receive', note: 'CSV import' }, ctx); return 'created'; });
        applied.push({ row: idx + 1, label: partLabel(snap), quantity: qty, action: 'created' });
      }
    } catch (err) { errors.push(`Row ${idx + 1}: ${err.message}`); }
  });
  // Nothing applied at all: report without burning the op_id, so a corrected
  // file can still land.
  if (steps.length === 0) return { created: 0, updated: 0, errors, applied: [] };
  return txn(db, () => {
    const opId = opIdOf(meta.op_id);
    if (opId && opReplayed(db, opId)) return { created: 0, updated: 0, errors: [], applied: [], replayed: true };
    let created = 0, updated = 0;
    for (const s of steps) (s() === 'created' ? created++ : updated++);
    if (opId) opRecord(db, opId);
    audit(db, ctx.actor, ctx.elevated, 'inventory', 'import', { created, updated, rejected: errors.length });
    // The applied list lets the partial-apply UI name the rows that already
    // landed: quantity is a DELTA, so a corrected re-import must omit them.
    return { created, updated, errors, applied };
  });
}

function deleteInventoryItem(db, id, ctx = {}) {
  const existing = getInventoryItem(db, id);
  // sale_items.inventory_id has no ON DELETE rule, so the DELETE would throw
  // a raw FK error and isInternalError would surface it as a generic 500.
  // A sold part must stay referable anyway; archive is the intended path.
  const soldLines = db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE inventory_id = ?').get(id).c;
  if (soldLines > 0) {
    const e = new Error(`Cannot delete: ${existing ? partLabel(existing) : 'this part'} appears in ${soldLines} sold line(s). Archive it instead so sales history stays accurate.`);
    e.statusCode = 409;
    throw e;
  }
  return txn(db, () => {
    const deleted = db.prepare('DELETE FROM inventory WHERE id = ?').run(id).changes > 0;
    if (deleted) {
      enqueueDelete(db, 'inventory', id);
      audit(db, ctx.actor, ctx.elevated, 'inventory', 'delete', existing ? { id, part: partLabel(existing), stock: existing.stock_quantity } : { id });
    }
    return deleted;
  });
}

function bulkEditInventory(db, { ids, action, params = {} }, ctx = {}, meta = {}) {
  if (!Array.isArray(ids) || ids.length === 0) throw new Error('No items selected for bulk edit');
  if (!['adjust_price', 'recalculate_markup', 'update_fields', 'archive', 'unarchive', 'delete'].includes(action)) {
    throw new Error(`Unknown bulk edit action "${action}"`);
  }
  const cleanIds = [...new Set(ids.map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (cleanIds.length === 0) throw new Error('No valid item IDs selected');

  return txn(db, () => {
    // Same replay gate as import: a retry after a lost response re-answers
    // instead of moving every selected price a second time.
    const opId = opIdOf(meta.op_id);
    if (opId && opReplayed(db, opId)) return { ok: true, updated: 0, replayed: true };
    let updated = 0;
    let skipped = 0;
    const getItem = db.prepare('SELECT * FROM inventory WHERE id = ?');

    if (action === 'adjust_price') {
      const target = params.target || 'both';
      const mode = params.mode || 'amount';
      if (!['retail', 'wholesale', 'both'].includes(target)) {
        throw new Error(`Invalid price target "${target}"`);
      }
      if (!['amount', 'pct'].includes(mode)) {
        throw new Error(`Invalid adjustment mode "${mode}"`);
      }
      if (params.value == null || params.value === '' || !Number.isFinite(Number(params.value))) {
        throw new Error('Valid adjustment value is required');
      }
      const value = Number(params.value);

      for (const id of cleanIds) {
        const item = getItem.get(id);
        if (!item) continue;
        const updates = {};
        if (target === 'retail' || target === 'both') {
          const curr = Number(item.price_retail) || 0;
          const next = mode === 'pct' ? money(curr * (1 + value / 100)) : money(curr + value);
          updates.price_retail = Math.max(0, next);
        }
        if (target === 'wholesale' || target === 'both') {
          const curr = Number(item.price_technician) || 0;
          const next = mode === 'pct' ? money(curr * (1 + value / 100)) : money(curr + value);
          updates.price_technician = Math.max(0, next);
        }
        updateInventoryItem(db, id, updates, { reason: 'adjust', note: 'Bulk price adjust' }, ctx);
        updated++;
      }
    } else if (action === 'recalculate_markup') {
      const retailMarkup = params.retail_markup != null && params.retail_markup !== '' && Number.isFinite(Number(params.retail_markup)) && Number(params.retail_markup) >= 0
        ? Number(params.retail_markup)
        : getDefaultRetailMarkup(db);
      const wholesaleMarkup = params.wholesale_markup != null && params.wholesale_markup !== '' && Number.isFinite(Number(params.wholesale_markup)) && Number(params.wholesale_markup) >= 0
        ? Number(params.wholesale_markup)
        : getDefaultWholesaleMarkup(db);

      for (const id of cleanIds) {
        const item = getItem.get(id);
        if (!item) continue;
        const cost = Number(item.cost_price) || 0;
        if (cost <= 0) continue;
        const updates = {
          price_retail: money(cost * (1 + retailMarkup / 100)),
          price_technician: money(cost * (1 + wholesaleMarkup / 100))
        };
        updateInventoryItem(db, id, updates, { reason: 'adjust', note: 'Bulk markup recalculate' }, ctx);
        updated++;
      }
    } else if (action === 'update_fields') {
      const fields = {};
      if (typeof params.supplier === 'string' && params.supplier.trim() !== '') {
        fields.supplier = cap(str(params.supplier));
      }
      if (typeof params.location === 'string' && params.location.trim() !== '') {
        fields.location = cap(str(params.location));
      }
      if (params.min_stock_alert != null && params.min_stock_alert !== '') {
        const minAlert = Number(params.min_stock_alert);
        if (Number.isInteger(minAlert) && minAlert >= 0) fields.min_stock_alert = minAlert;
        else throw new Error('Min stock alert must be a non-negative integer');
      }
      if (typeof params.profile === 'string') {
        const p = str(params.profile);
        if (p && !PROFILE_LANES.has(p)) throw new Error(`Unknown store profile "${p}"`);
        fields.profile = p;
      }
      if (Object.keys(fields).length === 0) throw new Error('At least one field to update is required');

      for (const id of cleanIds) {
        const item = getItem.get(id);
        if (!item) continue;
        updateInventoryItem(db, id, fields, { reason: 'adjust', note: 'Bulk field update' }, ctx);
        updated++;
      }
    } else if (action === 'archive' || action === 'unarchive') {
      const isArch = action === 'archive';
      for (const id of cleanIds) {
        const res = archiveInventoryItem(db, id, isArch, ctx);
        if (res) updated++;
      }
    } else if (action === 'delete') {
      // Sold parts stay referable (same rule as single delete): skip and
      // report them instead of aborting the whole batch over one receipt.
      const soldLines = db.prepare('SELECT COUNT(*) AS c FROM sale_items WHERE inventory_id = ?');
      for (const id of cleanIds) {
        if (!getItem.get(id)) continue;
        if (soldLines.get(id).c > 0) { skipped++; continue; }
        if (deleteInventoryItem(db, id, ctx)) updated++;
      }
    }

    audit(db, ctx.actor, ctx.elevated, 'inventory', 'bulk_edit', { count: updated, action, params });
    if (opId) opRecord(db, opId);
    return action === 'delete' ? { ok: true, updated, skipped } : { ok: true, updated };
  });
}

// ponytail: computed live from sale_items on every open, nothing stored or scheduled
function listReorderSuggestions(db, { days = 3, profile = 'active' } = {}) {
  const n = Number(days);
  const windowDays = Number.isInteger(n) && n >= 1 && n <= 90 ? n : 3;
  const lane = profile === 'active' ? activeBusinessType(db) : str(profile);
  const rows = db.prepare(`
    SELECT i.id, i.brand, i.model_name, i.part_type, i.item_name, i.category, i.uom, i.allow_fractional,
           i.profile, i.sku_barcode, i.supplier, i.stock_quantity, i.cost_price,
           i.price_retail, i.price_technician, i.min_stock_alert, i.location,
           COALESCE(SUM(si.quantity), 0) AS qty_sold
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id AND s.voided = 0
    JOIN inventory i ON i.id = si.inventory_id AND i.archived = 0
    WHERE si.item_type = 'part'
      AND datetime(s.created_at) >= datetime('now', ?)
    GROUP BY si.inventory_id
    ORDER BY i.supplier COLLATE NOCASE ASC, qty_sold DESC, i.brand ASC, i.model_name ASC
  `).all(`-${windowDays} days`)
    .filter(r => !lane || lane === 'hybrid' || lane === 'all' || itemVisibleInProfile(r, lane));
  for (const r of rows) {
    r.qty_sold = roundQty(r.qty_sold);
    r.suggested_qty = Math.max(roundQty(r.qty_sold - r.stock_quantity), 0);
    r.est_cost = money(r.suggested_qty * (r.cost_price || 0));
  }
  return { days: windowDays, rows };
}

// Receiving converts a reorder decision into stock: quantity in, optional new
// unit cost on the item. Per-line audits and outbox entries ride the existing
// adjustStock/updateInventoryItem paths; one bad line fails the whole batch,
// so a partial receive never claims stock that never arrived.
function receiveInventory(db, items, ctx = {}) {
  if (!Array.isArray(items) || !items.length || items.length > 100) {
    const e = new Error('items must be an array of 1 to 100 lines');
    e.statusCode = 400;
    throw e;
  }
  return txn(db, () => items.map((line, i) => {
    const n = i + 1;
    const qty = Number(line?.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      const e = new Error(`Line ${n}: quantity must be greater than zero`);
      e.statusCode = 400;
      throw e;
    }
    const rawCost = line?.unit_cost;
    const cost = rawCost === undefined || rawCost === null || rawCost === '' ? null : money(Number(rawCost));
    if (cost !== null && cost < 0) {
      const e = new Error(`Line ${n}: unit cost must be zero or more`);
      e.statusCode = 400;
      throw e;
    }
    const item = getInventoryItem(db, Number(line?.id));
    if (!item || item.archived) {
      const e = new Error(`Line ${n}: part not found`);
      e.statusCode = 404;
      throw e;
    }
    // Per-line idempotency: a retried request with the same ids replays the
    // first receive instead of double-adding the stock. adjustStock owns the
    // op_log record for its op_id; the pre-check just short-circuits the rest
    // of the line (the cost reprice included).
    const meta = { reason: 'receive', note: 'Supplier receive' };
    if (typeof line.op_id === 'string' && line.op_id.length <= 64) meta.op_id = `${line.op_id}:${item.id}`;
    if (meta.op_id && opReplayed(db, meta.op_id)) {
      return { id: item.id, name: partLabel(item), received: qty, unit_cost: cost ?? item.cost_price, replayed: true };
    }
    const updated = adjustStock(db, item.id, qty, meta, ctx);
    if (!updated) {
      const e = new Error(`Line ${n}: part not found`);
      e.statusCode = 404;
      throw e;
    }
    if (cost !== null) {
      // No op_id here: adjustStock already recorded this line's key, and the
      // dedup would read it as a replay and skip the cost update. The line
      // pre-check above owns replay for the whole receive.
      updateInventoryItem(db, item.id, { cost_price: cost }, { reason: 'receive', note: 'Supplier receive' }, ctx);
    }
    return { id: item.id, name: partLabel(item), received: qty, unit_cost: cost ?? item.cost_price };
  }));
}

module.exports = {
  partLabel,
  activeBusinessType,
  itemMatchesProfile,
  itemVisibleInProfile,
  opReplayed,
  opRecord,
  listInventory,
  getInventoryItem,
  getInventoryByBarcode,
  createInventoryItem,
  updateInventoryItem,
  adjustStock,
  recordStockMovement,
  listStockMovements,
  archiveInventoryItem,
  importInventory,
  deleteInventoryItem,
  bulkEditInventory,
  listReorderSuggestions,
  receiveInventory,
  buildInventoryExport,
  profileFileSlug
};
