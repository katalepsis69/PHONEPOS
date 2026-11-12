// phone-repair-pos/src/analytics.js
const { money } = require('./money');
const { partLabel } = require('./inventory');
const { verifyChain } = require('./audit');
const { bucketsFor, closedPeriodAt } = require('./reconcile');
const { getShiftVarianceThreshold } = require('./settings');
const { foldSql } = require('./names');

// Shared buckets: every cash number on dashboard and shifts must agree. The
// rule lives in reconcile.bucketsFor, so the day close and the shift cannot drift.
function getExpectedCash(db, fromIso, toIso) {
  const from = fromIso || new Date(0).toISOString();
  const to = toIso || new Date().toISOString();
  return bucketsFor(db, 'datetime(created_at) >= datetime(?) AND datetime(created_at) <= datetime(?)', [from, to]).expected_cash;
}

// Standing (non-period) context: inventory footprint + utang book. Shared by
// the today report and the period dashboard so both surfaces always agree.
function getStandingStats(db) {
  const invStats = db.prepare(`
    SELECT
      COUNT(*) as total_items,
      COALESCE(SUM(stock_quantity), 0) as total_stock,
      COALESCE(SUM(stock_quantity * cost_price), 0.0) as total_inventory_cost_value,
      COALESCE(SUM(stock_quantity * price_retail), 0.0) as total_inventory_retail_value,
      COALESCE(SUM(CASE WHEN stock_quantity <= min_stock_alert THEN 1 ELSE 0 END), 0) as low_stock_count
    FROM inventory
  `).get();
  const creditStats = db.prepare(`
    SELECT
      COALESCE(SUM(credit_balance), 0.0) as total_outstanding_credit,
      COUNT(DISTINCT CASE WHEN credit_balance > 0.001 THEN ${foldSql(db, 'customer_name')} END) as total_debtors_count
    FROM sales WHERE voided = 0
  `).get();
  return {
    total_inventory_types: invStats.total_items,
    total_parts_stock: invStats.total_stock,
    total_inventory_cost_value: money(invStats.total_inventory_cost_value),
    total_inventory_retail_value: money(invStats.total_inventory_retail_value),
    low_stock_count: invStats.low_stock_count,
    total_credit_outstanding: money(creditStats.total_outstanding_credit),
    total_debtors_count: creditStats.total_debtors_count
  };
}

