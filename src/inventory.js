// phone-repair-pos/src/inventory.js
const { txn, audit } = require('./audit');
const { enqueueRow, enqueueDelete } = require('./sync');
const { money } = require('./money');
const { getDefaultRetailMarkup, getDefaultWholesaleMarkup } = require('./settings');

function listInventory(db, { search = '', brand = '', part_type = '', lowStockOnly = false, include_archived = false, limit, offset } = {}) {
  let query = 'SELECT * FROM inventory WHERE 1=1';
  const params = [];

  if (!include_archived) {
    query += ' AND archived = 0';
  }

  if (search) {
    // ponytail: escape LIKE wildcards in user input
    const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
    const term = `%${esc(search)}%`;
    query += ' AND (model_name LIKE ? ESCAPE \'\\\' OR brand LIKE ? ESCAPE \'\\\' OR part_type LIKE ? ESCAPE \'\\\' OR sku_barcode LIKE ? ESCAPE \'\\\')';
    params.push(term, term, term, term);
  }

  if (brand) {
    query += ' AND brand = ?';
    params.push(brand);
  }

  if (part_type) {
    query += ' AND part_type = ?';
    params.push(part_type);
  }

  if (lowStockOnly) {
    query += ' AND stock_quantity <= min_stock_alert';
  }

  query += ' ORDER BY brand ASC, model_name ASC, part_type ASC';
  // ponytail: optional pagination — unbounded listInventory is fine at <500 SKUs
  // (current catalog), but a 20k-row JSON blocks the sync event loop. Frontend
  // opts in with limit/offset; existing calls stay uncapped for backward compat.
  if (limit != null || offset != null) {
    const cap = Math.min(2000, Math.max(1, Number(limit) || 2000));
    const off = Math.max(0, Number(offset) || 0);
    query += ' LIMIT ? OFFSET ?';
    params.push(cap, off);
  }
  return db.prepare(query).all(...params);
}

function getInventoryItem(db, id) {
  return db.prepare('SELECT * FROM inventory WHERE id = ?').get(id) || null;
}

function getInventoryByBarcode(db, barcode) {
  if (!barcode || typeof barcode !== 'string') return null;
  const clean = barcode.trim();
  if (!clean) return null;
  return db.prepare('SELECT * FROM inventory WHERE sku_barcode = ? COLLATE NOCASE').get(clean) || null;
}

