const crypto = require('node:crypto');
const { getInventoryItem, adjustStock } = require('./inventory');
const { money } = require('./money');
const { audit, txn } = require('./audit');
const { enqueueRow } = require('./sync');
// warrantyDays() is the one rule for the warranty_days setting and src/printer.js
// owns its server-side copy, so the RMA window and the printed slip cannot drift
// apart again. Requiring the printer module costs nothing: it loads no database
// and spawns nothing until a slip is actually sent.
const { warrantyDays } = require('./printer');

const generateReturnCode = () => `RMA-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

// An unknown type falls through every branch below: recorded, but no stock moved
// and no money refunded -- a silent no-op RMA. Reject it, like sales rejects
// unknown payment methods.
const RETURN_TYPES = ['replacement', 'credit_refund', 'cash_refund'];

function createWarrantyReturn(db, {
  sale_id,
  sale_item_id,
  quantity = 1,
  return_type = 'replacement',
  return_reason = 'other',
  replacement_inventory_id = null,
  refund_amount = 0.0,
  technician_notes = '',
  op_id = null
}, ctx = {}) {
  // Idempotency, same contract as sales: a client op_id replays as the
  // original RMA. Without it, a double submit on a qty-2 line drew two
  // replacement units (measured 2026-09-27).
  const opId = String(op_id || '').trim() || null;
  if (opId && opId.length > 64) throw new Error('op_id too long');
  if (opId) {
    const existing = db.prepare('SELECT id FROM warranty_returns WHERE op_id = ?').get(opId);
    if (existing) return getWarrantyReturnDetails(db, existing.id);
  }
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(sale_id);
  if (!sale) throw new Error(`Sale ID ${sale_id} not found`);
  if (sale.voided) throw new Error('Cannot return items on a voided sale: stock was already restored by the void');

  // The receipt promises warranty_days; an RMA on an older sale is out of
  // policy. Elevation overrides it and the audit detail carries the flag.
  // The one rule is warrantyDays() in src/printer.js, the function the slip is
  // printed from, and this reads it rather than restating it: `Number()` with no
  // trim and no null guard used to turn a NULL or blank row into a 0-day window,
  // so a shop was told its warranty ran out yesterday above a receipt that
  // printed seven days. A saved "0" still means no warranty, here and there.
  const windowDays = warrantyDays(db.prepare("SELECT value FROM shop_settings WHERE key = 'warranty_days'").get()?.value);
  const ageDays = (Date.now() - Date.parse(sale.created_at)) / 86400000;
  const outOfWindow = ageDays > windowDays;
  if (outOfWindow && !ctx.elevated) {
    throw new Error(`Warranty expired: sale is ${Math.floor(ageDays)} days old, warranty window is ${windowDays} days`);
  }

  if (!RETURN_TYPES.includes(return_type)) {
    throw new Error(`Invalid return type: ${return_type}. Must be one of ${RETURN_TYPES.join(', ')}`);
  }
  if (return_type === 'credit_refund' && !(sale.credit_balance > 0)) {
    throw new Error('Credit refund only applies to sales with an outstanding credit balance');
  }

  const item = db.prepare('SELECT * FROM sale_items WHERE id = ? AND sale_id = ?').get(sale_item_id, sale_id);
  if (!item) throw new Error(`Sale item ID ${sale_item_id} not found on this sale`);

  const invMeta = item.inventory_id ? getInventoryItem(db, item.inventory_id) : null;
  const allowFrac = Boolean(invMeta?.allow_fractional) || !Number.isInteger(Number(item.quantity));
  const roundQty = q => Math.round(Number(q) * 1000) / 1000;
  let qty;
  if (allowFrac) {
    const rawQty = quantity === undefined || quantity === null || quantity === '' ? 1 : Number(quantity);
    qty = Number.isFinite(rawQty) && rawQty > 0 ? roundQty(rawQty) : 0;
    if (!(qty > 0)) qty = Math.min(1, roundQty(item.quantity));
  } else {
    qty = Math.max(1, parseInt(quantity, 10) || 1);
  }

  const alreadyReturned = db.prepare(`
    SELECT COALESCE(SUM(quantity), 0) as total_returned
    FROM warranty_returns
    WHERE sale_item_id = ?
  `).get(sale_item_id)?.total_returned || 0;

  if (alreadyReturned + qty > item.quantity + 1e-6) {
    throw new Error(`Cannot return item: already returned ${alreadyReturned} of ${item.quantity} purchased unit(s)`);
  }

  const returnCode = generateReturnCode();
  const notes = (technician_notes || '').trim().slice(0, 500);
  const customerName = sale.customer_name || 'Walk-in Customer';

  return txn(db, () => {
    let finalRefundAmount = money(refund_amount ?? 0.0);
    let replacementInvId = replacement_inventory_id;

    if (return_type === 'replacement') {
      // A labor line has no part behind it, so the part_type guard below would
      // silently skip and let any SKU out the door; refuse the shape outright.
      if (item.item_type === 'labor') throw new Error('A labor line carries no part to replace');
      const repTargetId = replacementInvId || item.inventory_id;
      if (!repTargetId) throw new Error('Replacement part item not specified');
      const inv = getInventoryItem(db, repTargetId);
      if (repTargetId !== item.inventory_id) {
        // The returned unit came from one SKU; drawing a different part needs
        // a manager, and even then the part_type must match, so an elevated
        // swap can never hand a battery over an LCD line.
        if (!ctx.elevated) throw new Error('Replacement must draw the same part as the returned line; a different item needs a manager');
        const returned = item.inventory_id ? getInventoryItem(db, item.inventory_id) : null;
        if (returned && inv && returned.part_type !== inv.part_type) {
          throw new Error(`Cross-part-type replacement rejected: returned ${returned.part_type}, offered ${inv.part_type}`);
        }
      }
      if (!inv || inv.stock_quantity + 1e-6 < qty) {
        throw new Error(`Insufficient stock for replacement part: ${inv ? inv.model_name : 'unknown'} (needed: ${qty}, available: ${inv ? inv.stock_quantity : 0})`);
      }
      adjustStock(db, repTargetId, -qty, { reason: 'rma_replacement', ref: returnCode });
      replacementInvId = repTargetId;
      // A replacement moves no money, and every consumer (netProfit, netRevenue,
      // refunded totals, dashboard, customer details) subtracts refund_amount
      // whatever the type. The field is request-supplied and defaults to 0 but
      // was never forced, so one bad payload permanently deflated the reports.
      finalRefundAmount = 0;
    } else if (return_type === 'credit_refund') {
      // A refund never exceeds the returned units' price, and debt relief never
      // exceeds what is still owed — an inflated amount would wipe the whole
      // balance and fake the dashboard's refunded figure. The per-unit price is
      // scaled by the sale's discount exactly like the cash path below, or a
      // discounted utang sale forgives the discount share twice: the credit
      // ceiling used to be the undiscounted unit_price * qty.
      const discountedTotal = sale.subtotal > 0
        ? money((item.total_price / item.quantity) * qty * sale.total_amount / sale.subtotal)
        : 0;
      finalRefundAmount = money(Math.min(
        finalRefundAmount > 0 ? finalRefundAmount : discountedTotal,
        discountedTotal,
        sale.credit_balance
      ));
      const newCreditBal = money(Math.max(0, sale.credit_balance - finalRefundAmount));
      db.prepare('UPDATE sales SET credit_balance = ? WHERE id = ?').run(newCreditBal, sale.id);
      enqueueRow(db, 'sales', sale.id);
    } else if (return_type === 'cash_refund') {
      const discountedTotal = sale.subtotal > 0
        ? money((item.total_price / item.quantity) * qty * sale.total_amount / sale.subtotal)
        : 0;
      const refunds = db.prepare(`
        SELECT
          COALESCE(SUM(CASE WHEN return_type = 'cash_refund' THEN refund_amount ELSE 0 END), 0) AS cash_refunded,
          COALESCE(SUM(CASE WHEN return_type = 'credit_refund' THEN refund_amount ELSE 0 END), 0) AS credit_refunded
        FROM warranty_returns WHERE sale_id = ?
      `).get(sale.id);
      const collected = money(Math.max(0, sale.total_amount - sale.credit_balance - refunds.credit_refunded));
      const remainingCollected = money(Math.max(0, collected - refunds.cash_refunded));
      finalRefundAmount = money(Math.min(
        finalRefundAmount > 0 ? finalRefundAmount : discountedTotal,
        discountedTotal,
        remainingCollected
      ));
      enqueueRow(db, 'sales', sale.id);
    }

    const stmt = db.prepare(`
      INSERT INTO warranty_returns (
        return_code, sale_id, sale_item_id, customer_name, item_name,
        quantity, return_type, return_reason, replacement_inventory_id,
        refund_amount, technician_notes, created_at, op_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      returnCode,
      sale.id,
      item.id,
      customerName,
      item.item_name,
      qty,
      return_type,
      return_reason,
      replacementInvId,
      finalRefundAmount,
      notes,
      new Date().toISOString(),
      opId
    );

    audit(db, ctx.actor, ctx.elevated, 'return', 'create', {
      return_code: returnCode, return_type, refund_amount: finalRefundAmount, quantity: qty,
      sale_code: sale.sale_code, item: item.item_name, out_of_window: outOfWindow
    });

    enqueueRow(db, 'warranty_returns', Number(result.lastInsertRowid));

    return getWarrantyReturnDetails(db, Number(result.lastInsertRowid));
  });
}