function getDashboardStats(db) {
  // 1. Standing context, shared with the period dashboard.
  const standing = getStandingStats(db);

  // 2. Sales Stats (Today) -- must NOT join sale_items: one row per sale, or every
  // SUM over sales gets multiplied by that sale's line-item count.
  // amount_paid stores the TENDERED amount; change returned to the customer is
  // not collected money, so every "collected" figure nets it out.
  // The ">= now - 2 days" predicates below look redundant next to the date()
  // equality -- they are not: they are what lets SQLite seek the
  // idx_*_created_at indexes instead of scanning the full history. Any row whose
  // LOCAL date is today necessarily has a UTC created_at within the last 48h
  // (local offsets are < 24h), so the range is always a superset and the date()
  // equality stays the sole semantic filter. Do not delete them.
  const todaySales = db.prepare(`
    SELECT
      COUNT(*) as sale_count,
      COALESCE(SUM(total_amount), 0.0) as revenue,
      COALESCE(SUM(amount_paid - change_amount), 0.0) as total_paid_at_counter,
      COALESCE(SUM(credit_balance), 0.0) as credit_issued_today,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount_paid - change_amount ELSE 0 END), 0.0) as cash_collected,
      COALESCE(SUM(CASE WHEN payment_method = 'gcash' THEN amount_paid - change_amount ELSE 0 END), 0.0) as gcash_collected,
      COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN amount_paid - change_amount ELSE 0 END), 0.0) as transfer_collected,
      -- A credit sale's amount_paid is the downpayment handed over at the
      -- counter. The POS records no method for it, so cash is the default;
      -- without this the drawer holds money no collections bucket explains.
      COALESCE(SUM(CASE WHEN payment_method = 'credit' THEN amount_paid ELSE 0 END), 0.0) as credit_downpayments
    FROM sales
    WHERE voided = 0 AND date(created_at,'localtime') = date('now','localtime')
      AND created_at >= datetime('now','-2 days')
  `).get();

  // 2b. Line-item split for today's sales (separate query, one row per line item)
  const todayItems = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN si.item_type = 'part' THEN si.quantity * si.unit_cost ELSE 0.0 END), 0.0) as cost,
      COALESCE(SUM(CASE WHEN si.item_type = 'part' THEN si.total_price ELSE 0.0 END), 0.0) as parts_revenue,
      COALESCE(SUM(CASE WHEN si.item_type = 'labor' THEN si.total_price ELSE 0.0 END), 0.0) as labor_revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND date(s.created_at,'localtime') = date('now','localtime')
      AND s.created_at >= datetime('now','-2 days')
  `).get();

  // 3. Credit (Utang) settlements (today) — outstanding lives in standing stats

  const todaySettlements = db.prepare(`
    SELECT 
      COALESCE(SUM(amount_paid), 0.0) as total_settled,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount_paid ELSE 0 END), 0.0) as cash_settled,
      COALESCE(SUM(CASE WHEN payment_method = 'gcash' THEN amount_paid ELSE 0 END), 0.0) as gcash_settled,
      COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN amount_paid ELSE 0 END), 0.0) as transfer_settled
    FROM credit_payments
    WHERE date(created_at,'localtime') = date('now','localtime')
      AND created_at >= datetime('now','-2 days')
  `).get();

  // 4. Warranty Returns (Today)
  const todayReturns = db.prepare(`
    SELECT 
      COUNT(wr.id) as total_returns_count,
      COALESCE(SUM(wr.refund_amount), 0.0) as total_refunded,
      COALESCE(SUM(CASE WHEN wr.return_type = 'cash_refund' THEN wr.refund_amount ELSE 0.0 END), 0.0) as cash_refunded,
      COALESCE(SUM(CASE WHEN wr.return_type = 'credit_refund' THEN wr.refund_amount ELSE 0.0 END), 0.0) as credit_refunded,
      COALESCE(SUM(CASE WHEN wr.return_type = 'replacement' AND COALESCE((SELECT voided FROM sales WHERE id = wr.sale_id), 0) = 0 THEN wr.quantity * COALESCE(i.cost_price, 0.0) ELSE 0.0 END), 0.0) as replacement_cost
    FROM warranty_returns wr
    LEFT JOIN inventory i ON i.id = wr.replacement_inventory_id
    WHERE date(wr.created_at,'localtime') = date('now','localtime')
      AND wr.created_at >= datetime('now','-2 days')
  `).get();

  // 5. Units received today (stock ledger): every 'receive' movement — manual
  // Adjust/Receive entries and CSV import top-ups. Answers "did today's
  // delivery actually get entered?" on the manager report. Same sargable
  // narrowing pattern as the queries above.
  const todayReceived = db.prepare(`
    SELECT COALESCE(SUM(delta), 0) as units_received
    FROM stock_movements
    WHERE reason = 'receive'
      AND date(created_at,'localtime') = date('now','localtime')
      AND created_at >= datetime('now','-2 days')
  `).get();

  const todayAdjustments = db.prepare(`
    SELECT COALESCE(SUM(ca.amount), 0.0) AS cash_adjusted
    FROM cash_adjustments ca
    WHERE date(ca.created_at,'localtime') = date('now','localtime')
      AND ca.created_at >= datetime('now','-2 days')
      AND NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE ca.source_kind = 'sale_void' AND s.id = ca.source_id
          AND date(s.created_at,'localtime') = date('now','localtime')
          AND s.created_at >= datetime('now','-2 days')
      )
  `).get();

  const todayExpenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0.0) AS expenses
    FROM expenses
    WHERE date(created_at,'localtime') = date('now','localtime')
      AND created_at >= datetime('now','-2 days')
  `).get();

  // Every query above is a bare aggregate with COALESCE: exactly one non-null row, always.
  const grossProfit = todaySales.revenue - todayItems.cost;
  const netProfit = grossProfit - todayReturns.total_refunded - todayReturns.replacement_cost - todayExpenses.expenses;
  const netRevenue = todaySales.revenue - todayReturns.total_refunded;
  // Credit downpayments join cash: they sit in the drawer the same day the
  // sale is rung up, so drawer reconciliation needs them in this bucket.
  const cashCollected = (todaySales.cash_collected + todaySales.credit_downpayments + todaySettlements.cash_settled + todayAdjustments.cash_adjusted) - todayReturns.cash_refunded;
  const gcashCollected = todaySales.gcash_collected + todaySettlements.gcash_settled;
  const transferCollected = todaySales.transfer_collected + todaySettlements.transfer_settled;
  const collectedTotal = (todaySales.total_paid_at_counter + todaySettlements.total_settled + todayAdjustments.cash_adjusted) - todayReturns.cash_refunded;

  return {
    ...standing,
    today_sales_count: todaySales.sale_count,
    today_sales_revenue: money(todaySales.revenue),
    today_net_revenue: money(netRevenue),
    today_parts_revenue: money(todayItems.parts_revenue),
    today_labor_revenue: money(todayItems.labor_revenue),
    today_gross_profit: money(grossProfit),
    today_sales_profit: money(netProfit),
    today_expenses: money(todayExpenses.expenses),
    today_cash_collected: money(cashCollected),
    today_gcash_collected: money(gcashCollected),
    today_transfer_collected: money(transferCollected),
    today_credit_settled: money(todaySettlements.total_settled),
    today_collected_total: money(collectedTotal),
    today_warranty_returns: todayReturns.total_returns_count,
    today_refunded_total: money(todayReturns.total_refunded),
    today_replacement_cost: money(todayReturns.replacement_cost),
    today_units_received: todayReceived.units_received
  };
}