// Trust boundary for text fields: control characters never enter a stored
// value. Formula-prefix defanging happens in the CSV export writer so
// hand-typed values stay displayable in the app.
const str = v => (v ?? '').toString().replace(/[\u0000-\u001F\u007F]/g, '').trim();
// The catalog columns have no reason to hold an absurd string; movement notes
// and refs stay unbounded because a manager's explanation is not a defect.
const cap = s => s.slice(0, 200);

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
  const brand = cap(str(data.brand));
  if (!brand) throw new Error('Brand is required');

  const model_name = cap(str(data.model_name));
  if (!model_name) throw new Error('Model name is required');

  const part_type = cap(str(data.part_type));
  if (!part_type) throw new Error('Part type is required');

  const cost_price = money(data.cost_price ?? 0);
  if (cost_price < 0) throw new Error('Cost price cannot be negative');

  const price_retail = money(data.price_retail ?? 0);
  if (price_retail < 0) throw new Error('Retail price cannot be negative');

  const price_technician = money(data.price_technician ?? 0);
  if (price_technician < 0) throw new Error('Technician price cannot be negative');

  const stock_quantity = Number(data.stock_quantity ?? 0);
  if (!Number.isInteger(stock_quantity) || stock_quantity < 0) {
    throw new Error('Stock quantity must be a non-negative integer');
  }

  const min_stock_alert = Number(data.min_stock_alert ?? 3);
  if (!Number.isInteger(min_stock_alert) || min_stock_alert < 0) {
    throw new Error('Minimum stock alert must be a non-negative integer');
  }

  return {
    brand,
    model_name,
    part_type,
    sku_barcode: cap(str(data.sku_barcode)).toUpperCase() || null,
    cost_price,
    price_retail,
    price_technician,
    stock_quantity,
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

// One label shape everywhere: receipts, audit rows and analytics all read the
// same string, and a plain hyphen survives Windows thermal printer drivers
// where an em dash can print as a box glyph.
const partLabel = item => `${item.brand} ${item.model_name} - ${item.part_type}`;

function createInventoryItem(db, data, meta = {}, ctx = {}) {
  const v = validateInventory(data);
  return txn(db, () => {
    const opId = opIdOf(meta.op_id);
    const replay = opReplayed(db, opId);
    if (replay) return getInventoryItem(db, replay.entity_id);
    const item = db.prepare(`
      INSERT INTO inventory (brand, model_name, part_type, sku_barcode, cost_price, price_retail, price_technician, stock_quantity, min_stock_alert, supplier, location)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(v.brand, v.model_name, v.part_type, v.sku_barcode, v.cost_price, v.price_retail, v.price_technician, v.stock_quantity, v.min_stock_alert, v.supplier, v.location);
    if (opId) opRecord(db, opId, item.id);
    enqueueRow(db, 'inventory', item.id);
    if (v.stock_quantity !== 0) {
      recordStockMovement(db, { inventory_id: item.id, delta: v.stock_quantity, reason: meta.reason || 'opening_balance', note: meta.note });
    }
    audit(db, ctx.actor, ctx.elevated, 'inventory', 'create', {
      id: item.id, part: partLabel(v), cost_price: v.cost_price, price_retail: v.price_retail,
      price_technician: v.price_technician, stock: v.stock_quantity
    });
    return item;
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

  const v = validateInventory({ ...existing, ...data });
  return txn(db, () => {
    const item = db.prepare(`
      UPDATE inventory SET
        brand = ?, model_name = ?, part_type = ?, sku_barcode = ?, cost_price = ?,
        price_retail = ?, price_technician = ?, stock_quantity = ?, min_stock_alert = ?,
        supplier = ?, location = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
      RETURNING *
    `).get(v.brand, v.model_name, v.part_type, v.sku_barcode, v.cost_price, v.price_retail, v.price_technician, v.stock_quantity, v.min_stock_alert, v.supplier, v.location, id);
    enqueueRow(db, 'inventory', id);

    // "Set stock to" in the edit modal lands here; log the diff so the ledger
    // invariant and the history modal stay honest.
    const delta = v.stock_quantity - existing.stock_quantity;
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
  const delta = Number(deltaQty);
  if (isNaN(delta) || !Number.isInteger(delta)) throw new Error('Stock adjustment delta must be an integer');
  const before = getInventoryItem(db, id);
  if (!before) return null;
  return txn(db, () => {
    const opId = opIdOf(meta.op_id);
    const replay = opReplayed(db, opId);
    if (replay) return getInventoryItem(db, replay.entity_id);
    // ponytail: WHERE stock_quantity+? >=0 makes check+update atomic — fixes TOCTOU oversell
    const updated = db.prepare(`
      UPDATE inventory
      SET stock_quantity = stock_quantity + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND stock_quantity + ? >= 0
      RETURNING *
    `).get(delta, id, delta) || null;
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
  if (res.cost_price == null) {
    if (res['Capital'] != null) res.cost_price = res['Capital'];
    else if (res['Cost Price'] != null) res.cost_price = res['Cost Price'];
    else if (res['Cost'] != null) res.cost_price = res['Cost'];
  }
  if (res.price_retail == null) {
    if (res['Retail Price'] != null) res.price_retail = res['Retail Price'];
    else if (res['Retail'] != null) res.price_retail = res['Retail'];
  }
  if (res.price_technician == null) {
    if (res['Wholesale Price'] != null) res.price_technician = res['Wholesale Price'];
    else if (res['Wholesale'] != null) res.price_technician = res['Wholesale'];
    else if (res['Technician Price'] != null) res.price_technician = res['Technician Price'];
    else if (res['technician_price'] != null) res.price_technician = res['technician_price'];
  }
  if (res.sku_barcode == null) {
    if (res['SKU / Barcode'] != null) res.sku_barcode = res['SKU / Barcode'];
    else if (res['SKU'] != null) res.sku_barcode = res['SKU'];
    else if (res['Barcode'] != null) res.sku_barcode = res['Barcode'];
  }
  if (res.brand == null && res['Brand'] != null) res.brand = res['Brand'];
  if (res.model_name == null && res['Model Name'] != null) res.model_name = res['Model Name'];
  if (res.part_type == null && res['Part Type'] != null) res.part_type = res['Part Type'];
  if (res.stock_quantity == null) {
    if (res['Stock Qty'] != null) res.stock_quantity = res['Stock Qty'];
    else if (res['Stock Quantity'] != null) res.stock_quantity = res['Stock Quantity'];
  }
  if (res.min_stock_alert == null && res['Min Stock Alert'] != null) res.min_stock_alert = res['Min Stock Alert'];
  if (res.supplier == null && res['Supplier'] != null) res.supplier = res['Supplier'];
  if (res.location == null && res['Location'] != null) res.location = res['Location'];
  return res;
}

// CSV import: hoisted prepares, one txn, all-or-nothing. A client op_id makes
// the whole file idempotent: a timeout retry re-answers the first summary
// instead of receiving every row's quantity a second time.
function importInventory(db, rows, ctx = {}, meta = {}) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error('No rows to import');
  const defaultRet = meta.retail_markup != null && meta.retail_markup !== '' ? Number(meta.retail_markup) : getDefaultRetailMarkup(db);
  const defaultWho = meta.wholesale_markup != null && meta.wholesale_markup !== '' ? Number(meta.wholesale_markup) : getDefaultWholesaleMarkup(db);
  const bySku = db.prepare('SELECT * FROM inventory WHERE sku_barcode = ? COLLATE NOCASE');
  const byTriple = db.prepare(`SELECT * FROM inventory WHERE brand = ? COLLATE NOCASE AND model_name = ? COLLATE NOCASE AND part_type = ? COLLATE NOCASE ORDER BY id LIMIT 1`);
  const errors = [];
  const steps = [];
  rows.forEach((raw, idx) => {
    try {
      const r = normalizeRow(raw);
      const sku = str(r.sku_barcode) || null;
      const brand = str(r.brand), model = str(r.model_name), part_type = str(r.part_type);
      let match = sku ? bySku.get(sku) : null;
      if (!match && brand && model && part_type) match = byTriple.get(brand, model, part_type);
      const qty = Number(r.stock_quantity ?? 0);
      if (!Number.isInteger(qty)) throw new Error('stock_quantity must be an integer');
      if (match) {
        const fields = {};
        for (const k of ['cost_price', 'price_retail', 'price_technician']) if (str(r[k]) !== '') fields[k] = Number(r[k]);
        for (const k of ['supplier', 'location']) if (str(r[k]) !== '') fields[k] = str(r[k]);
        if (meta.auto_price && fields.cost_price != null && fields.cost_price > 0) {
          const costChanged = match.cost_price == null || Number(match.cost_price) !== fields.cost_price;
          if (fields.price_retail == null && (costChanged || !match.price_retail)) {
            fields.price_retail = Math.round(fields.cost_price * (1 + defaultRet / 100));
          }
          if (fields.price_technician == null && (costChanged || !match.price_technician)) {
            fields.price_technician = Math.round(fields.cost_price * (1 + defaultWho / 100));
          }
        }
        const hasFields = Object.keys(fields).length > 0;
        steps.push(() => {
          if (hasFields) updateInventoryItem(db, match.id, fields, { reason: 'receive', note: 'CSV import' }, ctx);
          if (qty !== 0) adjustStock(db, match.id, qty, { reason: 'receive', note: 'CSV import' }, ctx);
          return 'updated';
        });
      } else {
        const rowData = { ...r };
        const costVal = Number(rowData.cost_price ?? 0);
        if (meta.auto_price && costVal > 0) {
          if (rowData.price_retail == null || str(rowData.price_retail) === '' || Number(rowData.price_retail) === 0) {
            rowData.price_retail = Math.round(costVal * (1 + defaultRet / 100));
          }
          if (rowData.price_technician == null || str(rowData.price_technician) === '' || Number(rowData.price_technician) === 0) {
            rowData.price_technician = Math.round(costVal * (1 + defaultWho / 100));
          }
        }
        validateInventory({ ...rowData, stock_quantity: qty });
        const snap = { ...rowData, stock_quantity: qty };
        steps.push(() => { createInventoryItem(db, snap, { reason: 'receive', note: 'CSV import' }, ctx); return 'created'; });
      }
    } catch (err) { errors.push(`Row ${idx + 1}: ${err.message}`); }
  });
  if (errors.length) throw new Error(errors.join(' | '));
  return txn(db, () => {
    const opId = opIdOf(meta.op_id);
    if (opId && opReplayed(db, opId)) return { created: 0, updated: 0, errors: [], replayed: true };
    let created = 0, updated = 0;
    for (const s of steps) (s() === 'created' ? created++ : updated++);
    if (opId) opRecord(db, opId);
    audit(db, ctx.actor, ctx.elevated, 'inventory', 'import', { created, updated });
    return { created, updated, errors: [] };
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
  if (!['adjust_price', 'recalculate_markup', 'update_fields', 'archive', 'unarchive'].includes(action)) {
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
          const next = mode === 'pct' ? Math.round(curr * (1 + value / 100)) : Math.round(curr + value);
          updates.price_retail = Math.max(0, next);
        }
        if (target === 'wholesale' || target === 'both') {
          const curr = Number(item.price_technician) || 0;
          const next = mode === 'pct' ? Math.round(curr * (1 + value / 100)) : Math.round(curr + value);
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
          price_retail: Math.round(cost * (1 + retailMarkup / 100)),
          price_technician: Math.round(cost * (1 + wholesaleMarkup / 100))
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
    }

    audit(db, ctx.actor, ctx.elevated, 'inventory', 'bulk_edit', { count: updated, action, params });
    if (opId) opRecord(db, opId);
    return { ok: true, updated };
  });
}

// ponytail: computed live from sale_items on every open, nothing stored or scheduled
function listReorderSuggestions(db, { days = 3 } = {}) {
  const n = Number(days);
  const windowDays = Number.isInteger(n) && n >= 1 && n <= 90 ? n : 3;
  const rows = db.prepare(`
    SELECT i.id, i.brand, i.model_name, i.part_type, i.sku_barcode,
           i.supplier, i.stock_quantity, i.cost_price,
           COALESCE(SUM(si.quantity), 0) AS qty_sold
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id AND s.voided = 0
    JOIN inventory i ON i.id = si.inventory_id AND i.archived = 0
    WHERE si.item_type = 'part'
      AND s.created_at >= datetime('now', ?)
    GROUP BY si.inventory_id
    ORDER BY i.supplier COLLATE NOCASE ASC, qty_sold DESC, i.brand ASC, i.model_name ASC
  `).all(`-${windowDays} days`);
  for (const r of rows) {
    r.suggested_qty = Math.max(r.qty_sold - r.stock_quantity, 0);
    r.est_cost = money(r.suggested_qty * (r.cost_price || 0));
  }
  return { days: windowDays, rows };
}

module.exports = {
  partLabel,
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
  listReorderSuggestions
};