function listWarrantyReturns(db, { search = '', return_type = '' } = {}) {
  let query = `
    SELECT wr.*, s.sale_code
    FROM warranty_returns wr
    LEFT JOIN sales s ON wr.sale_id = s.id
    WHERE 1=1
  `;
  const params = [];

  if (return_type) {
    query += ' AND wr.return_type = ?';
    params.push(return_type);
  }

  if (search) {
    const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
    query += " AND (wr.return_code LIKE ? ESCAPE '\\' OR wr.customer_name LIKE ? ESCAPE '\\' OR wr.item_name LIKE ? ESCAPE '\\' OR COALESCE(s.sale_code, '') LIKE ? ESCAPE '\\')";
    const term = `%${esc(search)}%`;
    params.push(term, term, term, term);
  }

  // ponytail: RMAs grow forever; the 500 newest covers years of a busy shop.
  // Pagination if a shop ever needs to audit older claims.
  query += ' ORDER BY wr.id DESC LIMIT 500';
  return db.prepare(query).all(...params);
}

function getWarrantyReturnDetails(db, id) {
  const ret = db.prepare('SELECT * FROM warranty_returns WHERE id = ?').get(id);
  if (!ret) return null;
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(ret.sale_id);
  return { ...ret, sale };
}

module.exports = {
  createWarrantyReturn,
  listWarrantyReturns,
  getWarrantyReturnDetails
};