/* ---------------------------------------------------------------
   Period analytics (Reports & profit tab)
   Trailing localtime calendar-day windows; the previous equal-length
   window rides along for delta arrows. 'day' may pin an explicit
   refDate (YYYY-MM-DD, from the daily date picker); trailing windows
   always end today. Windows reuse the sargable narrowing pattern
   documented at getDashboardStats: the raw UTC range is always a
   superset of the localdate window (offsets < 24h), the date()
   predicates stay the sole semantic filter, and idx_*_created_at
   still gets seeked instead of lifetime-scanned.
---------------------------------------------------------------- */
const PERIOD_DAYS = { day: 1, '3d': 3, '7d': 7, '30d': 30, '365d': 365 };

const localToday = (db) => db.prepare(`SELECT date('now','localtime') AS d`).get().d;
const addLocalDays = (db, dateStr, k) => db.prepare(`SELECT date(?, ?) AS d`).get(dateStr, `${k} days`).d;

function windowAnd(col, from, to) {
  return {
    sql: `date(${col},'localtime') >= ? AND date(${col},'localtime') <= ? AND ${col} >= datetime(?, '-1 day') AND ${col} < datetime(?, '+2 days')`,
    params: [from, to, from, to]
  };
}

function reportEndDate(db, refDate) {
  if (!refDate) return localToday(db);
  const parsed = new Date(`${refDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(refDate) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== refDate) {
    throw new Error('Invalid report date; use a real YYYY-MM-DD date');
  }
  return refDate;
}

function periodWindows(db, period, refDate, fromDate) {
  const today = reportEndDate(db, refDate);
  if (fromDate) {
    // Custom range: picked start to the picked end. The previous window stays
    // the equal-length stretch before it, so delta chips keep their baseline.
    const from = reportEndDate(db, fromDate);
    if (from > today) throw new Error('Custom start date must be on or before the end date');
    const n = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000) + 1;
    return {
      days: n,
      current: { from, to: today },
      previous: { from: addLocalDays(db, from, -n), to: addLocalDays(db, from, -1) }
    };
  }
  const n = PERIOD_DAYS[period];
  // Any period anchors to the picked end date; trailing-from-today is just
  // the default anchor. The previous window stays the equal-length stretch
  // before it, so delta chips keep their baseline.
  return {
    days: n,
    current: { from: addLocalDays(db, today, -(n - 1)), to: today },
    previous: { from: addLocalDays(db, today, -(2 * n - 1)), to: addLocalDays(db, today, -n) }
  };
}

// Same formulas as getDashboardStats, parameterized by window: one row per
// sale for sales sums, a separate pass for the line-item split (see the
// fan-out comment in getDashboardStats).
function windowKpis(db, w) {
  const W = windowAnd('created_at', w.from, w.to);
  const WI = windowAnd('s.created_at', w.from, w.to);
  const sales = db.prepare(`
    SELECT
      COUNT(*) AS sale_count,
      COALESCE(SUM(total_amount), 0.0) AS revenue,
      COALESCE(SUM(amount_paid - change_amount), 0.0) AS paid_at_counter,
      COALESCE(SUM(credit_balance), 0.0) AS credit_issued,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount_paid - change_amount ELSE 0 END), 0.0) AS cash_collected,
      COALESCE(SUM(CASE WHEN payment_method = 'gcash' THEN amount_paid - change_amount ELSE 0 END), 0.0) AS gcash_collected,
      COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN amount_paid - change_amount ELSE 0 END), 0.0) AS transfer_collected,
      COALESCE(SUM(CASE WHEN payment_method = 'credit' THEN amount_paid ELSE 0 END), 0.0) AS credit_downpayments
    FROM sales
    WHERE voided = 0 AND ${W.sql}
  `).get(...W.params);
  const items = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN si.item_type = 'part' THEN si.quantity * si.unit_cost ELSE 0.0 END), 0.0) AS cost,
      COALESCE(SUM(CASE WHEN si.item_type = 'part' THEN si.total_price ELSE 0.0 END), 0.0) AS parts_revenue,
      COALESCE(SUM(CASE WHEN si.item_type = 'labor' THEN si.total_price ELSE 0.0 END), 0.0) AS labor_revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND ${WI.sql}
  `).get(...WI.params);
  const settles = db.prepare(`
    SELECT
      COALESCE(SUM(amount_paid), 0.0) AS total,
      COALESCE(SUM(CASE WHEN payment_method = 'cash' THEN amount_paid ELSE 0 END), 0.0) AS cash,
      COALESCE(SUM(CASE WHEN payment_method = 'gcash' THEN amount_paid ELSE 0 END), 0.0) AS gcash,
      COALESCE(SUM(CASE WHEN payment_method = 'transfer' THEN amount_paid ELSE 0 END), 0.0) AS transfer
    FROM credit_payments
    WHERE ${W.sql}
  `).get(...W.params);
  const WR = windowAnd('wr.created_at', w.from, w.to);
  const returns = db.prepare(`
    SELECT
      COUNT(wr.id) AS count,
      COALESCE(SUM(wr.refund_amount), 0.0) AS refunded,
      COALESCE(SUM(CASE WHEN wr.return_type = 'cash_refund' THEN wr.refund_amount ELSE 0.0 END), 0.0) AS cash_refunded,
      COALESCE(SUM(CASE WHEN wr.return_type = 'credit_refund' THEN wr.refund_amount ELSE 0.0 END), 0.0) AS return_credit,
      COALESCE(SUM(CASE WHEN wr.return_type = 'replacement' THEN 1 ELSE 0 END), 0) AS return_replacements,
      COALESCE(SUM(CASE WHEN wr.return_type = 'replacement' AND COALESCE((SELECT voided FROM sales WHERE id = wr.sale_id), 0) = 0 THEN wr.quantity * COALESCE(i.cost_price, 0.0) ELSE 0.0 END), 0.0) AS replacement_cost
    FROM warranty_returns wr
    LEFT JOIN inventory i ON i.id = wr.replacement_inventory_id
    WHERE ${WR.sql}
  `).get(...WR.params);
  const WA = windowAnd('ca.created_at', w.from, w.to);
  const adjustments = db.prepare(`
    SELECT COALESCE(SUM(ca.amount), 0.0) AS cash_adjusted
    FROM cash_adjustments ca
    WHERE ${WA.sql}
      AND NOT EXISTS (
        SELECT 1 FROM sales s
        WHERE ca.source_kind = 'sale_void' AND s.id = ca.source_id AND ${WI.sql}
      )
  `).get(...WA.params, ...WI.params);
  // expenses.created_at is ISO like the other windows, so W applies directly.
  const expenses = db.prepare(`
    SELECT COALESCE(SUM(amount), 0.0) AS total
    FROM expenses
    WHERE ${W.sql}
  `).get(...W.params);

  const grossProfit = sales.revenue - items.cost;
  const netProfit = grossProfit - returns.refunded - returns.replacement_cost - expenses.total;
  const netRevenue = sales.revenue - returns.refunded;
  const cashCollected = (sales.cash_collected + sales.credit_downpayments + settles.cash + adjustments.cash_adjusted) - returns.cash_refunded;
  const gcashCollected = sales.gcash_collected + settles.gcash;
  const transferCollected = sales.transfer_collected + settles.transfer;
  const collectedTotal = (sales.paid_at_counter + settles.total + adjustments.cash_adjusted) - returns.cash_refunded;

  return {
    sale_count: sales.sale_count,
    revenue: money(sales.revenue),
    avg_ticket: money(sales.sale_count ? sales.revenue / sales.sale_count : 0),
    gross_profit: money(grossProfit),
    net_profit: money(netProfit),
    expenses_total: money(expenses.total),
    net_revenue: money(netRevenue),
    parts_revenue: money(items.parts_revenue),
    labor_revenue: money(items.labor_revenue),
    cash_collected: money(cashCollected),
    gcash_collected: money(gcashCollected),
    transfer_collected: money(transferCollected),
    credit_downpayments: money(sales.credit_downpayments),
    credit_issued: money(sales.credit_issued),
    credit_settled: money(settles.total),
    collected_total: money(collectedTotal),
    warranty_returns: returns.count,
    refunded_total: money(returns.refunded),
    return_cash: money(returns.cash_refunded),
    return_credit: money(returns.return_credit),
    return_replacements: returns.return_replacements,
    replacement_cost: money(returns.replacement_cost)
  };
}

