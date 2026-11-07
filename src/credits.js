// phone-repair-pos/src/credits.js
const { money } = require('./money');
const { audit, txn } = require('./audit');
const { enqueueRow, enqueueCustomerProfile } = require('./sync');
const { cleanName: normalizeName, foldName, foldSql } = require('./names');

function listCustomers(db, { search = '', filter = '', limit = 2000 } = {}) {
  const capped = Math.min(5000, Math.max(1, Number(limit) || 2000));
  // ponytail: push search + filter into SQL so we never materialize 5k rows
  // then discard 90% in JS. s.customer_name has index idx_sales_customer.
  const where = ['s.voided = 0'];
  const params = [];
  if (search) {
    const esc = s => s.replace(/[\\%_]/g, m => '\\' + m);
    const term = `%${esc(search.trim())}%`;
    where.push("(s.customer_name LIKE ? ESCAPE '\\' OR COALESCE(s.customer_phone,'') LIKE ? ESCAPE '\\')");
    params.push(term, term);
  }
  let having = '';
  if (filter === 'credit') having = ' HAVING COALESCE(SUM(s.credit_balance),0) > 0.001';
  else if (filter === 'clean') having = ' HAVING COALESCE(SUM(s.credit_balance),0) <= 0.001';

  // Unicode-aware folding, not COLLATE NOCASE: SQLite folds ASCII only, so
  // 'Muñoz' and 'MUÑOZ' grouped as two debtors and the profile join missed.
  const fold = expr => foldSql(db, expr);
  const query = `
    SELECT
      -- Grouping is case-insensitive, so the label has to be chosen, not left
      -- to whichever row SQLite happened to see first: a bare column here would
      -- let the same debtor display as "John Doe" one day and "JOHN DOE" next.
      MIN(s.customer_name) AS customer_name,
      MAX(s.customer_phone) as customer_phone,
      COUNT(DISTINCT s.id) as sales_count,
      COALESCE(SUM(s.total_amount), 0.0) as total_purchases,
      COALESCE(SUM(s.amount_paid - s.change_amount), 0.0) + COALESCE(p.total_settled, 0.0) - COALESCE(r.total_cash_refunded, 0.0) as total_spent_paid,
      COALESCE(SUM(s.credit_balance), 0.0) as total_credit_balance,
      MAX(s.created_at) as last_order_date,
      MIN(CASE WHEN s.credit_balance > 0.001 THEN s.created_at ELSE NULL END) as credit_date,
      COALESCE(cp.credit_limit, 0.0) as credit_limit,
      COALESCE(r.returns_count, 0) as returns_count,
      COALESCE(r.total_refunded, 0.0) as total_refunded
    FROM sales s
    LEFT JOIN (
      SELECT ${fold('customer_name')} AS name_key, COALESCE(SUM(amount_paid), 0.0) as total_settled
      FROM credit_payments GROUP BY name_key
    ) p ON ${fold('s.customer_name')} = p.name_key
    LEFT JOIN (
      SELECT ${fold('customer_name')} AS name_key,
        COUNT(*) as returns_count,
        COALESCE(SUM(refund_amount), 0.0) as total_refunded,
        COALESCE(SUM(CASE WHEN return_type = 'cash_refund' THEN refund_amount ELSE 0 END), 0.0) as total_cash_refunded
      FROM warranty_returns GROUP BY name_key
    ) r ON ${fold('s.customer_name')} = r.name_key
    -- One profile row per folded name even when history left a case-variant
    -- duplicate behind; the list only shows the limit, so the max wins.
    LEFT JOIN (
      SELECT ${fold('customer_name')} AS name_key, MAX(credit_limit) AS credit_limit
      FROM customer_profiles GROUP BY name_key
    ) cp ON ${fold('s.customer_name')} = cp.name_key
    WHERE ${where.join(' AND ')}
    GROUP BY ${fold('s.customer_name')}${having}
    ORDER BY total_credit_balance DESC, s.customer_name ASC
    LIMIT ?
  `;
  params.push(capped);
  return db.prepare(query).all(...params).map(c => {
    const bal = money(Math.max(0, c.total_credit_balance));
    return {
      customer_name: c.customer_name,
      customer_phone: c.customer_phone || '',
      sales_count: c.sales_count,
      total_purchases: money(c.total_purchases),
      total_spent_paid: money(Math.max(0, c.total_spent_paid)),
      total_credit_balance: bal,
      credit_limit: money(c.credit_limit || 0),
      returns_count: c.returns_count || 0,
      total_refunded: money(c.total_refunded || 0),
      last_order_date: c.last_order_date || null,
      credit_date: c.credit_date || c.last_order_date || null,
      status: bal > 0.001 ? 'active_credit' : 'clean'
    };
  });
}

