// phone-repair-pos/tests/audit-regressions.test.js
// Regression checks for the bug-audit findings: Top Parts discount profit,
// zero-stock reorder, in-flight checkout lock, confirmation cancellation on
// backdrop dismissal, and the top-parts expand toggle wiring.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { initDb } = require('../src/db');
const { createInventoryItem } = require('../src/inventory');
const { createSale } = require('../src/sales');
const { getPeriodStats, getProductPerformance, getReorderList } = require('../src/analytics');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

test('a discounted single-item sale shows the same loss in totals and top parts', () => {
  const db = initDb(':memory:');
  try {
    const part = createInventoryItem(db, {
      brand: 'Audit', model_name: 'Discount check', part_type: 'LCD',
      cost_price: 80, price_retail: 100, stock_quantity: 2
    });
    createSale(db, {
      payment_method: 'cash',
      items: [{ inventory_id: part.id, quantity: 1, unit_price: 100 }],
      discount: 40, amount_paid: 60
    });
    const totals = getPeriodStats(db, 'day').current;
    const ranked = getProductPerformance(db, 'day').products.find(p => p.id === part.id);
    assert.equal(totals.gross_profit, -20);
    assert.equal(ranked.profit, totals.gross_profit);
    assert.equal(ranked.revenue, 60);
  } finally {
    db.close();
  }
});

test('reorder includes a zero-stock part below minimum', () => {
  const db = initDb(':memory:');
  try {
    const item = createInventoryItem(db, {
      brand: 'Audit', model_name: 'Out of stock', part_type: 'Battery',
      stock_quantity: 0, min_stock_alert: 3, cost_price: 10, price_retail: 20
    });
    assert.ok(getReorderList(db, '7d').some(r => r.id === item.id));
  } finally {
    db.close();
  }
});

test('new repair must not clear a cart during an in-flight sale', async () => {
  const src = read('public/js/main.js');
  const code = src.slice(src.indexOf('export async function startNewSale()'), src.indexOf('// Top-bar search'));
  let resets = 0;
  const S = { saleInFlight: true, cart: [{ id: 1, qty: 1 }] };
  const ctx = vm.createContext({ S, confirmModal: async () => true, resetRepairCounter() { resets++; S.cart = []; }, switchTab() {}, document: { getElementById: () => null } });
  vm.runInContext(code.replace('export ', ''), ctx);
  await ctx.startNewSale();
  assert.equal(resets, 0);
  assert.equal(S.cart.length, 1);
});

test('backdrop dismissal of the confirmation dialog resolves cancellation', () => {
  const src = read('public/js/ui.js');
  const code = src.slice(src.indexOf('export function closeModal('), src.indexOf('// The id of the topmost'));
  let settled = 'pending';
  const S = { modalStack: [{ id: 'modal-confirm', prevFocus: null }], confirmResolveFn(v) { settled = v; } };
  // closeModal() now also retires the receipt modal's declared print slip (it is
  // receipts.js's state, not ui.js's), so the slice needs that collaborator.
  const ctx = vm.createContext({ S, syncAppInert() {}, clearModalSlip() {}, document: { getElementById: () => ({ classList: { add() {} } }) } });
  vm.runInContext(code.replace('export ', ''), ctx);
  ctx.closeModal('modal-confirm');
  assert.equal(settled, false);
});

test('top-parts "show all" toggle is wired to the panel that contains the button', () => {
  const src = read('public/js/views/backoffice.js');
  const code = src.slice(src.indexOf('function wireDashboardControls()'), src.indexOf('export async function loadDashboardData('));
  const handlers = new Map();
  const ctx = vm.createContext({ dashState: { wired: false }, $id: id => ({ addEventListener: (type, fn) => handlers.set(id, fn) }) });
  vm.runInContext(code, ctx);
  ctx.wireDashboardControls();
  assert.ok(handlers.has('dash-top-products'), 'listener sits on the product panel, not the toolbar');
});