function getPeriodStats(db, period = 'day', refDate = null, fromDate = null) {
  const p = PERIOD_DAYS[period] ? period : (fromDate ? 'custom' : 'day');
  const { days, current, previous } = periodWindows(db, p, refDate, fromDate);
  const cur = windowKpis(db, current);
  const prev = windowKpis(db, previous);
  const deltas = {};
  for (const k of Object.keys(cur)) {
    // prev === 0 → "no prior": a 0→X jump has no meaningful percentage, and
    // Infinity would render as "+Infinity%".
    deltas[k] = typeof cur[k] === 'number' && prev[k] !== 0
      ? Math.round(((cur[k] - prev[k]) / Math.abs(prev[k])) * 1000) / 10
      : null;
  }
  // Yearly views bucket per month, everything else per calendar day.
  const W = windowAnd('created_at', current.from, current.to);
  const WI = windowAnd('s.created_at', current.from, current.to);
  const bucketExpr = days >= 365
    ? `strftime('%Y-%m', created_at, 'localtime')`
    : `date(created_at, 'localtime')`;
  const bucketExprS = days >= 365
    ? `strftime('%Y-%m', s.created_at, 'localtime')`
    : `date(s.created_at, 'localtime')`;
  const trendRows = db.prepare(`
    SELECT ${bucketExpr} AS bucket, COUNT(*) AS count, COALESCE(SUM(total_amount), 0.0) AS revenue
    FROM sales
    WHERE voided = 0 AND ${W.sql}
    GROUP BY bucket ORDER BY bucket
  `).all(...W.params);
  // Per-bucket gross profit needs line-item costs (they live on sale_items),
  // so a second pass walks the same window — joining would multiply totals.
  const costs = new Map(db.prepare(`
    SELECT ${bucketExprS} AS bucket, COALESCE(SUM(si.quantity * si.unit_cost), 0.0) AS cost
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND si.item_type = 'part' AND ${WI.sql}
    GROUP BY bucket ORDER BY bucket
  `).all(...WI.params).map(r => [r.bucket, r.cost]));
  // Refunds land on the day they happened, not the sale's day — the truthful
  // cash story. Every type subtracts, matching net_profit in the KPIs above.
  const WR = windowAnd('wr.created_at', current.from, current.to);
  const bucketExprWR = days >= 365
    ? `strftime('%Y-%m', wr.created_at, 'localtime')`
    : `date(wr.created_at, 'localtime')`;
  const refunds = new Map(db.prepare(`
    SELECT ${bucketExprWR} AS bucket,
      COALESCE(SUM(wr.refund_amount + CASE WHEN wr.return_type = 'replacement' AND COALESCE((SELECT voided FROM sales WHERE id = wr.sale_id), 0) = 0 THEN wr.quantity * COALESCE(i.cost_price, 0.0) ELSE 0.0 END), 0.0) AS refunded
    FROM warranty_returns wr
    LEFT JOIN inventory i ON i.id = wr.replacement_inventory_id
    WHERE ${WR.sql}
    GROUP BY bucket ORDER BY bucket
  `).all(...WR.params).map(r => [r.bucket, r.refunded]));
  // Expenses share the sale bucket expression, so a rent-heavy day shows its
  // dip in the trend exactly where the KPI net_profit books it.
  const expByBucket = new Map(db.prepare(`
    SELECT ${bucketExpr} AS bucket, COALESCE(SUM(amount), 0.0) AS total
    FROM expenses WHERE ${W.sql}
    GROUP BY bucket ORDER BY bucket
  `).all(...W.params).map(r => [r.bucket, r.total]));
  const trendMap = new Map(trendRows.map(t => [t.bucket, t]));
  const trend = [...new Set([...trendMap.keys(), ...costs.keys(), ...refunds.keys(), ...expByBucket.keys()])].sort().map(b => {
    const t = trendMap.get(b) || { count: 0, revenue: 0.0 };
    return {
      bucket: b,
      count: t.count,
      revenue: money(t.revenue),
      profit: money(t.revenue - (costs.get(b) || 0) - (refunds.get(b) || 0) - (expByBucket.get(b) || 0))
    };
  });

  return { period: p, days, range: current, previous_range: previous, current: cur, previous: prev, deltas, trend };
}

