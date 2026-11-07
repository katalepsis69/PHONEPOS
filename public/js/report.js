// phone-repair-pos/public/js/report.js
// Manager phone report PWA logic. Served as an external file so the
// CSP mirror (script-src no unsafe-inline) holds on report.html too.
// Manager phone reports: read-only companion to the counter.
// Auth: Bearer token from /api/report/login (manager PIN), kept in
// sessionStorage so closing the tab signs the manager out. Server-side
// expiry and PIN-change revocation remain authoritative.
(function () {
  'use strict';
  var TOKEN_KEY = 'report_token';
  var THEME_KEY = 'report_theme';
  var POLL_MS = 20000;
  var STALE_MAX_MS = 300000;
  var pollTimer = null;
  var token = '';
  var lastOkAt = 0;

  var $ = function (id) { return document.getElementById(id); };

  function applyTheme(mode) {
    var html = document.documentElement;
    if (!html || !html.classList) return;
    if (mode === 'light') {
      html.classList.remove('dark');
      html.classList.add('light');
    } else {
      html.classList.remove('light');
      html.classList.add('dark');
    }
  }
  try {
    var savedTheme = localStorage.getItem(THEME_KEY);
    if (savedTheme === 'light' || savedTheme === 'dark') applyTheme(savedTheme);
  } catch (_) {}
  var themeBtn = $('btn-theme-toggle');
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var html = document.documentElement;
      var next = (html && html.classList && html.classList.contains('dark')) ? 'light' : 'dark';
      applyTheme(next);
      try { localStorage.setItem(THEME_KEY, next); } catch (_) {}
    });
  }

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtMoney(n) {
    return '\u20B1' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTime(iso) {
    var d = iso ? new Date(iso) : new Date();
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
  function fmtSaleTime(iso) {
    var d = new Date(iso);
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function show(view) {
    ['view-login', 'view-report', 'view-license'].forEach(function (id) {
      $(id).hidden = (id !== view);
    });
  }

  /* ---------- login ---------- */

  function loginError(msg) {
    var el = $('login-error');
    if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
  }

  async function doLogin(pin) {
    var btn = $('login-btn');
    btn.disabled = true;
    loginError('');
    try {
      var res = await fetch('/api/report/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: pin })
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 402) { showLicense(data.error, data.machine_id); return; }
      if (!res.ok) { loginError(data.error || 'Login failed (' + res.status + ')'); return; } // e.g. PIN lockout
      if (data.valid === false || !data.token) { loginError('Incorrect PIN.'); return; }
      token = data.token;
      try { sessionStorage.setItem(TOKEN_KEY, token); } catch (_) {}
      $('pin-input').value = '';
      enterReport();
    } catch (_) {
      loginError('Cannot reach the shop server. Check the connection and try again.');
    } finally {
      btn.disabled = false;
    }
  }

  $('login-form').addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = $('pin-input').value.trim();
    if (!pin) { loginError('Enter the manager PIN.'); return; }
    doLogin(pin);
  });

  /* ---------- data view ---------- */

  function enterReport() {
    show('view-report');
    startPolling();
    refresh();
  }

  function signOut() {
    stopPolling();
    token = '';
    lastOkAt = 0;
    refreshGen++; // any in-flight response can no longer render stale figures
    try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) {}
    setOnline(true);
    // Old figures must not survive into the next manager's session: the
    // login view would sit on top of someone else's numbers.
    ['st-revenue', 'st-count', 'st-profit', 'st-split', 'st-credit', 'st-debtors',
     'st-lowstock', 'st-returns', 'st-received', 'st-refunded', 'st-cash',
     'st-gcash', 'st-transfer', 'st-settled'].forEach(function (id) {
      var el = $(id);
      if (el) el.textContent = '\u2212';
    });
    if ($('st-refunded-meta')) $('st-refunded-meta').textContent = 'cash + credit refunds';
    $('sales-list').innerHTML = '';
    $('last-updated').textContent = '';
    show('view-login');
    $('pin-input').focus();
  }

  $('btn-signout').addEventListener('click', signOut);

  function setFreshness(state) {
    var pill = $('status-pill');
    var label = state === 'live' ? 'Live' : (state === 'stale' ? 'Stale' : 'Offline');
    pill.dataset.state = state;
    pill.innerHTML = '<span class="rpt-pill__dot"></span>' + label;
    $('offline-banner').hidden = (state !== 'offline');
    if (state === 'live') {
      $('last-updated').style.color = '';
    } else if (state === 'stale') {
      $('last-updated').style.color = 'var(--warn)';
      if (lastOkAt) $('last-updated').textContent = 'Stale \u00B7 last ' + fmtTime(lastOkAt);
    } else {
      $('last-updated').style.color = 'var(--danger)';
      $('last-updated').textContent = lastOkAt ? ('Offline \u00B7 last ' + fmtTime(lastOkAt)) : 'Offline';
    }
  }

  function setOnline(up) {
    if (up) {
      setFreshness('live');
      return;
    }
    var age = lastOkAt ? (Date.now() - lastOkAt) : Infinity;
    setFreshness(age < STALE_MAX_MS ? 'stale' : 'offline');
  }

  var refreshGen = 0;
  var REFRESH_TIMEOUT_MS = 12000;

  async function refresh() {
    if (!token) return;
    var gen = ++refreshGen;
    // Bounded requests: a stalled proxy connection must not hold the
    // "Live" pill hostage or leak a fetch per poll forever.
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timeout = setTimeout(function () { if (controller) controller.abort(); }, REFRESH_TIMEOUT_MS);
    try {
      var headers = { Authorization: 'Bearer ' + token };
      var opts = { headers: headers };
      if (controller) opts.signal = controller.signal;
      var results = await Promise.all([
        fetch('/api/report/stats', opts),
        fetch('/api/report/sales?limit=20', opts)
      ]);
      var statsRes = results[0], salesRes = results[1];

      if (gen !== refreshGen) return; // a newer poll superseded this one

      if (statsRes.status === 401 || salesRes.status === 401) { signOut(); return; }

      if (statsRes.status === 402 || salesRes.status === 402) {
        var ld = await statsRes.json().catch(function () { return {}; });
        stopPolling();
        showLicense(ld.error || 'Trial ended. Activate this workstation to continue.', ld.machine_id);
        return;
      }
      if (!statsRes.ok || !salesRes.ok) throw new Error('HTTP ' + statsRes.status + '/' + salesRes.status);

      var stats = await statsRes.json();
      var sales = await salesRes.json();
      if (gen !== refreshGen) return; // never render out-of-order responses
      renderStats(stats);
      renderSales(sales);
      setOnline(true);
    } catch (_) {
      if (gen === refreshGen) setOnline(false); // keep polling; it self-heals when the shop is reachable again
    } finally {
      clearTimeout(timeout);
    }
  }

  function renderStats(s) {
    lastOkAt = Date.now();
    $('st-revenue').textContent = fmtMoney(s.today_sales_revenue);
    $('st-count').textContent = s.today_sales_count;
    $('st-profit').textContent = fmtMoney(s.today_sales_profit);
    $('st-split').textContent = fmtMoney(s.today_parts_revenue) + ' / ' + fmtMoney(s.today_labor_revenue);
    $('st-credit').textContent = fmtMoney(s.total_credit_outstanding);
    $('st-debtors').textContent = s.total_debtors_count;
    $('st-lowstock').textContent = s.low_stock_count;
    $('st-returns').textContent = s.today_warranty_returns;
    $('st-received').textContent = s.today_units_received || 0;
    $('st-refunded').textContent = fmtMoney(s.today_refunded_total);
    if ($('st-refunded-meta')) {
      $('st-refunded-meta').textContent = Number(s.today_replacement_cost) > 0
        ? ('cash + credit refunds \u00B7 ' + fmtMoney(s.today_replacement_cost) + ' swap cost')
        : 'cash + credit refunds';
    }
    $('st-cash').textContent = fmtMoney(s.today_cash_collected);
    $('st-gcash').textContent = fmtMoney(s.today_gcash_collected);
    $('st-transfer').textContent = fmtMoney(s.today_transfer_collected);
    $('st-settled').textContent = fmtMoney(s.today_credit_settled);
    $('last-updated').textContent = 'Last updated ' + fmtTime(s.generated_at);
  }

  var METHOD_LABELS = { cash: 'Cash', gcash: 'GCash', transfer: 'Transfer', credit: 'Utang' };

  function renderSales(sales) {
    // ponytail: /api/report/sales returns the latest 20 overall, not a day
    // window, so the empty copy must not claim "today".
    var host = $('sales-list');
    if (!sales || !sales.length) {
      host.innerHTML = '<div class="rpt-empty">No sales recorded yet. Sales appear here as the counter rings them up.</div>';
      return;
    }
    host.innerHTML = sales.map(function (s) {
      var voided = Boolean(s.voided);
      var method = voided ? 'Voided' : (METHOD_LABELS[s.payment_method] || s.payment_method || 'Sale');
      var due = !voided && Number(s.credit_balance) > 0.005
        ? '<div class="rpt-sale__due">' + fmtMoney(s.credit_balance) + ' due</div>'
        : '';
      return '<div class="rpt-sale">' +
        '<div class="rpt-sale__main">' +
          '<div class="rpt-sale__top">' +
            '<span class="rpt-sale__code">' + esc(s.sale_code) + '</span>' +
            '<span class="rpt-sale__time">' + esc(fmtSaleTime(s.created_at)) + '</span>' +
          '</div>' +
          '<div class="rpt-sale__cust">' + esc(s.customer_name || 'Walk-in customer') + '</div>' +
        '</div>' +
        '<div class="rpt-sale__amt">' +
          '<div class="rpt-sale__total"' + (voided ? ' style="text-decoration:line-through;opacity:.55"' : '') + '>' + fmtMoney(s.total_amount) + '</div>' +
          '<div class="rpt-sale__method" data-m="' + esc(voided ? 'voided' : s.payment_method) + '">' + esc(method) + '</div>' +
          due +
        '</div>' +
      '</div>';
    }).join('');
  }

  /* ---------- license screen ---------- */

  function showLicense(msg, machineId) {
    $('license-msg').textContent = msg || 'Trial ended. Activate this workstation to continue.';
    var mid = $('license-mid');
    if (machineId) { mid.textContent = 'Machine ID: ' + machineId; mid.hidden = false; } else { mid.hidden = true; }
    show('view-license');
  }

  $('btn-license-back').addEventListener('click', function () {
    show('view-login');
  });

  /* ---------- polling, paused while the tab is hidden ---------- */

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(refresh, POLL_MS);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) {
      stopPolling();
    } else if (token && !$('view-report').hidden) {
      startPolling();
      refresh();
    }
  });

  /* ---------- boot ---------- */

  var saved = '';
  try { saved = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) {}
  if (saved) {
    token = saved;
    enterReport();
  } else {
    show('view-login');
  }

  // Keep background POS server alive while manager report is open
  setInterval(function () {
    fetch('/api/system/heartbeat', { method: 'POST' }).catch(function () {});
  }, 2500);
  fetch('/api/system/heartbeat', { method: 'POST' }).catch(function () {});

  // Pass-through service worker: exists only so Android offers the
  // install prompt when served over HTTPS. Caches nothing:
  // a stale report is a lie.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/report-sw.js').catch(function () {});
  }
})();
