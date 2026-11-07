const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../public/js/views/backoffice.js'), 'utf8');

function context(extra = {}) {
  const elements = new Map();
  const $id = id => {
    if (!elements.has(id)) elements.set(id, { textContent:'', innerHTML:'', value:'', classList:{remove(){},toggle(){}}, setAttribute(){} });
    return elements.get(id);
  };
  return { elements, ctx:vm.createContext({
    $id, document:{getElementById:$id,querySelectorAll:()=>[]},
    dashState:{period:'7d',date:'2024-01-15',trendMode:'profit'},
    S:{currentTab:'dashboard'}, lastDash:null, dashboardRequest:0, exceptionsRequest:0,
    PERIOD_DAYS:{day:1,'7d':7}, URLSearchParams,
    hasElevation:()=>true, wireDashboardControls(){}, syncPeriodUi(){},
    renderDashboard(){}, showToast(){}, console,
    fmtMoney:n=>Number(n).toFixed(2), escHtml:s=>String(s),
    windowLabel:()=> 'Jan 9–15', deltaTag(){}, renderTrend(){},
    renderTopProducts(){},renderDeadStock(){},renderReorder(){},
    ...extra
  }) };
}
function evaluate(ctx, start, end) {
  const code = source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  assert.ok(code.length > 0);
  vm.runInContext(code.replace(/export /g,''),ctx);
}

test('dashboard and exceptions requests send the chosen multi-day end date', async () => {
  const urls=[];
  const {ctx,elements}=context({fetch:async url=>{
    urls.push(url);
    return {ok:true,status:200,json:async()=>url.startsWith('/api/dashboard')
      ? {period:'7d',range:{from:'2024-01-09',to:'2024-01-15'}}
      : {range:{from:'2024-01-09',to:'2024-01-15'},returns:[{return_code:'RMA-1',return_type:'credit_refund',refund_amount:50}],auditChain:{ok:true}}};
  }});
  evaluate(ctx,'export async function loadExceptions(', '// DASHBOARD & REPORTS LOGIC');
  evaluate(ctx,'export async function loadDashboardData(', 'export async function triggerBackup(');
  await ctx.loadDashboardData();
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(new URLSearchParams(urls[0].split('?')[1]).get('date'),'2024-01-15');
  assert.equal(new URLSearchParams(urls[1].split('?')[1]).get('date'),'2024-01-15');
  assert.match(elements.get('exceptions-panel').innerHTML,/RMA-1 utang 50.00/);
  assert.match(elements.get('dash-exceptions-hint').textContent,/2024-01-09 to 2024-01-15/);
});

test('collection shares use three disjoint methods, settlements informational only', () => {
  const {ctx,elements}=context();
  evaluate(ctx,'function renderDashboard(s)', 'function renderTrend(s)');
  const c={revenue:100,sale_count:1,avg_ticket:100,gross_profit:80,net_profit:60,
    cash_collected:50,gcash_collected:50,transfer_collected:0,credit_settled:50,
    collected_total:100,warranty_returns:2,return_cash:20,return_credit:30,return_replacements:0};
  const data={current:c,standing:{},deltas:{},dead_stock:[],reorder:[]};
  ctx.renderDashboard(data);
  const html=elements.get('dash-pmix').innerHTML;
  assert.equal((html.match(/class="pmix"/g)||[]).length,3);
  assert.equal((html.match(/50.00 · 50%/g)||[]).length,2);
  assert.match(html,/Includes 50.00 in utang settlements/);
  assert.match(elements.get('dash-sales-meta').textContent,/20.00 cash refunded · 30.00 off utang/);
  c.cash_collected=-20;
  ctx.renderDashboard(data);
  assert.doesNotMatch(elements.get('dash-pmix').innerHTML,/<strong>[^<]*%/);
  assert.match(elements.get('dash-pmix').innerHTML,/Shares omitted/);
});

test('profit toggle forwards negative profit and truthful series name', () => {
  let captured;
  const {ctx,elements}=context({fday:v=>v,fmonth:v=>v,renderTrendChart:(host,series,options)=>{captured={series,options};}});
  evaluate(ctx,'function renderTrend(s)', 'function renderTopProducts(');
  ctx.renderTrend({days:7,period:'7d',trend:[{bucket:'2024-01-15',revenue:0,profit:-50,count:0}]});
  assert.equal(captured.series[0].value,-50);
  assert.equal(captured.options.title,'Profit after refunds');
  assert.match(elements.get('dash-trend-hint').textContent,/return date/);
  ctx.dashState.trendMode='revenue';
  ctx.renderTrend({days:7,period:'7d',trend:[{bucket:'2024-01-15',revenue:0,profit:-50,count:0}]});
  assert.equal(captured.series[0].value,0);
});

test('silent dashboard poll updates KPIs and freshness chip without re-fetching exceptions or day-close', async () => {
  const urls = [];
  let shouldFail = false;
  const { ctx, elements } = context({
    fetch: async url => {
      urls.push(url);
      if (shouldFail) return { ok: false, status: 500 };
      return {
        ok: true,
        status: 200,
        json: async () => ({ period: 'day', range: { from: '2024-01-15', to: '2024-01-15' } })
      };
    }
  });
  evaluate(ctx, 'export async function loadExceptions(', '// DASHBOARD & REPORTS LOGIC');
  evaluate(ctx, 'export async function loadDashboardData(', 'export async function triggerBackup(');

  await ctx.loadDashboardData({ silent: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(urls.length, 1, 'silent poll only fetches /api/dashboard');
  assert.match(urls[0], /^\/api\/dashboard\?/);
  assert.match(elements.get('dash-freshness').textContent, /^Live · /);
  assert.match(elements.get('dash-freshness').className, /tag--pos/);

  shouldFail = true;
  await ctx.loadDashboardData({ silent: true });
  assert.match(elements.get('dash-freshness').textContent, /^Stale · /);
  assert.match(elements.get('dash-freshness').className, /tag--warn/);
});