// Top/bottom products by the window's sales. item_name is the snapshot taken
// at sale time (survives inventory edits/deletes); brand/model/part_type come
// from the live row when it still exists. unit_cost lives on the line item,
// so profit is exact even after a cost-price revision.
function getProductPerformance(db, period = '7d', refDate = null, fromDate = null) {
  const days = PERIOD_DAYS[period] || PERIOD_DAYS['7d'];
  const today = reportEndDate(db, refDate);
  const W = windowAnd('s.created_at', fromDate || addLocalDays(db, today, -(days - 1)), today);
  // ponytail: allocate the sale discount proportionally across parts AND labor.
  // Keep fractional cents until aggregation; zero-value sales allocate zero.
  const lineRefunds = 'COALESCE((SELECT SUM(wr.refund_amount) FROM warranty_returns wr WHERE wr.sale_item_id = si.id), 0.0)';
  const refundedUnits = "COALESCE((SELECT SUM(wr.quantity) FROM warranty_returns wr WHERE wr.sale_item_id = si.id AND wr.return_type != 'replacement'), 0)";
  const repCost = "COALESCE((SELECT SUM(wr.quantity * COALESCE(inv_rep.cost_price, 0.0)) FROM warranty_returns wr LEFT JOIN inventory inv_rep ON inv_rep.id = wr.replacement_inventory_id WHERE wr.sale_item_id = si.id AND wr.return_type = 'replacement'), 0.0)";

  const lineRevenue = 'CASE WHEN s.subtotal > 0 THEN si.total_price * (1.0 * s.total_amount / s.subtotal) ELSE 0.0 END';
  const lineNetRevenue = `MAX(0.0, (${lineRevenue}) - ${lineRefunds})`;
  const lineNetUnits = `MAX(0, si.quantity - ${refundedUnits})`;

  const products = db.prepare(`
    SELECT
      si.inventory_id AS id,
      MAX(si.item_name) AS item_name,
      i.brand, i.model_name, i.part_type,
      SUM(${lineNetUnits}) AS units,
      SUM(${lineNetRevenue}) AS revenue,
      SUM((${lineNetRevenue}) - (${lineNetUnits} * si.unit_cost) - ${repCost}) AS profit
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    LEFT JOIN inventory i ON i.id = si.inventory_id
    WHERE s.voided = 0 AND si.item_type = 'part' AND ${W.sql}
    GROUP BY si.inventory_id
    ORDER BY revenue DESC
  `).all(...W.params).map(r => ({
    ...r,
    revenue: money(r.revenue),
    profit: money(r.profit),
    margin_pct: r.revenue > 0 ? Math.round((r.profit / r.revenue) * 1000) / 10 : null
  }));
  const labor = db.prepare(`
    SELECT COALESCE(SUM(${lineNetUnits}), 0) AS units, COALESCE(SUM(${lineNetRevenue}), 0.0) AS revenue
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND si.item_type = 'labor' AND ${W.sql}
  `).get(...W.params);
  // Labor carries no cost line (unit_cost = 0), so its profit is its revenue.
  return {
    products,
    labor: { units: labor.units, revenue: money(labor.revenue), profit: money(labor.revenue) }
  };
}

