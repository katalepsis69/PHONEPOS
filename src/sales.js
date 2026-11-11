const crypto = require('node:crypto');
const { getInventoryItem, partLabel } = require('./inventory');
const { money } = require('./money');
const { audit, txn } = require('./audit');
const { enqueueRow } = require('./sync');
const { cleanName: normalizeName, foldName, foldSql } = require('./names');
const { closedPeriodAt } = require('./reconcile');

const generateSaleCode = () => `SALE-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

// A typo'd method is collected money that no dashboard bucket ever reports, so reject it here.
const PAYMENT_METHODS = ['cash', 'gcash', 'transfer', 'credit'];
const CUSTOMER_TYPES = ['retail', 'technician', 'wholesale'];
const str = v => (v ?? '').toString().trim();
// Phone, payment reference and labor text have no catalog cap upstream; leave
// the absurd out the same way inventory.js does for its own columns.
const capped = (v, n) => str(v).slice(0, n);

function createSale(db, {
  customer_name = 'Walk-in Customer',
  customer_phone = '',
  customer_type = 'retail',
  payment_method = 'cash',
  payment_reference = '',
  items = [],
  discount = 0.0,
  amount_paid = 0.0,
  op_id = null
}, ctx = {}) {
  const opId = str(op_id) || null;
  if (opId && opId.length > 64) throw new Error('op_id too long');
  if (opId) {
    const existing = db.prepare('SELECT id FROM sales WHERE op_id = ?').get(opId);
    if (existing) return getSaleDetails(db, existing.id);
  }
  if (!items || items.length === 0) {
    throw new Error('Cannot create sale with empty items');
  }
  if (!PAYMENT_METHODS.includes(payment_method)) {
    throw new Error(`Invalid payment method: ${payment_method}. Must be one of ${PAYMENT_METHODS.join(', ')}`);
  }
  if (!CUSTOMER_TYPES.includes(customer_type)) {
    throw new Error(`Invalid customer type: ${customer_type}. Must be one of ${CUSTOMER_TYPES.join(', ')}`);
  }
  // Same rule credits.js applies to settlements: a gcash or transfer collection
  // moves no cash through the drawer, so the ref number is the only trace
  // that can be checked afterwards.
  if ((payment_method === 'gcash' || payment_method === 'transfer') && !str(payment_reference)) {
    throw new Error(`A ref # is required for ${payment_method} sales so the collection can be checked`);
  }

  const cleanName = normalizeName(customer_name, 'Walk-in Customer');

  let subtotal = 0.0;
  const processedItems = [];

  // ponytail: batch-fetch parts in one query instead of N getInventoryItem calls
  const partIds = [...new Set(items.filter(it => it.item_type !== 'labor').map(it => it.inventory_id).filter(Boolean))];
  const invById = new Map();
  if (partIds.length) {
    const ph = partIds.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT * FROM inventory WHERE id IN (${ph})`).all(...partIds)) invById.set(row.id, row);
  }
  for (const it of items) {
    const isLabor = it.item_type === 'labor';
    const inv = isLabor ? null : invById.get(it.inventory_id);
    if (!isLabor && !inv) throw new Error(`Inventory item ID ${it.inventory_id} not found`);

    const isFractional = Boolean(inv?.allow_fractional);
    const qty = Number(it.quantity);
    if (!Number.isFinite(qty) || qty <= 0 || (!isFractional && !Number.isInteger(qty))) {
      throw new Error(`Invalid item quantity: ${it.quantity}. Must be a positive ${isFractional ? 'number' : 'integer'}.`);
    }
    const cleanQty = isFractional ? Math.round(qty * 1000) / 1000 : qty;
    // Rounding a sub-0.0005 fractional qty lands on 0; the raw qty > 0 check
    // above passed, so re-guard the rounded value (adjustStock has the same rule).
    if (cleanQty <= 0) throw new Error(`Invalid item quantity: ${it.quantity}. Must be a positive ${isFractional ? 'number' : 'integer'}.`);

    if (isLabor) {
      const unitPrice = money(it.unit_price ?? 0.0);
      if (unitPrice < 0) throw new Error('Labor price cannot be negative');
      const itemTotal = money(unitPrice * cleanQty);
      subtotal = money(subtotal + itemTotal);
      processedItems.push({ inventory_id: null, item_type: 'labor', item_name: capped(it.item_name, 200) || 'Service / Labor', unit_cost: 0.0, unit_price: unitPrice, quantity: cleanQty, total_price: itemTotal });
      continue;
    }

    if (inv.stock_quantity < cleanQty) throw new Error(`Insufficient stock for ${partLabel(inv)}. Available: ${inv.stock_quantity}`);
    const isWholesale = customer_type === 'technician' || customer_type === 'wholesale';
    const unitPrice = money(isWholesale ? inv.price_technician : inv.price_retail);
    if (unitPrice < 0) throw new Error('Part price cannot be negative');
    const itemTotal = money(unitPrice * cleanQty);
    subtotal = money(subtotal + itemTotal);
    processedItems.push({ inventory_id: inv.id, item_type: 'part', item_name: partLabel(inv), unit_cost: inv.cost_price, unit_price: unitPrice, quantity: cleanQty, total_price: itemTotal });
  }

  const discountNum = money(discount ?? 0.0);
  if (discountNum < 0) throw new Error('Discount amount cannot be negative');
  if (discountNum > subtotal) throw new Error(`Discount ${discountNum.toFixed(2)} exceeds the sale subtotal ${subtotal.toFixed(2)}`);
  const totalAmount = money(Math.max(0, subtotal - discountNum));

  const paid = money(amount_paid ?? 0.0);
  if (paid < 0) throw new Error('Amount paid cannot be negative');
  if (payment_method !== 'credit' && paid < totalAmount) throw new Error('Non-credit sales must be fully paid');
  const changeAmount = payment_method === 'credit' ? 0.0 : money(Math.max(0, paid - totalAmount));
  const creditBalance = money(Math.max(0, totalAmount - paid));
  const saleCode = generateSaleCode();

  if (payment_method === 'credit') {
    if (paid > totalAmount) throw new Error('Credit sale payment cannot exceed total amount');
    // Folded comparisons, not COLLATE NOCASE: NOCASE folds ASCII only, so a
    // customer re-casing a diacritic name ('MUÑOZ' vs 'Muñoz') matched neither
    // the profile nor the debt sum and walked past the limit check entirely.
    const foldedName = foldName(cleanName);
    const prof = db.prepare(`SELECT credit_limit FROM customer_profiles WHERE ${foldSql(db, 'customer_name')} = ?`).get(foldedName);
    const limit = money(prof?.credit_limit || 0);
    if (limit > 0) {
      const curDebtRow = db.prepare(`SELECT COALESCE(SUM(credit_balance), 0.0) AS debt FROM sales WHERE ${foldSql(db, 'customer_name')} = ? AND voided = 0`).get(foldedName);
      const curDebt = money(curDebtRow?.debt || 0);
      const newDebt = money(curDebt + creditBalance);
      if (newDebt > limit) {
        if (!ctx.elevated) {
          const e = new Error(`Credit limit of ₱${limit.toFixed(2)} exceeded (Total debt would be ₱${newDebt.toFixed(2)}). Manager authorization required.`);
          e.statusCode = 403;
          e.code = 'elevation_required';
          throw e;
        }
      }
    }
  }

  return txn(db, () => {
    const saleId = Number(db.prepare(`
      INSERT INTO sales (sale_code, customer_name, customer_phone, customer_type, payment_method, payment_reference, subtotal, discount, total_amount, amount_paid, change_amount, credit_balance, created_at, op_id, staff_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id
    `).get(saleCode, cleanName, capped(customer_phone, 60), customer_type, payment_method, capped(payment_reference, 120), subtotal, discountNum, totalAmount, paid, changeAmount, creditBalance, new Date().toISOString(), opId, ctx.actor?.type === 'staff' ? ctx.actor.id ?? null : null).id);

    // ponytail: hoisted prepares + single timestamp value
    const now = new Date().toISOString();
    const insItem = db.prepare('INSERT INTO sale_items (sale_id, inventory_id, item_type, item_name, unit_cost, unit_price, quantity, total_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const decStock = db.prepare('UPDATE inventory SET stock_quantity = stock_quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock_quantity >= ? RETURNING id');
    const insMov = db.prepare('INSERT INTO stock_movements (inventory_id, delta, reason, note, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    for (const p of processedItems) {
      insItem.run(saleId, p.inventory_id, p.item_type, p.item_name, p.unit_cost, p.unit_price, p.quantity, p.total_price);
      if (p.inventory_id && p.item_type === 'part') {
        if (!decStock.get(p.quantity, p.inventory_id, p.quantity)) throw new Error(`Insufficient stock for ${p.item_name}. Available: 0`);
        enqueueRow(db, 'inventory', p.inventory_id);
        enqueueRow(db, 'stock_movements', Number(insMov.run(p.inventory_id, -p.quantity, 'sale', '', saleCode, now).lastInsertRowid));
      }
    }
    audit(db, ctx.actor, ctx.elevated, 'sale', 'create', { sale_code: saleCode, customer: cleanName, payment_method, total: totalAmount, discount: discountNum, items: processedItems.length });
    enqueueRow(db, 'sales', saleId);
    for (const r of db.prepare('SELECT id FROM sale_items WHERE sale_id = ?').all(saleId)) enqueueRow(db, 'sale_items', r.id);
    return getSaleDetails(db, saleId);
  });
}

function listSales(db, { limit = 50, offset = 0, search = '', payment_method = '', date = '' } = {}) {
  limit = Math.min(500, Math.max(1, Number(limit) || 50));
  offset = Math.max(0, Number(offset) || 0);
  // rma_count/rma_available ride along so the history view can tag claimed
  // sales and grey out RMA when every part line is fully returned — without a
  // second request. The sale_id/sale_item_id indexes keep the subqueries cheap.
  let query = `
    SELECT sales.*,
      (SELECT COUNT(*) FROM warranty_returns wr WHERE wr.sale_id = sales.id) AS rma_count,
      (SELECT COALESCE(SUM(wr.refund_amount), 0) FROM warranty_returns wr WHERE wr.sale_id = sales.id) AS refunded_amount,
      CASE WHEN EXISTS (
        SELECT 1 FROM sale_items si
        WHERE si.sale_id = sales.id
          AND si.item_type = 'part'
          AND si.quantity > COALESCE((SELECT SUM(wr.quantity) FROM warranty_returns wr WHERE wr.sale_item_id = si.id), 0)
      ) THEN 1 ELSE 0 END AS rma_available
    FROM sales WHERE 1=1`;
  const params = [];

  if (payment_method) {
    query += ' AND payment_method = ?';
    params.push(payment_method);
  }

  // Local calendar day, matching the dashboard's date convention.
  if (date) {
    query += " AND date(created_at, 'localtime') = ?";
    params.push(date);
  }

  if (search) {
    const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
    const term = `%${esc(search)}%`;
    query += ` AND (sale_code LIKE ? ESCAPE '\\' OR customer_name LIKE ? ESCAPE '\\' OR customer_phone LIKE ? ESCAPE '\\' OR payment_reference LIKE ? ESCAPE '\\'
      OR EXISTS (SELECT 1 FROM sale_items si WHERE si.sale_id = sales.id AND si.item_name LIKE ? ESCAPE '\\'))`;
    params.push(term, term, term, term, term);
  }

  query += ' ORDER BY id DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  return db.prepare(query).all(...params);
}

function getSaleDetails(db, saleId) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
  if (!sale) return null;
  const items = db.prepare(`
    SELECT si.*, inv.part_type,
      COALESCE((SELECT SUM(wr.quantity) FROM warranty_returns wr WHERE wr.sale_item_id = si.id), 0) AS returned_quantity
    FROM sale_items si
    LEFT JOIN inventory inv ON si.inventory_id = inv.id
    WHERE si.sale_id = ?
  `).all(saleId);
  const returns = db.prepare('SELECT * FROM warranty_returns WHERE sale_id = ? ORDER BY id DESC').all(saleId);
  const refunded_amount = money(returns.reduce((sum, r) => sum + Number(r.refund_amount || 0), 0));
  return { ...sale, items, returns, refunded_amount };
}

function voidSale(db, saleId, reason, ctx = {}) {
  const r = str(reason);
  if (!r) throw new Error('Void reason is required');
  return txn(db, () => {
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(saleId);
    if (!sale) throw new Error('Sale not found');
    if (sale.voided) throw new Error('Sale already voided');
    // cash_refund exists → reject (money already out, no double-restore)
    const cashRefund = db.prepare("SELECT 1 FROM warranty_returns WHERE sale_id = ? AND return_type='cash_refund' LIMIT 1").get(saleId);
    if (cashRefund) throw new Error('Cannot void: sale has cash refund(s)');
    // credit_refund also blocks a void, but for the opposite reason: the RMA
    // reduced credit_balance, so the settled-balance check below would misread
    // a clean utang sale as settled. Name the RMA instead of lying.
    const creditRefund = db.prepare("SELECT return_code FROM warranty_returns WHERE sale_id = ? AND return_type='credit_refund' ORDER BY id LIMIT 1").get(saleId);
    if (creditRefund) throw new Error(`Cannot void: sale has a credit refund (RMA ${creditRefund.return_code}). The refund already relieved the debt.`);
    // A downpayment is part of the original sale and can be voided with it.
    // Later settlement cash reduces the balance below the original debt and
    // must never survive a void as an unassigned credit payment.
    const originalDebt = money(Math.max(0, sale.total_amount - sale.amount_paid));
    if (sale.payment_method === 'credit' && sale.credit_balance < originalDebt - 0.001) throw new Error('Cannot void: sale has been settled');
    const items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ?').all(saleId);
    let restored = 0;
    for (const si of items) {
      if (!si.inventory_id) continue;
      const returned = db.prepare('SELECT COALESCE(SUM(quantity),0) AS s FROM warranty_returns WHERE sale_item_id = ?').get(si.id).s;
      const restoreQty = si.quantity - returned;
      if (restoreQty <= 0) continue;
      db.prepare('UPDATE inventory SET stock_quantity = stock_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(restoreQty, si.inventory_id);
      enqueueRow(db, 'inventory', si.inventory_id);
      enqueueRow(db, 'stock_movements', Number(db.prepare('INSERT INTO stock_movements (inventory_id, delta, reason, note, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(si.inventory_id, restoreQty, 'void', r, sale.sale_code, new Date().toISOString()).lastInsertRowid));
      restored += restoreQty;
    }
    // ponytail: a replacement RMA drew a fresh unit via adjustStock (-qty on
    // replacement_inventory_id) while the original unit was DOA. Restore the
    // replacement unit when the sale is voided.
    const replacements = db.prepare(`
      SELECT replacement_inventory_id, SUM(quantity) AS qty
      FROM warranty_returns
      WHERE sale_id = ? AND return_type = 'replacement' AND replacement_inventory_id IS NOT NULL
      GROUP BY replacement_inventory_id
    `).all(saleId);
    for (const rep of replacements) {
      if (!(rep.qty > 0)) continue;
      db.prepare('UPDATE inventory SET stock_quantity = stock_quantity + ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(rep.qty, rep.replacement_inventory_id);
      enqueueRow(db, 'inventory', rep.replacement_inventory_id);
      enqueueRow(db, 'stock_movements', Number(db.prepare('INSERT INTO stock_movements (inventory_id, delta, reason, note, ref, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(rep.replacement_inventory_id, rep.qty, 'void', r, sale.sale_code, new Date().toISOString()).lastInsertRowid));
      restored += rep.qty;
    }
    // A void after the period covering the sale was signed pays out of today's
    // drawer; the signed number is never rewritten. The payout is owed only
    // when the close actually counted this sale, so the sale's instant is
    // compared against the period's signed instant: a sale created after the
    // close (or in a still-open shift) never entered the signed count, and
    // voiding it leaves today's buckets to absorb it.
    const closed = closedPeriodAt(db, sale.created_at);
    const counted = Boolean(closed && Date.parse(sale.created_at) <= Date.parse(closed.signed_at));
    const drawerCash = sale.payment_method === 'cash' || sale.payment_method === 'credit'
      ? money((sale.amount_paid || 0) - (sale.change_amount || 0))
      : 0;
    let adjustment = null;
    if (counted && drawerCash > 0) {
      const r = db.prepare('INSERT INTO cash_adjustments (amount, reason, ref, source_kind, source_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(-drawerCash, `Void of ${sale.sale_code} after ${closed.kind === 'day' ? 'day' : 'shift'} close`, sale.sale_code, 'sale_void', saleId, new Date().toISOString());
      enqueueRow(db, 'cash_adjustments', Number(r.lastInsertRowid));
      adjustment = { id: Number(r.lastInsertRowid), amount: -drawerCash, period: closed };
    }
    db.prepare('UPDATE sales SET voided = 1, void_reason = ?, credit_balance = 0 WHERE id = ?').run(r, saleId);
    enqueueRow(db, 'sales', saleId);
    audit(db, ctx.actor, ctx.elevated, 'sale', 'void', { sale_code: sale.sale_code, total: sale.total_amount, reason: r, restored, after_close: closed ? closed.label : null, adjustment: adjustment ? adjustment.amount : null });
    return { ...sale, voided: 1, void_reason: r, credit_balance: 0, restored, after_close: closed, adjustment };
  });
}

module.exports = {
  createSale,
  listSales,
  getSaleDetails,
  voidSale
};