function getCustomerDetails(db, customerName) {
  const cleanName = normalizeName(customerName, 'Walk-in Customer');
  const folded = foldName(cleanName);
  const fold = expr => foldSql(db, expr);
  // ponytail: one JOIN replaces N+1 item queries. sales+payments aggregated in SQL.
  const sales = db.prepare(`SELECT * FROM sales WHERE ${fold('customer_name')} = ? ORDER BY id DESC`).all(folded);
  if (sales.length) {
    const byId = new Map(sales.map(s => [s.id, s]));
    for (const s of sales) s.items = [];
    const ids = sales.map(s => s.id);
    const placeholders = ids.map(() => '?').join(',');
    for (const row of db.prepare(`SELECT * FROM sale_items WHERE sale_id IN (${placeholders}) ORDER BY sale_id`).all(...ids)) {
      byId.get(row.sale_id)?.items.push(row);
    }
  }
  const payments = db.prepare(`SELECT * FROM credit_payments WHERE ${fold('customer_name')} = ? ORDER BY id DESC`).all(folded);
  const returns = db.prepare(`
    SELECT wr.*, s.sale_code, s.voided AS sale_voided
    FROM warranty_returns wr
    JOIN sales s ON wr.sale_id = s.id
    WHERE ${fold('wr.customer_name')} = ?
    ORDER BY wr.id DESC
  `).all(folded);

  const returnsBySaleId = new Map();
  for (const r of returns) {
    if (!returnsBySaleId.has(r.sale_id)) returnsBySaleId.set(r.sale_id, []);
    returnsBySaleId.get(r.sale_id).push(r);
  }
  for (const s of sales) {
    const sReturns = returnsBySaleId.get(s.id) || [];
    s.rma_count = sReturns.length;
    s.refunded_amount = money(sReturns.reduce((sum, r) => sum + Number(r.refund_amount || 0), 0));
    s.returns = sReturns;
  }

  // SQL-side totals avoid three full scans in JS; voided excluded there
  const agg = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN voided=0 THEN total_amount ELSE 0 END),0) as purch,
      COALESCE(SUM(CASE WHEN voided=0 THEN amount_paid - change_amount ELSE 0 END),0) as salesPaid,
      COALESCE(SUM(CASE WHEN voided=0 THEN credit_balance ELSE 0 END),0) as bal,
      COUNT(CASE WHEN voided=0 THEN 1 END) as cnt,
      MAX(customer_phone) as phone
    FROM sales WHERE ${fold('customer_name')} = ?
  `).get(folded);
  const totalSettlements = payments.reduce((s, p) => s + p.amount_paid, 0);
  const cashRefunded = returns.filter(r => r.return_type === 'cash_refund' && !r.sale_voided).reduce((s, r) => s + Number(r.refund_amount || 0), 0);
  // The newest profile row wins when history left a case-variant duplicate.
  const prof = db.prepare(`SELECT credit_limit, notes FROM customer_profiles WHERE ${fold('customer_name')} = ? ORDER BY updated_at DESC, rowid DESC LIMIT 1`).get(folded);
  return {
    customer_name: cleanName,
    customer_phone: agg.phone || '',
    sales_count: agg.cnt,
    total_purchases: money(agg.purch),
    total_spent_paid: money(Math.max(0, agg.salesPaid + totalSettlements - cashRefunded)),
    total_credit_balance: money(agg.bal),
    credit_limit: money(prof?.credit_limit || 0),
    returns_count: returns.length,
    total_refunded: money(returns.reduce((sum, r) => sum + Number(r.refund_amount || 0), 0)),
    notes: prof?.notes || '',
    status: agg.bal > 0.001 ? 'active_credit' : 'clean',
    sales,
    payments,
    returns
  };
}

// Same rule sales.js applies: a typo'd method is collected money that no
// dashboard bucket ever reports, so reject it at the boundary.
const SETTLE_METHODS = ['cash', 'gcash', 'transfer'];

function settleCustomerCredit(db, {
  customer_name,
  amount_paid,
  payment_method = 'cash',
  payment_reference = '',
  notes = '',
  op_id = null
}, ctx = {}) {
  const cleanName = normalizeName(customer_name);
  if (!cleanName) throw new Error('Customer name is required to settle credit');
  // Idempotency: a client op_id replays as the original payment (same shape a
  // timeout retry needs). Sales have had this since the start; settlements
  // were the last money path without it.
  const opId = String(op_id || '').trim() || null;
  if (opId && opId.length > 64) throw new Error('op_id too long');
  if (opId) {
    const existing = db.prepare('SELECT id FROM credit_payments WHERE op_id = ?').get(opId);
    if (existing) return getCustomerDetails(db, cleanName);
  }
  if (!SETTLE_METHODS.includes(payment_method)) {
    throw new Error(`Invalid payment method: ${payment_method}. Must be one of ${SETTLE_METHODS.join(', ')}`);
  }

  const amount = money(amount_paid);
  if (amount <= 0) {
    throw new Error('Valid payment amount is required');
  }
  // A gcash or transfer collection moves no cash through the drawer, so the
  // ref number is the only trace that can be checked afterwards.
  const ref = String(payment_reference || '').trim();
  if (payment_method !== 'cash' && !ref) {
    throw new Error(`A ref # is required for ${payment_method} settlements so the collection can be checked`);
  }

  const openSales = db.prepare(`
    SELECT id, credit_balance FROM sales 
    WHERE ${foldSql(db, 'customer_name')} = ? AND payment_method = 'credit' AND credit_balance > 0 AND voided = 0
    ORDER BY id ASC
  `).all(foldName(cleanName));

  const totalOutstanding = money(openSales.reduce((sum, s) => sum + s.credit_balance, 0));
  if (totalOutstanding <= 0) {
    throw new Error(`Customer '${cleanName}' has no outstanding credit to settle`);
  }

  if (amount > totalOutstanding) {
    throw new Error(`Payment amount (₱${amount.toFixed(2)}) exceeds total outstanding credit (₱${totalOutstanding.toFixed(2)})`);
  }

  return txn(db, () => {
    // 1. Insert credit payment record with ISO timestamp
    const stmt = db.prepare(`
      INSERT INTO credit_payments (customer_name, amount_paid, payment_method, payment_reference, notes, created_at, op_id)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    const payRes = stmt.run(cleanName, amount, payment_method, ref, (notes || '').trim().slice(0, 500), new Date().toISOString(), opId);
    enqueueRow(db, 'credit_payments', Number(payRes.lastInsertRowid));

    // 2. Reduce open debts FIFO (oldest open sale first)
    let remainingToSettle = amount;
    const updateSaleStmt = db.prepare('UPDATE sales SET credit_balance = ? WHERE id = ?');

    for (const sale of openSales) {
      if (remainingToSettle <= 0) break;
      const deduct = money(Math.min(remainingToSettle, sale.credit_balance));
      const newBalance = money(Math.max(0, sale.credit_balance - deduct));
      updateSaleStmt.run(newBalance, sale.id);
      enqueueRow(db, 'sales', sale.id); // balance changed: cloud must see it
      remainingToSettle = money(remainingToSettle - deduct);
    }

    audit(db, ctx.actor, ctx.elevated, 'credit', 'settle', {
      customer: cleanName, amount, method: payment_method,
      outstanding_before: totalOutstanding, outstanding_after: money(totalOutstanding - amount)
    });

    return getCustomerDetails(db, cleanName);
  });
}

function setCustomerCreditLimit(db, customerName, creditLimit, notes = '', ctx = {}) {
  const cleanName = normalizeName(customerName);
  if (!cleanName || cleanName.toLowerCase() === 'walk-in customer') {
    throw new Error('Valid customer name is required to set credit limit');
  }
  const limit = money(creditLimit);
  if (limit < 0) throw new Error('Credit limit cannot be negative');

  return txn(db, () => {
    // A case-variant duplicate ('Muñoz' vs 'MUÑOZ') cannot conflict under
    // NOCASE, so it would insert a second profile row and every read would have
    // to choose between them. Collapse those rows onto the spelling being saved.
    db.prepare(`DELETE FROM customer_profiles WHERE ${foldSql(db, 'customer_name')} = ? AND customer_name <> ?`)
      .run(foldName(cleanName), cleanName);
    db.prepare(`
      INSERT INTO customer_profiles (customer_name, credit_limit, notes, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(customer_name) DO UPDATE SET
        credit_limit = excluded.credit_limit,
        notes = CASE WHEN excluded.notes != '' THEN excluded.notes ELSE customer_profiles.notes END,
        updated_at = CURRENT_TIMESTAMP
    `).run(cleanName, limit, (notes || '').trim().slice(0, 500));
    // Credit limits drive the manager app's utang view; the profile row rides
    // the same commit (notes never leave the shop, see sync.js).
    enqueueCustomerProfile(db, cleanName);

    audit(db, ctx.actor, ctx.elevated, 'credit', 'set_limit', {
      customer: cleanName,
      credit_limit: limit
    });
    return { customer_name: cleanName, credit_limit: limit };
  });
}

// Reads treat the spellings as one debtor already; this is the review list
// where a shop spots two different people sharing a name. The key is folded
// Unicode-aware (TRIM then namefold), so a name re-cased with a diacritic
// surfaces here instead of hiding behind lower(), which folds ASCII only.
function listCustomerNameVariants(db) {
  return db.prepare(`
    WITH per_spelling AS (
      SELECT ${foldSql(db, 'TRIM(customer_name)')} AS key, customer_name AS name,
             SUM(CASE WHEN voided = 0 THEN credit_balance ELSE 0 END) AS debt,
             COUNT(*) AS orders
      FROM sales
      WHERE customer_name != ''
      GROUP BY name
    )
    SELECT key, COUNT(*) AS spellings, GROUP_CONCAT(name, ' ; ') AS variants,
           SUM(debt) AS debt, SUM(orders) AS orders
    FROM per_spelling GROUP BY key HAVING COUNT(*) > 1 ORDER BY debt DESC, key ASC
  `).all().map(r => ({
    key: r.key,
    spellings: r.spellings,
    variants: String(r.variants || '').split(' ; '),
    debt: money(r.debt || 0),
    orders: r.orders
  }));
}

module.exports = {
  listCustomers,
  listCustomerNameVariants,
  getCustomerDetails,
  settleCustomerCredit,
  setCustomerCreditLimit
};