// Dead stock: shelf money with zero sales in the window, ranked by tied-up
// capital (cost x stock). days_no_sale counts from the last non-voided sale,
// falling back to the item's own created_at for parts that never sold.
function getDeadStock(db, period = '30d', refDate = null, fromDate = null) {
  const days = PERIOD_DAYS[period] || PERIOD_DAYS['30d'];
  const today = reportEndDate(db, refDate);
  const W = windowAnd('s.created_at', fromDate || addLocalDays(db, today, -(days - 1)), today);
  const lastSold = new Map(db.prepare(`
    SELECT si.inventory_id AS id, MAX(date(s.created_at, 'localtime')) AS d
    FROM sale_items si
    JOIN sales s ON s.id = si.sale_id
    WHERE s.voided = 0 AND si.item_type = 'part' AND si.inventory_id IS NOT NULL
      AND date(s.created_at, 'localtime') <= ?
    GROUP BY si.inventory_id
  `).all(today).map(r => [r.id, r.d]));
  const rows = db.prepare(`
    SELECT i.id, i.brand, i.model_name, i.part_type, i.stock_quantity,
           (i.stock_quantity * i.cost_price) AS tied_up_capital,
           date(i.created_at, 'localtime') AS stocked_since
    FROM inventory i
    WHERE i.archived = 0 AND i.stock_quantity > 0
      AND i.id NOT IN (
        SELECT si.inventory_id FROM sale_items si
        JOIN sales s ON s.id = si.sale_id
        WHERE s.voided = 0 AND si.item_type = 'part' AND si.inventory_id IS NOT NULL AND ${W.sql}
      )
    ORDER BY tied_up_capital DESC
    LIMIT 20
  `).all(...W.params);
  return rows.map(r => {
    const last = lastSold.get(r.id) || r.stocked_since;
    const daysNoSale = Math.max(0, Math.round((Date.parse(today) - Date.parse(last)) / 86400000));
    return {
      id: r.id,
      name: partLabel(r),
      stock_quantity: r.stock_quantity,
      tied_up_capital: money(r.tied_up_capital),
      last_sold: lastSold.get(r.id) || null,
      days_no_sale: daysNoSale,
      age_band: daysNoSale >= 90 ? '90+' : daysNoSale >= 60 ? '60+' : daysNoSale >= 30 ? '30+' : '<30'
    };
  });
}

