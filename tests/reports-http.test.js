const assert = require('node:assert/strict');
const { serverTest } = require('./helper');
const { createInventoryItem } = require('../src/inventory');
const { createSale, voidSale } = require('../src/sales');
const { createWarrantyReturn } = require('../src/returns');

serverTest('Historical report HTTP routes reconcile losses and exceptions', async (base, db, auth) => {
  const part = createInventoryItem(db, { brand:'Probe', model_name:'Isolated', part_type:'LCD', cost_price:20, price_retail:100, stock_quantity:5 });
  const sale = createSale(db, { payment_method:'cash', items:[{ inventory_id:part.id, quantity:1, unit_price:100 }], amount_paid:100 });
  const ret = createWarrantyReturn(db, { sale_id:sale.id, sale_item_id:sale.items[0].id, return_type:'cash_refund', refund_amount:50 });
  db.prepare("UPDATE sales SET created_at=datetime('2024-01-14 12:00:00','utc') WHERE id=?").run(sale.id);
  db.prepare("UPDATE warranty_returns SET created_at=datetime('2024-01-15 12:00:00','utc') WHERE id=?").run(ret.id);
  const get = async url => {
    const res = await fetch(base + url, { headers:auth, signal:AbortSignal.timeout(5000) });
    const data = await res.json();
    assert.equal(res.status, 200, JSON.stringify(data));
    return data;
  };
  for (const period of ['day','3d','7d','30d','365d']) {
    const data = await get(`/api/dashboard?period=${period}&date=2024-01-15`);
    assert.equal(data.range.to,'2024-01-15');
    assert.equal(data.current.sale_count,period==='day'?0:1);
    assert.equal(data.current.net_profit,period==='day'?-50:30);
    assert.equal(data.trend.reduce((sum,t)=>sum+t.profit,0),data.current.net_profit);
  }
  const ex = await get('/api/exceptions?days=7&date=2024-01-15');
  assert.deepEqual(ex.range,{from:'2024-01-09',to:'2024-01-15'});
  assert.equal(ex.returns.length,1);
  assert.equal(ex.cashRefunds[0].id,ret.id);
  assert.equal((await get('/api/exceptions?days=1&date=2024-01-14')).returns.length,0);
  for (const url of ['/api/dashboard?period=7d&date=2024-02-30','/api/exceptions?days=366','/api/exceptions?days=7&date=bad']) {
    const res = await fetch(base+url,{headers:auth,signal:AbortSignal.timeout(5000)});
    assert.equal(res.ok,false,'invalid report inputs rejected');
    await res.text();
  }
  // A void is listed by when it happened, not the date the sale was made.
  const doomed = createSale(db,{payment_method:'cash',items:[{inventory_id:part.id,quantity:1,unit_price:100}],amount_paid:100});
  db.prepare("UPDATE sales SET created_at='2020-01-01T12:00:00Z' WHERE id=?").run(doomed.id);
  voidSale(db,doomed.id,'HTTP test',{actor:{type:'manager',name:'Test'},elevated:true});
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  assert.equal((await get(`/api/exceptions?days=1&date=${today}`)).voided[0].id,doomed.id);
  const { renderTrendChart } = await import('../public/js/chart.js');
  const host={innerHTML:''};
  renderTrendChart(host,[{label:'Jan 15',value:-50}],{title:'Profit after refunds'});
  const bar=host.innerHTML.match(/<rect[^>]*class="chart__bar"[^>]*>/)?.[0];
  assert.ok(Number(bar?.match(/height="([^"]+)"/)?.[1])>0,'loss draws below zero');
  assert.match(host.innerHTML,/Profit after refunds/);
});