// Reorder view: min-stock breaches plus fast movers whose shelf cover at the
// window's velocity drops under 14 days. Zero velocity never triggers a
// reorder by itself: stock that never sells is dead stock, not a buy signal.
function getReorderList(db, period = '30d', refDate = null, fromDate = null) {
  const days = PERIOD_DAYS[period] || PERIOD_DAYS['30d'];
  const today = reportEndDate(db, refDate);
  const W = windowAnd('s.created_at', fromDate || addLocalDays(db, today, -(days - 1)), today);
  const rows = db.prepare(`
    SELECT i.id, i.brand, i.model_name, i.part_type,
           i.stock_quantity, i.min_stock_alert,
           COALESCE(v.units, 0) AS units_sold
    FROM inventory i
    LEFT JOIN (
      SELECT si.inventory_id AS id, SUM(si.quantity) AS units
      FROM sale_items si
      JOIN sales s ON s.id = si.sale_id
      WHERE s.voided = 0 AND si.item_type = 'part' AND si.inventory_id IS NOT NULL AND ${W.sql}
      GROUP BY si.inventory_id
    ) v ON v.id = i.id
    WHERE i.archived = 0
      AND (i.stock_quantity <= i.min_stock_alert OR v.units > 0)
  `).all(...W.params);
  return rows
    .map(r => ({
      id: r.id,
      name: partLabel(r),
      stock_quantity: r.stock_quantity,
      min_stock_alert: r.min_stock_alert,
      units_sold: r.units_sold,
      cover_days: r.units_sold > 0 ? Math.round((r.stock_quantity * days / r.units_sold) * 10) / 10 : null,
      below_min: r.stock_quantity <= r.min_stock_alert
    }))
    .filter(r => r.below_min || (r.cover_days !== null && r.cover_days < 14))
    .sort((a, b) => (b.below_min - a.below_min) || (a.stock_quantity - b.stock_quantity));
}

function getExceptions(db, days = 7, refDate = null) {
  const d = Number(days);
  if (!Number.isInteger(d) || d < 1 || d > 365) throw new Error('Report days must be an integer from 1 to 365');
  const to = reportEndDate(db, refDate);
  const range = { from: addLocalDays(db, to, -(d - 1)), to };
  const W = windowAnd('created_at', range.from, range.to);
  const voided = db.prepare(`
    SELECT s.id, s.sale_code, s.total_amount, s.created_at, s.void_reason, a.actor_name, a.created_at AS voided_at
    FROM sales s
    LEFT JOIN audit_log a ON a.category='sale' AND a.action='void' AND json_extract(a.detail,'$.sale_code') = s.sale_code
    WHERE s.voided = 1 AND date(COALESCE(a.created_at, s.created_at),'localtime') BETWEEN ? AND ?
    ORDER BY COALESCE(a.created_at, s.created_at) DESC
  `).all(range.from, range.to);
  const returns = db.prepare(`
    SELECT * FROM warranty_returns WHERE ${W.sql} ORDER BY id DESC
  `).all(...W.params);
  const discounts = db.prepare(`
    SELECT id, sale_code, subtotal, discount, total_amount, created_at
    FROM sales WHERE voided=0 AND discount >= 0.05*subtotal AND subtotal > 0 AND ${W.sql}
    ORDER BY id DESC
  `).all(...W.params);
  const shiftsWindow = windowAnd('closed_at', range.from, range.to);
  // The materiality line is a shop setting (default 50), not a constant.
  const varianceFloor = getShiftVarianceThreshold(db);
  const shifts = db.prepare(`
    SELECT * FROM shifts WHERE status='closed' AND ABS(variance) > ? AND ${shiftsWindow.sql}
    ORDER BY id DESC
  `).all(varianceFloor, ...shiftsWindow.params);
  // Neither stored number is rewritten, so the movement and the signed period
  // it undoes both have to appear or the drawer looks right twice.
  const afterClose = [];
  const saleDay = id => db.prepare('SELECT created_at, sale_code, payment_method, amount_paid, change_amount FROM sales WHERE id = ?').get(id);
  for (const v of voided) {
    const closed = closedPeriodAt(db, v.created_at);
    if (!closed) continue;
    // A void that predates the sign-off needed no adjustment at the time and
    // got none; listing it as a signed-period exception is pure noise.
    if (v.voided_at && closed.signed_at && v.voided_at <= closed.signed_at) continue;
    const adj = db.prepare("SELECT amount FROM cash_adjustments WHERE source_kind = 'sale_void' AND source_id = ? ORDER BY id DESC").get(v.id);
    afterClose.push({
      kind: 'void', ref: v.sale_code, when: v.voided_at || v.created_at,
      signed_period: closed.label, signed_kind: closed.kind, signed_by: closed.closed_by,
      cash_out: adj ? money(Math.abs(adj.amount)) : 0
    });
  }
  for (const r of returns) {
    const src = r.sale_id ? saleDay(r.sale_id) : null;
    const closed = src && closedPeriodAt(db, src.created_at);
    if (!closed) continue;
    afterClose.push({
      kind: r.return_type, ref: r.return_code, when: r.created_at,
      signed_period: closed.label, signed_kind: closed.kind, signed_by: closed.closed_by,
      cash_out: r.return_type === 'cash_refund' ? money(r.refund_amount || 0) : 0
    });
  }
  // Never fail open: if verification itself throws, "unknown" must reach the
  // client so it does not render as a clean chain.
  let auditChain = { ok: 'unknown', first_bad_id: null };
  try { auditChain = verifyChain(db); } catch (_) {}
  // Keep the old response field for existing consumers.
  return { range, voided, returns, cashRefunds: returns.filter(r => r.return_type === 'cash_refund'), discounts, shifts, afterClose, auditChain };
}

module.exports = {
  getDashboardStats,
  getExpectedCash,
  getExceptions,
  getStandingStats,
  getPeriodStats,
  getProductPerformance,
  getDeadStock,
  getReorderList
};
