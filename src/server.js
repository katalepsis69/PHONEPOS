// phone-repair-pos/src/server.js
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { initDb, DEFAULT_DB_PATH, getBaseDir, isProgramFilesPath } = require('./db');
const {
  listInventory,
  getInventoryItem,
  getInventoryByBarcode,
  createInventoryItem,
  updateInventoryItem,
  adjustStock,
  deleteInventoryItem,
  listStockMovements,
  archiveInventoryItem,
  importInventory,
  bulkEditInventory,
  listReorderSuggestions
} = require('./inventory');
const { createSale, listSales, getSaleDetails, voidSale } = require('./sales');
const {
  listCustomers,
  getCustomerDetails,
  listCustomerNameVariants,
  settleCustomerCredit,
  setCustomerCreditLimit
} = require('./credits');
const {
  createWarrantyReturn,
  listWarrantyReturns,
  getWarrantyReturnDetails
} = require('./returns');
const {
  getDashboardStats,
  getExceptions,
  getStandingStats,
  getPeriodStats,
  getProductPerformance,
  getDeadStock,
  getReorderList
} = require('./analytics');
const { money } = require('./money');
const { drainOutbox, getSyncStatus, getShopId, backfillMirror } = require('./sync');
const { getLicenseStatus, activateLicense } = require('./license');
const {
  verifyManagerPin, updateManagerPin, isDefaultPin, getReportToken, verifyReportToken,
  verifySessionToken, issueSessionToken, issueElevationToken, verifyElevationToken,
  createStaff, listActiveStaff, deactivateStaff, resetStaffPin, verifyStaffPin,
  hasRecoveryPassword, setRecoveryPassword, recoverManagerPin
} = require('./auth');
const { audit, listAuditLog, verifyChain, txn } = require('./audit');
const { openShift, closeShift, listShifts, getShiftBreakdown } = require('./shifts');
const { getDayBuckets, closeDay, getDayReconciliation } = require('./reconcile');
const { getShopSettings, updateShopSettings, updateSyncSetting, getSettleElevationThreshold, validateSyncUrl, validateSyncUrlHost } = require('./settings');
// The namespace is held, not destructured, and the print route reads sendRaw off
// it at the call site. tests/helper.js replaces printer.sendRaw so no test can
// ever put bytes into a live queue, and a binding destructured at require time
// only sees that patch if the helper happened to load first -- a detail of test
// file order, not a guarantee. One property lookup per send makes the belt
// unbypassable. The rest are layout helpers the belt does not touch.
const printer = require('./printer');

// Fixed sample sale for /api/receipt/preview. Deterministic content chosen to
// exercise the layout: a long item name that wraps, a multi-quantity line, a
// device intake line, a discount and change. No live customer data.
function samplePreviewSale() {
  return {
    sale_code: 'SALE-A1B2C3D4E5F6',
    created_at: new Date().toISOString(),
    customer_name: 'Juan Dela Cruz',
    customer_phone: '0917 123 4567',
    payment_method: 'gcash',
    payment_reference: 'GC-8812',
    subtotal: 2430, discount: 30, total_amount: 2400, amount_paid: 2400, change_amount: 0, credit_balance: 0,
    items: [
      { item_type: 'labor', item_name: DEVICE_LINE_PREFIX + 'iPhone 12 (IMEI 35677890)', quantity: 1, unit_price: 0, total_price: 0 },
      { item_type: 'part', item_name: 'iPhone 12 screen assembly', quantity: 1, unit_price: 1850, total_price: 1850 },
      { item_type: 'part', item_name: 'Tempered glass (Poco X6)', quantity: 2, unit_price: 150, total_price: 300 },
      { item_type: 'part', item_name: 'Charging flex ICC', quantity: 1, unit_price: 280, total_price: 280 },
    ],
    returns: [],
  };
}
const { listPrinters, defaultPrinter, encode, renderTestSlip, renderSaleSlip, renderSettlementSlip, renderClaimStubSlip, DEVICE_LINE_PREFIX } = printer;
const { resetDemoData, seedInitialParts } = require('./seed');
const { checkForUpdates, applyUpdate, getUpdateProgress, consumeHandoffStatus, setUpdateLogSink, defaultUpdateStagingDir, CURRENT_VERSION } = require('./updater');
// [update] lines belong in pos-server.log, which console.log cannot reach in the packaged exe.
setUpdateLogSink(logLine);
require('./db').setDbLogSink(logLine);
require('./sync').setSyncLogSink(logLine);

const MIME_TYPES = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2'
};

const { json } = require('node:stream/consumers');

// ponytail: content-length cap + blanket chunked rejection. No client this app
// has ever streams a body (QR images ride inside JSON under the cap), and a
// chunked POST carries no content-length, so buffering it would bypass the cap
// entirely (stress test: a 32MB chunked body was accepted and parsed).
const MAX_BODY_BYTES = 10 * 1024 * 1024; // room for a photographed GCash QR stored as a data URL
const parseBody = req => {
  if (Number(req.headers['content-length'] || 0) > MAX_BODY_BYTES) {
    const err = new Error('Request body too large');
    err.statusCode = 413;
    return Promise.reject(err);
  }
  if (req.headers['transfer-encoding']) {
    // 411: the cap is expressed as content-length, so a length-less body is
    // the actual defect, not "bad request".
    const err = new Error('Chunked request bodies are not accepted');
    err.statusCode = 411;
    return Promise.reject(err);
  }
  // A valid JSON body of null, or a bare number or string, would throw deep
  // inside the routes; every caller expects an object.
  return json(req).then(b => (b && typeof b === 'object') ? b : {}).catch(() => ({}));
};

// Domain errors are plain Errors with user-readable messages (plus the
// statusCode-carrying ones). Engine failures are the server's fault, not bad
// input, and their text (SQLite constraints, property reads on undefined)
// must not reach the client.
function isInternalError(err) {
  if (!(err instanceof Error)) return true;
  if (err.statusCode) return false;
  return String(err.code || '').startsWith('ERR_SQLITE')
    || err instanceof TypeError || err instanceof RangeError
    || err instanceof ReferenceError || err instanceof SyntaxError;
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// audit_log is append-only and /api/audit re-reads every row, so an oversized
// body is stored as a digest: the shape survives, the 6.5 MB QR payload does not.
const AUDIT_BODY_LIMIT = 200;
function auditValue(v) {
  if (v === null || v === undefined) return null;
  const s = String(v);
  if (s.length <= AUDIT_BODY_LIMIT) return s;
  return `[${s.length}B sha256:${crypto.createHash('sha256').update(s).digest('hex').slice(0, 12)}]`;
}

// A failed print carries whatever the PowerShell helper wrote to stderr, and
// under -EncodedCommand that is up to 4 KB of CLIXML envelope (see
// STDERR_BUFFER_LIMIT in src/printer.js). audit_log is append-only and
// /api/audit re-reads every row, and the counter's toast has room for one
// sentence, so the reason is unwrapped and capped here, at the boundary where
// it becomes stored or displayed text. 200 characters matches both
// AUDIT_BODY_LIMIT above and parseSendResult's own slice in src/printer.js.
const PRINT_ERROR_LIMIT = 200;
function clipPrintError(value) {
  const raw = String(value ?? '').trim();
  // Only text that reads as markup gets tag-stripped; a real message like
  // "Sale not found" must survive verbatim.
  const markup = /^#< CLIXML|<Objs[\s>]/.test(raw) ? raw.replace(/<[^>]*>/g, ' ') : raw;
  const flat = markup.replace(/\s+/g, ' ').trim();
  if (!flat) return 'the printer did not answer';
  return flat.length > PRINT_ERROR_LIMIT ? `${flat.slice(0, PRINT_ERROR_LIMIT)} [truncated]` : flat;
}

// The phone report is the one namespace reachable off the box, so a
// non-loopback bind needs the same operator acknowledgement as the cloud bind.
function isLoopbackHost(host) {
  return host === 'localhost' || host === '::1' || host.startsWith('127.');
}

const isTestEnv = () => Boolean(process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test');

// The packaged exe runs as a Windows GUI-subsystem binary: console.log goes
// nowhere and start.bat is not involved, so every startup fact — or failure —
// must also land in a log file the user can actually find. Without this, a
// server that dies before its browser opens is invisible: the customer just
// sees "cannot connect" with no way to know why.
function logFilePath() {
  // Under `node --test` the suite runs the server in-process, so logLine used to
  // append every test-failure stack to the shop's own pos-server.log (measured
  // 2026-10-14: the file was dominated by suite noise). Test runs log to a
  // per-process temp file instead; a packaged app still logs beside its data.
  if (isTestEnv()) {
    return path.join(os.tmpdir(), `pos-server-test-${process.pid}.log`);
  }
  const base = getBaseDir();
  try {
    fs.accessSync(base, fs.constants.W_OK);
    return path.join(base, 'pos-server.log');
  } catch (_) {
    return path.join(os.tmpdir(), 'pos-server.log');
  }
}
function logLine(msg) {
  console.log(msg);
  try {
    const file = logFilePath();
    // One rollover generation is all a register needs; without any, the log
    // grows unbounded on a machine left running for months.
    try {
      if (fs.statSync(file).size > 5 * 1024 * 1024) {
        try { fs.unlinkSync(`${file}.1`); } catch (_) {}
        fs.renameSync(file, `${file}.1`);
      }
    } catch (_) {}
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${msg}\n`);
  } catch (_) {}
}

// SKU UNIQUE collisions are a user error (that barcode is taken), not a 400.
const isSkuDupError = err => /UNIQUE constraint failed.*sku_barcode/i.test(String(err?.message || ''));

// Successful print sends dedupe per job for this window; see /api/print.
const PRINT_DEDUP_MS = 90000;
const printDedup = new Map();

// /api/system/update/check is session- and license-exempt by design (a fresh or
// locked install still needs it), which leaves it reachable by any LAN caller.
// Each call costs one outbound GitHub fetch, so a per-client fixed window caps
// quota burn and socket pressure without touching the one call a boot makes.
const UPDATE_CHECK_BUDGET_LIMIT = 10;
const UPDATE_CHECK_WINDOW_MS = 60 * 1000;
const updateCheckBudget = new Map();
// The progress poll runs at 400ms while an update is live, so its ceiling is
// permissive: generous enough for the real UI, tight enough that a loop is
// not free.
const UPDATE_PROGRESS_BUDGET_LIMIT = 300;
const updateProgressBudget = new Map();
function fixedWindowBudget(map, limit, req) {
  const key = (req.socket && req.socket.remoteAddress) || 'unknown';
  const now = Date.now();
  let b = map.get(key);
  if (!b || now - b.start > UPDATE_CHECK_WINDOW_MS) { b = { start: now, count: 0 }; map.set(key, b); }
  b.count++;
  if (map.size > 200) {
    for (const [k, v] of map) if (now - v.start > UPDATE_CHECK_WINDOW_MS) map.delete(k);
  }
  return b.count > limit;
}
function updateCheckBudgetExceeded(req) {
  return fixedWindowBudget(updateCheckBudget, UPDATE_CHECK_BUDGET_LIMIT, req);
}
function updateProgressBudgetExceeded(req) {
  return fixedWindowBudget(updateProgressBudget, UPDATE_PROGRESS_BUDGET_LIMIT, req);
}

// staff sessions must not see unit costs
function stripCostFor(sale, session, elevated) {
  const allowed = !session || session.type === 'manager' || elevated;
  if (allowed || !Array.isArray(sale.items)) return sale;
  return { ...sale, items: sale.items.map(it => ({ ...it, unit_cost: null })) };
}
function stripCostsForCustomer(details, session, elevated) {
  if (!details || !Array.isArray(details.sales)) return details;
  return { ...details, sales: details.sales.map(s => stripCostFor(s, session, elevated)) };
}

function stripInventoryCosts(items, session, elevated) {
  const allowed = !session || session.type === 'manager' || elevated;
  if (allowed) return items;
  const strip = item => item ? { ...item, cost_price: null } : item;
  return Array.isArray(items) ? items.map(strip) : strip(items);
}

// verify-exe.js and start.bat drive the exe with env overrides so a smoke run
// never touches dist/data or dist/backups.
const RUNTIME_DB_PATH = process.env.POS_DB_PATH || DEFAULT_DB_PATH;
const RUNTIME_BACKUP_DIR = process.env.POS_BACKUP_DIR || path.join(getBaseDir(), 'backups');

function createServer(opts = {}) {
  const options = typeof opts === 'string' ? { dbPath: opts } : (opts || {});
  const dbPath = options.dbPath || RUNTIME_DB_PATH;
  const backupDir = options.backupDir || RUNTIME_BACKUP_DIR;
  const isServiceMode = Boolean(options.serviceMode ?? serviceModeFromEnv());
  // let, not const: /api/backup/restore swaps the handle after loading a
  // backup file; every handler reads this binding at request time.
  let db = initDb(dbPath);
  const publicDir = path.join(getBaseDir(), 'public');

  // --- Cloud sync agent -------------------------------------------------
  // The outbox fills on every write (src/sync.js enqueues inside each
  // transaction); this drains it: debounced 2s after any finished non-GET API
  // call, plus a 60s safety tick. Backoff doubles 30s -> 5min on consecutive
  // failures so a down VPS never gets spammed; the shop never blocks on it.
  // NODE_ENV=test skips the interval so test runs exit cleanly.
  let syncInFlight = false;
  let syncBackoffMs = 30000;
  let syncNotBefore = 0;
  let syncLastError = null;
  let syncLastAttemptAt = null;
  let syncDebounce = null;
  function kickSync() {
    if (syncInFlight || Date.now() < syncNotBefore) return;
    if (syncDebounce) clearTimeout(syncDebounce);
    syncDebounce = setTimeout(runSync, 2000);
    if (syncDebounce.unref) syncDebounce.unref();
  }
  async function runSync() {
    if (syncInFlight) return;
    // Tests (and any future clean-shutdown path) can close the DB while this
    // interval is still armed; node:sqlite then throws "database is not open"
    // from inside the timer and pos-crash.log fills with rejection noise
    // forever. A closed database is simply a no-op tick for the sync agent.
    if (db.open === false) return;
    syncInFlight = true;
    syncLastAttemptAt = new Date().toISOString();
    try {
      const r = await drainOutbox(db);
      syncBackoffMs = 30000;
      syncNotBefore = 0;
      syncLastError = null;
      if (r && r.synced) {
        // Hygiene: without this the outbox grows forever.
        try {
          db.prepare("DELETE FROM sync_outbox WHERE synced_at IS NOT NULL AND synced_at < datetime('now', '-30 days')").run();
        } catch (_) {}
      }
      if (r && (r.unreadable || r.quarantined)) {
        logLine(`sync: quarantined ${r.quarantined || 0} cloud-rejected and ${r.unreadable || 0} unreadable outbox row(s); the local rows are untouched`);
      }
    } catch (err) {
      const wasSilent = syncLastError === null;
      syncLastError = String(err.message || err);
      syncNotBefore = Date.now() + syncBackoffMs;
      syncBackoffMs = Math.min(syncBackoffMs * 2, 300000);
      // One line per failure streak (first failure, then the 300s cap): the
      // chip resets daily with the heartbeat watchdog, the log must not.
      if (wasSilent || syncBackoffMs >= 300000) {
        logLine(`sync: push failed (${syncLastError}); retrying with backoff, outbox rows held`);
      }
    } finally {
      syncInFlight = false;
      // More than one batch arrived while pushing: keep draining. The inner
      // try is for shutdown races (tests close the DB while a debounce is
      // still pending) — a closed database must not become an unhandled
      // rejection.
      try {
        const pending = db.prepare('SELECT COUNT(*) AS c FROM sync_outbox WHERE synced_at IS NULL').get().c;
        if (pending > 0 && Date.now() >= syncNotBefore) kickSync();
      } catch (_) {}
    }
  }
  if (!process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
    const syncTick = setInterval(kickSync, 60000);
    if (syncTick.unref) syncTick.unref();
  }

  const server = http.createServer(async (req, res) => {
    // The cloud mirror's header wall, mirrored from cloud/server.js minus HSTS
    // (the register has no TLS-proxy mode). One block here covers sendJson and
    // both static branches; escHtml stays the first XSS layer, these the second.
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    // A Host header that is not a valid URL authority throws here, outside the
    // route try block below; answer 400 instead of dying as an unhandled
    // rejection with no response at all.
    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (_) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad request');
      return;
    }
    const pathname = url.pathname;
    const method = req.method;
    // Assigned inside the try once the session resolves; the catch-all error
    // log reads it, so the declaration lives where the catch can see it.
    let ctx = null;
    // Finished write requests kick the sync drain (debounced): a sale rings,
    // the cloud mirror and the manager phone hear about it within seconds.
    // lastClientHeartbeat is deliberately NOT refreshed here: the auto-exit
    // watchdog means the kiosk heartbeat and nothing else, so feeding it from
    // every response kept a dead kiosk's server alive behind stray traffic.
    if (method !== 'GET' && pathname.startsWith('/api/')) {
      res.on('finish', () => kickSync());
    }

    try {
      // --- API ROUTES ---
      if (pathname.startsWith('/api/')) {
        const isReportApi = pathname.startsWith('/api/report/');
        if (isReportApi) {
          if (!isLoopbackHost(String(process.env.HOST || '127.0.0.1')) && process.env.POS_LAN_REPORT_ACK !== '1') {
            return sendJson(res, 403, {
              error: 'The report namespace is reachable off this machine because HOST is set to a non-loopback address. Start the server with POS_LAN_REPORT_ACK=1 to confirm you want that, and put TLS in front (docs/OPERATIONS_AND_DEPLOYMENT.md, section 5.6).'
            });
          }
          // Report namespace: the read-only phone PWA is opened on the shop
          // LAN by IP, not localhost, so the localhost-only Origin/Host
          // regexes below can never pass. The Bearer token is the
          // boundary for data routes. What must NOT relax is the cross-origin
          // POST gate: browsers always attach Origin to cross-origin POSTs, and
          // without this check any website the manager visits could burn the
          // shared 5-try PIN lockout via no-preflight POSTs to /api/report/login,
          // remotely freezing the counter's PIN for 60s at a time. Same-origin
          // compare, not string equality: Host "machine.ts.net" vs Origin
          // "https://machine.ts.net". The URL parser normalizes default ports
          // away, so strip :80/:443 from the Host side before comparing.
          const origin = req.headers.origin;
          if (origin) {
            let originHost = null;
            try { originHost = new URL(origin).host; } catch (_) {}
            const hostHeader = String(req.headers.host || '').replace(/:(80|443)$/i, '');
            if (!originHost || originHost !== hostHeader) {
              return sendJson(res, 403, { error: 'Cross-origin API requests are not allowed' });
            }
          }
        } else {
          // Localhost-only API: a foreign page open in the same browser must not be
          // able to drive it (a text/plain cross-origin POST skips CORS preflight),
          // and DNS rebinding arrives with a foreign Host header. Browsers always
          // send Origin on cross-origin POSTs, so blocking a mismatched Origin closes
          // CSRF, and blocking a mismatched Host closes rebinding.
          const origin = req.headers.origin;
          if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(origin)) {
            return sendJson(res, 403, { error: 'Cross-origin API requests are not allowed' });
          }
          // ponytail: parse Host via URL to handle IPv6 literals [::1]:3000 and
          // normalize default ports; regex alone rejects valid [::1] host.
          const hostRaw = String(req.headers.host || '');
          if (hostRaw) {
            let hostOk = /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(hostRaw);
            if (!hostOk) {
              try { const h = new URL(`http://${hostRaw}`).hostname; hostOk = /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(h); } catch (_) {}
            }
            if (!hostOk) return sendJson(res, 403, { error: 'Invalid Host header' });
          }
        }

        // --- TRIAL / LICENSE GATE (after security, before commerce) ---
        // 402 Payment Required until the 14-day trial ends or a key activates.
        // Status + activate stay open so the lock screen can render and unlock.
        // System shutdown + heartbeat stay open so the app can always be cleanly exited.
        // Login stays open: a locked workstation still needs the staff picker rendered.
        const license = getLicenseStatus(db);
        // Only what the lock screen and a clean exit need stays reachable once
        // the trial ends; staff management and the rest of /api/auth/* lock
        // with everything else (each still authenticates internally).
        const licenseExempt = pathname === '/api/auth/login' ||
                         pathname === '/api/auth/change-pin' ||
                         pathname === '/api/auth/recovery-status' ||
                         pathname === '/api/auth/recover-pin' ||
                         pathname === '/api/license/status' ||
                         pathname === '/api/license/activate' ||
                         pathname === '/api/system/shutdown' ||
                         pathname === '/api/system/heartbeat' ||
                         pathname === '/api/system/update/check' ||
                         pathname === '/api/system/update/progress' ||
                         pathname === '/api/system/update/apply';
        if (license.license_required && !licenseExempt) {
          return sendJson(res, 402, { error: 'Trial ended. Activate this workstation to continue.', machine_id: license.machine_id });
        }

        // license gate applies to /api/report/* too — a locked workstation
        // stays fully locked, login included.

        // --- SESSION AUTH ---
        // The /api/report/* namespace authenticates with its own persisted
        // Bearer token (checked per-route below), and the login namespace is
        // how a session is obtained in the first place.
        const sessionExempt = pathname.startsWith('/api/auth/') ||
                         isReportApi ||
                         pathname === '/api/license/status' ||
                         pathname === '/api/license/activate' ||
                         pathname === '/api/system/heartbeat' ||
                         pathname === '/api/system/update/check' ||
                         pathname === '/api/system/update/progress';
        const bearer = String(req.headers.authorization || '').startsWith('Bearer ')
          ? req.headers.authorization.slice(7)
          : '';
        const session = verifySessionToken(db, bearer);
        if (!sessionExempt && !session) {
          return sendJson(res, 401, { error: 'Login required' });
        }
        const elevated = verifyElevationToken(db, String(req.headers['x-elevation'] || ''));
        ctx = session ? { actor: session, elevated } : null;
        const elevationDenied = () => sendJson(res, 403, { error: 'Manager authorization required', code: 'elevation_required' });
        // The factory PIN is printed in the manual, so elevation granted
        // against it proves nothing: the consequential manager actions refuse
        // the whole path until it is replaced (docs/SECURITY_AND_LICENSING.md).
        const factoryPinDenied = () => sendJson(res, 403, { error: 'Change the factory PIN before requesting manager access', code: 'elevation_required' });

        // MANAGER PHONE REPORTS (read-only; consumed by public/report.html)
        // Two failure shapes, mirroring /api/auth/login so the client
        // treats them alike: wrong PIN → 200 {valid:false}; lockout throws →
        // 400 with the message (surfaced by the login form).
        if (pathname === '/api/report/login' && method === 'POST') {
          const body = await parseBody(req);
          // Malformed/garbage bodies used to fall through as {pin:undefined} and
          // answer 200 {valid:false} — the UI rendered that as "Incorrect PIN",
          // masking transport bugs as credential errors. Say what actually
          // happened: a 400 the client can show verbatim.
          if (!body || typeof body.pin !== 'string') {
            return sendJson(res, 400, { error: 'Request body must be JSON with a string "pin"' });
          }
          let ok;
          try { ok = verifyManagerPin(db, body.pin, 'report'); }
          // Lockout carries its own 429 from the auth layer; let the status
          // through (the report client renders data.error for any non-OK).
          catch (err) { return sendJson(res, err.statusCode || 400, { error: err.message }); }
          if (!ok) {
            audit(db, { type: 'manager', id: null, name: 'Manager' }, false, 'security', 'report_login_failed', { note: 'incorrect PIN' });
            return sendJson(res, 200, { valid: false });
          }
          audit(db, { type: 'manager', id: null, name: 'Manager' }, false, 'security', 'report_login', {});
          return sendJson(res, 200, { valid: true, token: getReportToken(db) });
        }

        if ((pathname === '/api/report/stats' || pathname === '/api/report/sales') && method === 'GET') {
          const token = String(req.headers.authorization || '').startsWith('Bearer ')
            ? req.headers.authorization.slice(7)
            : '';
          if (!verifyReportToken(db, token)) {
            return sendJson(res, 401, { error: 'Invalid or missing report token' });
          }
          if (pathname === '/api/report/stats') {
            return sendJson(res, 200, { ...getDashboardStats(db), generated_at: new Date().toISOString() });
          }
          // listSales clamps limit to 1–500 itself.
          return sendJson(res, 200, listSales(db, { limit: Number(url.searchParams.get('limit')) || 20 }));
        }

        // INVENTORY
        if (pathname === '/api/inventory' && method === 'GET') {
          return sendJson(res, 200, stripInventoryCosts(listInventory(db, {
            search: url.searchParams.get('search') || '',
            brand: url.searchParams.get('brand') || '',
            part_type: url.searchParams.get('part_type') || '',
            lowStockOnly: url.searchParams.get('low_stock') === 'true',
            include_archived: url.searchParams.get('include_archived') === 'true'
          }), session, elevated));
        }

        if (pathname === '/api/inventory/reorder' && method === 'GET') {
          const report = listReorderSuggestions(db, { days: url.searchParams.get('days') || 3 });
          // Costs are manager data, same rule as the catalog: est_cost is derived
          // from cost_price, so it is stripped alongside it for staff sessions.
          const allowed = !session || session.type === 'manager' || elevated;
          if (!allowed) report.rows = report.rows.map(r => ({ ...r, cost_price: null, est_cost: null }));
          return sendJson(res, 200, report);
        }

        if (pathname === '/api/inventory' && method === 'POST') {
          if (!elevated) return elevationDenied();
          const body = await parseBody(req);
          try {
            return sendJson(res, 201, createInventoryItem(db, body, { op_id: body.op_id }, ctx));
          } catch (err) {
            if (isSkuDupError(err)) return sendJson(res, 409, { error: `SKU barcode "${body.sku_barcode}" is already assigned to another part` });
            throw err;
          }
        }

        if (pathname === '/api/inventory/import' && method === 'POST') {
          if (!elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const body = await parseBody(req);
          return sendJson(res, 200, importInventory(db, body.rows, ctx, {
            op_id: body.op_id,
            auto_price: body.auto_price,
            retail_markup: body.retail_markup,
            wholesale_markup: body.wholesale_markup
          }));
        }

        if (pathname === '/api/inventory/bulk-edit' && method === 'POST') {
          if (!elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const body = await parseBody(req);
          return sendJson(res, 200, bulkEditInventory(db, body, ctx, { op_id: body?.op_id }));
        }

        if (pathname === '/api/inventory/seed-starter' && method === 'POST') {
          if (session?.type === 'staff' || !elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const count = seedInitialParts(db, { zeroStock: true, skipSales: true });
          audit(db, session, elevated, 'inventory', 'seed_starter', { count });
          return sendJson(res, 200, { ok: true, count });
        }

        const invBarcodeMatch = pathname.match(/^\/api\/inventory\/barcode\/([^/]+)$/);
        if (invBarcodeMatch && method === 'GET') {
          const barcode = decodeURIComponent(invBarcodeMatch[1]);
          const item = getInventoryByBarcode(db, barcode);
          if (!item) return sendJson(res, 404, { error: 'Item not found' });
          return sendJson(res, 200, stripInventoryCosts(item, session, elevated));
        }

        const invStockMatch = pathname.match(/^\/api\/inventory\/(\d+)\/adjust-stock$/);
        if (invStockMatch && method === 'POST') {
          if (!elevated) return elevationDenied();
          const body = await parseBody(req);
          const item = adjustStock(db, Number(invStockMatch[1]), Number(body.delta), { reason: body.reason, note: body.note, op_id: body.op_id }, ctx);
          return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'Not found' });
        }

        const invMovementsMatch = pathname.match(/^\/api\/inventory\/(\d+)\/movements$/);
        if (invMovementsMatch && method === 'GET') {
          const id = Number(invMovementsMatch[1]);
          if (!getInventoryItem(db, id)) return sendJson(res, 404, { error: 'Not found' });
          return sendJson(res, 200, listStockMovements(db, id));
        }

        const invArchiveMatch = pathname.match(/^\/api\/inventory\/(\d+)\/(archive|unarchive)$/);
        if (invArchiveMatch && method === 'POST') {
          if (!elevated) return elevationDenied();
          const item = archiveInventoryItem(db, Number(invArchiveMatch[1]), invArchiveMatch[2] === 'archive' ? 1 : 0, ctx);
          return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'Not found' });
        }

        const invIdMatch = pathname.match(/^\/api\/inventory\/(\d+)$/);
        if (invIdMatch) {
          const id = Number(invIdMatch[1]);
          if (method === 'PUT') {
            if (!elevated) return elevationDenied();
            const body = await parseBody(req);
            try {
              // expected_stock + op_id: the edit modal's optimistic-concurrency
              // guard and double-submit dedup for the absolute stock set.
              const item = updateInventoryItem(db, id, body, { expected_stock: body.expected_stock, op_id: body.op_id }, ctx);
              return item ? sendJson(res, 200, item) : sendJson(res, 404, { error: 'Not found' });
            } catch (err) {
              if (isSkuDupError(err)) return sendJson(res, 409, { error: `SKU barcode "${body.sku_barcode}" is already assigned to another part` });
              if (err.statusCode === 409) return sendJson(res, 409, { error: err.message });
              throw err;
            }
          }
          if (method === 'DELETE') {
            if (!elevated) return elevationDenied();
            return sendJson(res, 200, { success: deleteInventoryItem(db, id, ctx) });
          }
        }

        // SALES
        if (pathname === '/api/sales' && method === 'GET') {
          return sendJson(res, 200, listSales(db, {
            limit: Number(url.searchParams.get('limit')) || 50,
            offset: Number(url.searchParams.get('offset')) || 0,
            search: url.searchParams.get('search') || '',
            payment_method: url.searchParams.get('payment_method') || '',
            date: url.searchParams.get('date') || ''
          }));
        }

        if (pathname === '/api/sales' && method === 'POST') {
          const body = await parseBody(req);
          return sendJson(res, 201, stripCostFor(createSale(db, body, ctx), session, elevated));
        }

        const saleIdMatch = pathname.match(/^\/api\/sales\/(\d+)$/);
        if (saleIdMatch && method === 'GET') {
          const sale = getSaleDetails(db, Number(saleIdMatch[1]));
          return sale ? sendJson(res, 200, stripCostFor(sale, session, elevated)) : sendJson(res, 404, { error: 'Not found' });
        }

        const saleVoidMatch = pathname.match(/^\/api\/sales\/(\d+)\/void$/);
        if (saleVoidMatch && method === 'POST') {
          if (!elevated) return elevationDenied();
          const body = await parseBody(req);
          return sendJson(res, 200, voidSale(db, Number(saleVoidMatch[1]), body.reason, ctx));
        }

        // Receipt reprint: audited, never mints a new sale.
        const saleReprintMatch = pathname.match(/^\/api\/sales\/(\d+)\/reprint$/);
        if (saleReprintMatch && method === 'POST') {
          const sale = getSaleDetails(db, Number(saleReprintMatch[1]));
          if (!sale) return sendJson(res, 404, { error: 'Not found' });
          audit(db, session, false, 'receipt', 'reprint', { sale_code: sale.sale_code });
          return sendJson(res, 200, { success: true, sale: stripCostFor(sale, session, elevated) });
        }

        // WARRANTY RETURNS & RMA
        const returnSaleMatch = pathname.match(/^\/api\/sales\/(\d+)\/returns$/);
        if (returnSaleMatch && method === 'POST') {
          // Every RMA type moves stock or money (replacement draws a part,
          // credit_refund relieves debt, cash_refund opens the drawer), so
          // none may be filed by a staff session.
          if (!elevated) return elevationDenied();
          const body = await parseBody(req);
          return sendJson(res, 201, createWarrantyReturn(db, { ...body, sale_id: Number(returnSaleMatch[1]) }, ctx));
        }

        if (pathname === '/api/returns' && method === 'GET') {
          return sendJson(res, 200, listWarrantyReturns(db, {
            search: url.searchParams.get('search') || '',
            return_type: url.searchParams.get('return_type') || ''
          }));
        }

        const returnIdMatch = pathname.match(/^\/api\/returns\/(\d+)$/);
        if (returnIdMatch && method === 'GET') {
          const details = getWarrantyReturnDetails(db, Number(returnIdMatch[1]));
          return details ? sendJson(res, 200, details) : sendJson(res, 404, { error: 'Return not found' });
        }

        // SHIFTS
        const shiftBreakdownMatch = pathname.match(/^\/api\/shifts\/(\d+)\/breakdown$/);
        if (shiftBreakdownMatch && method === 'GET') {
          if (!elevated) return elevationDenied();
          return sendJson(res, 200, getShiftBreakdown(db, Number(shiftBreakdownMatch[1])));
        }

        if (pathname === '/api/shifts' && method === 'GET') {
          return sendJson(res, 200, listShifts(db, session));
        }
        if (pathname === '/api/shifts/open' && method === 'POST') {
          const body = await parseBody(req);
          return sendJson(res, 201, openShift(db, session, body.opening_float));
        }
        const shiftCloseMatch = pathname.match(/^\/api\/shifts\/(\d+)\/close$/);
        if (shiftCloseMatch && method === 'POST') {
          const body = await parseBody(req);
          return sendJson(res, 200, closeShift(db, Number(shiftCloseMatch[1]), body.counted_cash, ctx));
        }

        // AUDIT LOG VIEW & INTERNAL CONTROLS
        if (pathname === '/api/audit' && method === 'GET') {
          if (!elevated) return elevationDenied();
          return sendJson(res, 200, listAuditLog(db, {
            category: url.searchParams.get('category') || '',
            actor: url.searchParams.get('actor') || '',
            // has() not ||: days=0 is the UI's "All time" — Number(0)||30 turned it into 30.
            days: url.searchParams.has('days') ? Number(url.searchParams.get('days')) : 30,
            limit: Number(url.searchParams.get('limit')) || 100,
            offset: Number(url.searchParams.get('offset')) || 0
          }));
        }

        if (pathname === '/api/audit/verify' && method === 'GET') {
          if (!elevated) return elevationDenied();
          return sendJson(res, 200, verifyChain(db));
        }

        if (pathname === '/api/exceptions' && method === 'GET') {
          if (!elevated) return elevationDenied();
          return sendJson(res, 200, getExceptions(db, Number(url.searchParams.get('days') ?? 7), url.searchParams.get('date')));
        }

        // Cloud sync state for the topbar chip. Not secret: pending counts and
        // timestamps only, no URLs or tokens.
        if (pathname === '/api/sync/status' && method === 'GET') {
          let lanIp = null;
          try {
            const nets = os.networkInterfaces();
            for (const list of Object.values(nets)) {
              for (const iface of (list || [])) {
                if (iface && iface.family === 'IPv4' && !iface.internal) { lanIp = iface.address; break; }
              }
              if (lanIp) break;
            }
          } catch (_) {}
          const lanEnabled = !isLoopbackHost(String(process.env.HOST || '127.0.0.1')) && process.env.POS_LAN_REPORT_ACK === '1';
          const portNum = server.address()?.port || Number(process.env.PORT) || 3000;
          const baseStatus = getSyncStatus(db);
          const freshRef = baseStatus.last_synced_at || syncLastAttemptAt;
          const refMs = freshRef ? Date.parse(freshRef) : NaN;
          const stale = Boolean(baseStatus.url_configured && !syncInFlight && Number.isFinite(refMs) && (Date.now() - refMs) > 120000);
          return sendJson(res, 200, {
            ...baseStatus,
            in_flight: Boolean(syncInFlight),
            stale,
            last_attempt_at: syncLastAttemptAt,
            last_error: syncLastError,
            next_attempt_in_ms: Math.max(0, syncNotBefore - Date.now()),
            lan_ip: lanIp,
            lan_enabled: lanEnabled,
            lan_report_url: lanIp ? `http://${lanIp}:${portNum}/report.html` : `http://localhost:${portNum}/report.html`
          });
        }

        // CUSTOMERS & CREDITS (UTANG)
        if (pathname === '/api/customers' && method === 'GET') {
          return sendJson(res, 200, listCustomers(db, {
            search: url.searchParams.get('search') || '',
            filter: url.searchParams.get('filter') || ''
          }));
        }

        const customerSettleMatch = pathname.match(/^\/api\/customers\/([^/]+)\/settle-credit$/);
        if (customerSettleMatch && method === 'POST') {
          const customerName = decodeURIComponent(customerSettleMatch[1]);
          const body = await parseBody(req);
          // The credit-limit check was gated and the collection was not: cap
          // the borrowing, then let anyone cancel the debt. Above: manager only.
          const settleAmount = Number(body && body.amount_paid);
          const threshold = getSettleElevationThreshold(db);
          if (Number.isFinite(settleAmount) && settleAmount > threshold && !elevated) return elevationDenied();
          // URL name wins over the body: the path is the identity, a client
          // field must not quietly point the settlement at someone else.
          return sendJson(res, 200, stripCostsForCustomer(settleCustomerCredit(db, { ...body, customer_name: customerName }, ctx), session, elevated));
        }

        // Must be matched before /api/customers/:name, which would otherwise
        // read "name-variants" as a customer.
        if (pathname === '/api/customers/name-variants' && method === 'GET') {
          if (!elevated) return elevationDenied();
          return sendJson(res, 200, listCustomerNameVariants(db));
        }

        const customerNameMatch = pathname.match(/^\/api\/customers\/([^/]+)$/);
        if (customerNameMatch && method === 'GET') {
          const customerName = decodeURIComponent(customerNameMatch[1]);
          const details = getCustomerDetails(db, customerName);
          return details ? sendJson(res, 200, stripCostsForCustomer(details, session, elevated)) : sendJson(res, 404, { error: 'Customer not found' });
        }

        const customerLimitMatch = pathname.match(/^\/api\/customers\/([^/]+)\/limit$/);
        if (customerLimitMatch && method === 'POST') {
          if (!elevated) return elevationDenied();
          const customerName = decodeURIComponent(customerLimitMatch[1]);
          const body = await parseBody(req);
          const updated = setCustomerCreditLimit(db, customerName, body.credit_limit, body.notes, ctx);
          return sendJson(res, 200, updated);
        }

        // SETTINGS (GCash, Warranty, Thermal Receipt configuration)
        if (pathname === '/api/settings' && method === 'GET') {
          const s = getShopSettings(db);
          // The sync token never leaves (PRIVATE_SETTINGS), but sync_url is the
          // VPS address: infrastructure detail staff sessions don't need.
          if (session?.type === 'staff') { delete s.sync_url; delete s.sync_shop_id; }
          const hasSyncToken = Boolean(db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_token'").get()?.value);
          return sendJson(res, 200, { ...s, sync_token_configured: hasSyncToken, pin_change_required: isDefaultPin(db), recovery_password_configured: hasRecoveryPassword(db) });
        }

        if (pathname === '/api/settings' && method === 'POST') {
          if (session?.type === 'staff' || !elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const body = await parseBody(req);
          // The read sides fall back silently on junk (warrantyDays() reads 7,
          // colsFor() reads 48 columns), so a typed value must be checked here,
          // while the manager still knows they typed it. The two markup keys
          // joined the loop after a saved junk value was silently ignored by
          // CSV auto-price and bulk recalculate.
          for (const key of ['warranty_days', 'settle_elevation_threshold', 'default_retail_markup_pct', 'default_wholesale_markup_pct', 'shift_variance_threshold']) {
            if (!Object.prototype.hasOwnProperty.call(body, key)) continue;
            const raw = String(body[key] ?? '').trim();
            if (!raw) continue; // cleared field: the read side keeps its default
            const n = Number(raw);
            if (!Number.isFinite(n) || n < 0) {
              return sendJson(res, 400, { error: `${key} must be a non-negative number` });
            }
          }
          if (Object.prototype.hasOwnProperty.call(body, 'receipt_paper_width')) {
            const w = String(body.receipt_paper_width ?? '').trim();
            if (w && w !== '58mm' && w !== '80mm') {
              return sendJson(res, 400, { error: 'receipt_paper_width must be 58mm or 80mm' });
            }
          }
          if (Object.prototype.hasOwnProperty.call(body, 'receipt_template')) {
            const t = String(body.receipt_template ?? '').trim();
            if (t && !['standard', 'compact', 'boxed', 'airy', 'grid'].includes(t)) {
              return sendJson(res, 400, { error: 'receipt_template must be standard, compact, boxed, airy or grid' });
            }
          }
          if (Object.prototype.hasOwnProperty.call(body, 'receipt_item_rows')) {
            const m = String(body.receipt_item_rows ?? '').trim();
            if (m && !['auto', 'two_line', 'one_line'].includes(m)) {
              return sendJson(res, 400, { error: 'receipt_item_rows must be auto, two_line or one_line' });
            }
          }
          // DNS resolution at save time only (drain must not gain a failure
          // mode). A public hostname pointing at a private IP is rejected
          // here; a dead lookup saves with a warning the UI can show.
          let dnsWarning = null;
          if (body && typeof body.sync_url === 'string') {
            dnsWarning = await validateSyncUrlHost(body.sync_url);
          }
          // A queue name this machine does not have is a typo or a renamed
          // device. Refuse it at the save, because the alternative is finding
          // out on a customer's receipt.
          //
          // The write loop below does String(v) for every key, so the field has
          // to be settled here or the guard is bypassable: {"printer_name":12345}
          // would store the unvalidated "12345", and {"printer_name":null} --
          // the shape a UI naturally sends when the field is cleared -- would
          // store the four-character name "null". That name is truthy, so the
          // print route would keep short-circuiting onto it and never consult
          // defaultPrinter again: the fallback would be defeated for good, with
          // no queue left to print on. Only a validated non-empty string is ever
          // stored, and clearing the field clears it.
          if (body && Object.prototype.hasOwnProperty.call(body, 'printer_name')) {
            const rawName = body.printer_name;
            const isClear = rawName === null || (typeof rawName === 'string' && !rawName.trim());
            if (isClear) {
              body.printer_name = '';
            } else if (typeof rawName !== 'string') {
              return sendJson(res, 400, { error: 'printer_name must be a queue name, or an empty value to clear it' });
            } else {
              const name = rawName.trim();
              const { printers: known, error } = await listPrinters();
              // Three outcomes, and only one of them is "not installed":
              // parsePrinterLookup separates queues, a machine with none, and a
              // lookup that broke, and the caller is expected to tell them
              // apart. Collapsing a dead spooler into "Printer 'X' is not
              // installed" both lies to the manager and blocks every save that
              // carries the field, so this mirrors the 502 the print route's own
              // enumeration already returns.
              if (error) {
                return sendJson(res, 502, { error: `Could not check the printer list: ${clipPrintError(error)}` });
              }
              if (!known.some((p) => p.name === name)) {
                return sendJson(res, 400, { error: `Printer '${name}' is not installed on this machine` });
              }
              body.printer_name = name;
            }
          }
          txn(db, () => {
            const changes = {};
            for (const [k, v] of Object.entries(body)) {
              const before = db.prepare('SELECT value FROM shop_settings WHERE key = ?').get(k)?.value ?? null;
              if (k === 'sync_url' || k === 'sync_token') updateSyncSetting(db, k, String(v));
              else updateShopSettings(db, k, String(v));
              changes[k] = k === 'sync_token' ? ['[redacted]', '[redacted]'] : [auditValue(before), auditValue(String(v))];
            }
            audit(db, session, true, 'settings', 'update', { changes });
          });
          if (body && (body.sync_url !== undefined || body.sync_token !== undefined)) kickSync();
          const hasSyncToken = Boolean(db.prepare("SELECT value FROM shop_settings WHERE key = 'sync_token'").get()?.value);
          return sendJson(res, 200, { ...(dnsWarning ? { warning: dnsWarning } : {}), ...getShopSettings(db), sync_token_configured: hasSyncToken, pin_change_required: isDefaultPin(db), recovery_password_configured: hasRecoveryPassword(db) });
        }

        // PAPER PREVIEW (Settings): the exact lines renderSaleSlip lays out for
        // the chosen template/width/item rows, rendered against a fixed sample
        // sale so the manager sees the roll output without printing. Same
        // builder the queue feeds to encode(), so preview and paper cannot
        // drift; read-only, elevation-gated like the settings it mirrors.
        if (pathname === '/api/receipt/preview' && method === 'POST') {
          if (!elevated) return elevationDenied();
          const overrides = await parseBody(req);
          const settings = {
            ...getShopSettings(db),
            receipt_paper_width: overrides.paper_width === '58mm' ? '58mm' : '80mm',
            receipt_template: ['standard', 'compact', 'boxed', 'airy', 'grid'].includes(overrides.template) ? overrides.template : 'standard',
            receipt_item_rows: ['auto', 'two_line', 'one_line'].includes(overrides.item_rows) ? overrides.item_rows : 'auto',
          };
          return sendJson(res, 200, { lines: renderSaleSlip(samplePreviewSale(), settings) });
        }

        if (pathname === '/api/settings/pair-cloud' && method === 'POST') {
          if (session?.type === 'staff' || !elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const { sync_url, code } = await parseBody(req);
          const defaultCloudUrl = 'https://repairsync.bot-keep.xyz';
          const effectiveSyncUrl = (typeof sync_url === 'string' && sync_url.trim()) ? sync_url.trim() : defaultCloudUrl;
          validateSyncUrl(effectiveSyncUrl);
          const cleanCode = String(code || '').trim().replace(/\s+/g, '');
          if (!/^\d{6}$/.test(cleanCode)) {
            logLine('pair-cloud refused: pairing code is not 6 digits');
            return sendJson(res, 400, { error: 'Pairing code must be 6 digits' });
          }

          const targetUrl = new URL('/api/pair', effectiveSyncUrl).href;
          // The machine's own stable id, not the shop's display name: display
          // names collide (two counters both called 'Counter 1' fought over one
          // cloud identity, and every re-pair fragmented the mirror into dead
          // shops). ensureSyncTables mints sync_shop_id at boot, so this is the
          // same id the outbox already pushes under.
          const shopSettings = getShopSettings(db);
          const shopIdentity = getShopId(db) || shopSettings.owner_name || 'Counter 1';
          const friendlyName = shopSettings.owner_name || shopSettings.gcash_name || 'Counter 1';
          let cloudRes;
          try {
            cloudRes = await fetch(targetUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code: cleanCode, shop_name: shopIdentity, register_name: friendlyName }),
              // Without this a hung VPS holds the settings save open for
              // undici's own ~5-minute header timeout while the manager stares
              // at "Connecting...".
              signal: AbortSignal.timeout(15000),
            });
          } catch (err) {
            if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
              // The cloud mints the shop, saves the credential and spends the
              // code BEFORE it answers, so a response lost to this timeout can
              // leave the shop paired on the cloud with a token this register
              // never received. Name that state: retries with a new code will
              // 409 (the shop id is already paired), and recovery is a vendor
              // credential rotation.
              logLine(`pair-cloud timed out after 15 s (shop ${shopIdentity}); the cloud may have spent the code already`);
              return sendJson(res, 504, { error: `The cloud did not answer within 15 s. The pairing may have completed on the cloud side anyway; if pushes later fail with 401, generate a new code and ask the vendor to rotate this shop's credential (shop ${shopIdentity}).` });
            }
            logLine(`pair-cloud could not reach ${effectiveSyncUrl}: ${err.message}`);
            return sendJson(res, 502, { error: `Failed to reach cloud service at ${effectiveSyncUrl}: ${err.message}` });
          }

          if (!cloudRes.ok) {
            const errData = await cloudRes.json().catch(() => ({}));
            logLine(`pair-cloud refused ${cloudRes.status}: ${errData.error || 'Pairing failed'}`);
            return sendJson(res, cloudRes.status, { error: errData.error || 'Pairing failed' });
          }

          const { shop_id, sync_token } = await cloudRes.json();
          if (!sync_token) {
            logLine('pair-cloud: cloud returned no sync token');
            return sendJson(res, 502, { error: 'Cloud service did not return a sync token' });
          }

          txn(db, () => {
            updateSyncSetting(db, 'sync_url', effectiveSyncUrl);
            updateSyncSetting(db, 'sync_token', sync_token);
            if (shop_id) {
              db.prepare('INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run('sync_shop_id', String(shop_id));
            }
            // Initial mirror: existing rows enqueue here so the drain pushes
            // them under the just-saved token. Without this a shop pairing an
            // already-populated DB syncs nothing until its next write.
            const backfilled = backfillMirror(db).queued;
            audit(db, session, true, 'settings', 'cloud_paired', { shop_id, backfill_rows: backfilled });
          });
          kickSync();

          const envOverride = process.env.SYNC_URL
            ? { env_override_warning: 'SYNC_URL is set in the environment and wins over the paired target at drain time. Unset it to push to the cloud you just paired with.' }
            : {};
          return sendJson(res, 200, { ok: true, shop_id, sync_url: effectiveSyncUrl, sync_token_configured: true, ...envOverride, ...getShopSettings(db) });
        }

        // PRINTING (ESC/POS). The browser never lays out a printed slip: the
        // server loads the sale from SQLite so a dead tab cannot corrupt one.
        // Every failure is caught here instead of left to the outer catch,
        // because only this route knows whether the job was rejected before the
        // bytes or lost after them, and only it can set the fallback flag the
        // client branches on. Its own rejections answer 400 with their reason;
        // an engine fault answers the outer catch's generic 500, never the
        // engine's text.
        if (pathname === '/api/printers' && method === 'GET') {
          const { printers, error } = await listPrinters();
          // The lookup's error is the same helper stderr the send path gets, so
          // it is clipped by the same rule before any picker shows it.
          return sendJson(res, error ? 502 : 200, error ? { error: clipPrintError(error) } : { printers });
        }

        if (pathname === '/api/print' && method === 'POST') {
          // A body that parsed to null would throw on the first property read
          // and land in the outer catch as a 500, which is the shape this route
          // exists to avoid.
          const body = (await parseBody(req)) || {};
          const settings = getShopSettings(db);
          const kind = String(body.kind || '');
          // audit_log.action is append-only and /api/audit re-reads every row,
          // so the fixed vocabulary is stored, never the client's raw string.
          const job = kind === 'test' || kind === 'sale' || kind === 'settlement' || kind === 'claim_stub' ? kind : 'unknown';
          // A lost response or a double-fire must not hand the customer a second
          // slip: a successful send for the same job is answered from this map
          // for a short window instead of printing again. Failures are never
          // deduped (the queue may have recovered, and the browser fallback
          // already has the paper), the test slip is exempt (deliberate paper),
          // and the audited reprint route is untouched.
          const dedupKey = kind === 'sale' ? `sale:${Number(body.sale_id)}`
            : kind === 'settlement' ? `settlement:${String(body.customer_name || '')}:${Number(body.payment_id)}`
            : null;
          if (dedupKey && printDedup.get(dedupKey) > Date.now() - PRINT_DEDUP_MS) {
            return sendJson(res, 200, { ok: true, deduplicated: true });
          }
          // Stays null until sendRaw has answered. From that call on the bytes
          // are in the queue and paper is already out, whatever happens next.
          let delivered = null;
          try {
            let slip;
            if (kind === 'test') {
              slip = renderTestSlip(settings);
            } else if (kind === 'sale') {
              const sale = getSaleDetails(db, Number(body.sale_id));
              if (!sale) throw new Error('Sale not found');
              slip = renderSaleSlip(sale, settings);
            } else if (kind === 'settlement') {
              // The payment id alone cannot render this slip: what the customer
              // still owes is a live figure on the customer record, not a column
              // on the payment row. Loading the debtor by name is also what keeps
              // a guessed payment_id from printing somebody else's collection --
              // the row has to belong to the named customer to be found at all,
              // and a name that matches no debtor simply has no payments.
              const customer = getCustomerDetails(db, String(body.customer_name || ''));
              const payment = (customer?.payments || []).find((p) => p.id === Number(body.payment_id));
              if (!payment) throw new Error('Settlement payment not found');
              slip = renderSettlementSlip(payment, customer, settings);
            } else if (kind === 'claim_stub') {
              // Estimate paper from the POS tab's cart: the tab renders the
              // same fields on the browser path, so the payload rides the body.
              // No dedup window: a claim stub is not money paper and a manager
              // may legitimately print it twice.
              slip = renderClaimStubSlip(body, settings);
            } else {
              throw new Error(`Unknown print job '${kind}'`);
            }
            // The configured queue is the answer, so || short-circuits and the
            // enumeration never runs: listPrinters() costs ~1.4 s of PowerShell
            // startup and its result was thrown away on every receipt whenever
            // Settings names a queue. An unconfigured shop still pays it and
            // still falls through to defaultPrinter, and an enumeration that
            // yields nothing usable still lands on the error below.
            const target = settings.printer_name
              || defaultPrinter((await listPrinters()).printers);
            if (!target) throw new Error('No printer found. Check the cable, then Refresh in Settings.');
            // Read off the namespace, never a binding captured at require time:
            // tests/helper.js replaces printer.sendRaw so no test can ever put
            // bytes in a live queue, and a destructured copy of the original can
            // silently detach from that patch depending on which file loads
            const drawerKick = body.drawer_kick !== undefined ? Boolean(body.drawer_kick) : (job === 'sale' || job === 'settlement' || job === 'test');
            const result = await printer.sendRaw(target, encode(slip, { drawerKick }));
            // A vanished saved queue is the failure this shop hits for real, and
            // "the printer queue could not be opened" alone does not tell the
            // counter which queue went away. The route owns the target, so the
            // route names it: the toast Task 5 shows quotes the same queue
            // Settings shows, and never a substitute one.
            const sent = result.ok
              ? { ok: true }
              : { ok: false, error: clipPrintError(`Printing to '${target}' failed: ${result.error || 'the printer refused the job'}`) };
            // Delivery is recorded before the audit, not inside it. From here on
            // the bytes have reached the queue and the slip is already coming off
            // the roll. Everywhere else in this file an audit failure rolls its
            // side effect back with it; printed paper cannot roll back, and
            // audit_log is append-only so a wrong row can never be corrected. So
            // a failed audit must not reach the client as a print failure: the
            // counter would fall back and print a SECOND receipt for one sale.
            const answer = { ...sent, fallback: !result.ok };
            delivered = answer;
            if (result.ok && dedupKey) {
              printDedup.set(dedupKey, Date.now());
              if (printDedup.size > 500) {
                for (const [k, t] of printDedup) if (t < Date.now() - PRINT_DEDUP_MS) printDedup.delete(k);
              }
            }
            // The queue name is operator text from Settings, and a row in this
            // table is forever: the reason above is clipped to the same cap, and
            // the name has to be clipped too or a 10 KB queue name lands intact in
            // the audit detail that /api/audit re-reads in full. The clip is only
            // for storage; the send still goes to the exact name the shop saved.
            audit(db, session, false, 'print', job, { printer: clipPrintError(target), ...sent });
            return sendJson(res, 200, answer);
          } catch (err) {
            if (delivered) {
              // Only the audit row failed, after the paper. Answer what actually
              // happened and put the missing row in the one log that can still
              // say so; do not retry the audit, because the database is the thing
              // that just refused to write.
              logLine(`POST /api/print audit failed after delivery: ${err.stack || err.message}`);
              return sendJson(res, 200, delivered);
            }
            if (isInternalError(err)) {
              // An engine fault is this route's failure, not the counter's bad
              // request: a locked database inside getSaleDetails must not answer
              // 400 "database is locked". That text is an information leak, it
              // reads as a typo to fix, and Task 5's fallback copy would act on
              // it as if the job were merely rejected. Same policy as
              // isInternalError's use in the outer catch, and the same generic
              // message -- but this route still owns the fallback flag, so the
              // client behaves as it should either way.
              logLine(`POST /api/print failed: ${err.stack || err.message}`);
              return sendJson(res, 500, {
                error: 'Something went wrong on the server. Try again, or check pos-server.log.',
                fallback: true
              });
            }
            const reason = clipPrintError(err.message);
            // A slip the renderer refused is not a printer fault. money() in
            // src/printer.js and money() in src/money.js both flag an amount that
            // cannot go on paper, and the browser path's printMoney refuses the
            // same figure, so telling the tab to fall back would only retry the
            // refusal on the other sheet. Every other rejection on this branch
            // (unknown kind, a row that is not there, no queue to aim at) is a
            // fault the browser can still rescue, and there the spec's rule
            // stands: a shop is never left unable to hand over a receipt.
            const refusal = printer.isAmountRefusal(err);
            audit(db, session, false, 'print', job, { ok: false, error: reason, refused_by_guard: refusal });
            return sendJson(res, 400, { error: reason, fallback: !refusal });
          }
        }

        // DASHBOARD & BACKUP
        // ?period=day|3d|7d|30d|365d (trailing localtime windows, default day)
        // plus &date=YYYY-MM-DD to pin the window end, and &from=YYYY-MM-DD
        // with period=custom for a picked start..end range.
        if (pathname === '/api/dashboard' && method === 'GET') {
          if (!elevated) return elevationDenied();
          const periodParam = url.searchParams.get('period');
          const period = ['day', '3d', '7d', '30d', '365d', 'custom'].includes(periodParam) ? periodParam : 'day';
          const date = url.searchParams.get('date');
          const from = url.searchParams.get('from');
          if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw new Error('Invalid report date; use a real YYYY-MM-DD date');
          const useFrom = period === 'custom' && from ? from : null;
          const stats = getPeriodStats(db, period, date, useFrom);
          const rangeFrom = stats.range.from;
          const rangeTo = stats.range.to;
          const periodShifts = db.prepare(`
            SELECT id, staff_id, staff_name, opened_at, opening_float, closed_at, counted_cash, expected_cash, variance, status
            FROM shifts
            WHERE (date(opened_at, 'localtime') >= ? AND date(opened_at, 'localtime') <= ?)
               OR (date(closed_at, 'localtime') >= ? AND date(closed_at, 'localtime') <= ?)
            ORDER BY id DESC
          `).all(rangeFrom, rangeTo, rangeFrom, rangeTo);
          const activeShift = db.prepare("SELECT id, staff_id, staff_name, opened_at, opening_float, status FROM shifts WHERE status = 'open' LIMIT 1").get() || null;
          const closedPeriodShifts = periodShifts.filter(s => s.status === 'closed');
          const drawerVariance = money(closedPeriodShifts.reduce((acc, s) => acc + (s.variance || 0), 0));
          const drawerCounted = money(closedPeriodShifts.reduce((acc, s) => acc + (s.counted_cash - (s.opening_float || 0)), 0));
          return sendJson(res, 200, {
            generated_at: new Date().toISOString(),
            ...stats,
            period_shifts: periodShifts,
            active_shift: activeShift,
            drawer_variance: drawerVariance,
            drawer_counted: drawerCounted,
            // Same window as the KPIs above: a pinned day must pin every panel,
            // or the tab contradicts itself (top performers empty on a picked day).
            products: getProductPerformance(db, period, date, useFrom),
            dead_stock: getDeadStock(db, period, date, useFrom),
            reorder: getReorderList(db, period, date, useFrom),
            standing: getStandingStats(db),
            backup: getBackupStatus(db, backupDir)
          });
        }

        // DAY CLOSE. GET returns the live buckets and any stored close, so the
        // screen can say "already signed" instead of offering a second count.
        const reconcileMatch = pathname.match(/^\/api\/reconcile\/(\d{4}-\d{2}-\d{2})$/);
        if (reconcileMatch && method === 'GET') {
          if (!elevated) return elevationDenied();
          const day = reconcileMatch[1];
          const dayShifts = db.prepare(`
            SELECT id, staff_id, staff_name, opened_at, opening_float, closed_at, counted_cash, expected_cash, variance, status
            FROM shifts
            WHERE date(opened_at, 'localtime') = ? OR date(closed_at, 'localtime') = ?
            ORDER BY id ASC
          `).all(day, day);
          const openShift = db.prepare("SELECT id, staff_id, staff_name, opened_at, opening_float, status FROM shifts WHERE status = 'open' LIMIT 1").get() || null;
          const closedDayShifts = dayShifts.filter(s => s.status === 'closed');
          const totalShiftVariance = money(closedDayShifts.reduce((acc, s) => acc + (s.variance || 0), 0));
          const totalShiftCounted = money(closedDayShifts.reduce((acc, s) => acc + (s.counted_cash - (s.opening_float || 0)), 0));
          return sendJson(res, 200, {
            ...getDayBuckets(db, day),
            stored: getDayReconciliation(db, day),
            shifts: dayShifts,
            open_shift: openShift,
            total_shift_variance: totalShiftVariance,
            total_shift_counted: totalShiftCounted
          });
        }

        if (pathname === '/api/reconcile/close-day' && method === 'POST') {
          if (!elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const body = await parseBody(req);
          if (!body || body.counted_cash === null || body.counted_cash === undefined || body.counted_cash === '') {
            throw new Error('Counted cash is required');
          }
          const day = body.date || db.prepare("SELECT date('now','localtime') AS d").get().d;
          const closed = closeDay(db, day, body.counted_cash, ctx);
          return sendJson(res, 201, closed);
        }

        if (pathname === '/api/backup' && method === 'POST') {
          if (!elevated) return elevationDenied();
          const backupPath = createDbBackup(db, dbPath, backupDir);
          audit(db, session, true, 'system', 'backup', { file: path.basename(backupPath) });
          return sendJson(res, 200, { success: true, backup_file: path.basename(backupPath) });
        }

        // Restore candidates: the .db files the backup job itself writes.
        if (pathname === '/api/backup/list' && method === 'GET') {
          if (!elevated) return elevationDenied();
          const files = [];
          try {
            for (const f of fs.readdirSync(backupDir)) {
              if (!/^(shop-|shop_backup_)[A-Za-z0-9._-]*\.db$/.test(f)) continue;
              const st = fs.statSync(path.join(backupDir, f));
              files.push({ file: f, size_bytes: st.size, modified_at: new Date(st.mtimeMs).toISOString() });
            }
          } catch (_) { /* missing backups dir = empty list */ }
          files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
          return sendJson(res, 200, { backups: files });
        }

        // RESTORE. The live db handle is closed, the chosen backup copied over
        // the database file, and the handle reopened — same process, no restart.
        // A safety snapshot of the live data is taken FIRST, so a restore can
        // itself be undone from the same list.
        if (pathname === '/api/backup/restore' && method === 'POST') {
          if (!elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const body = await parseBody(req);
          const { name, source } = resolveVerifiedBackup(backupDir, body?.file);

          const preRestore = createDbBackup(db, dbPath, backupDir,
            `shop_backup_pre-restore_${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
          db.close();
          // The old handle's WAL sidecars are dead weight now; leaving a stale
          // -wal next to the copied file would let SQLite replay garbage.
          for (const suffix of ['-wal', '-shm']) {
            try { fs.unlinkSync(dbPath + suffix); } catch (_) { /* already gone */ }
          }
          // Copy to a sibling temp file and rename over the live database:
          // rename is atomic, so power loss mid-restore leaves either the old
          // file or the new one, never a truncated shop.db that cannot boot.
          const tmpRestore = `${dbPath}.restore-tmp-${process.pid}-${Date.now()}`;
          try {
            fs.copyFileSync(source, tmpRestore);
            fs.renameSync(tmpRestore, dbPath);
          } catch (e) {
            try { fs.unlinkSync(tmpRestore); } catch (_) {}
            // Copy or rename failed: the original file is untouched, reopen it.
            db = initDb(dbPath);
            throw new Error(`Restore failed, original database reopened: ${e.message}`);
          }
          db = initDb(dbPath);
          audit(db, session, true, 'system', 'restore', { file: name, pre_restore_backup: path.basename(preRestore) });
          return sendJson(res, 200, { success: true, restored_from: name, pre_restore_backup: path.basename(preRestore) });
        }

        // BACKUP DOWNLOAD (USB copy)
        if (pathname === '/api/backup/download' && method === 'GET') {
          if (!elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const fileParam = url.searchParams.get('file');
          let name;
          let source;
          if (fileParam) {
            const resolved = resolveVerifiedBackup(backupDir, fileParam, 'downloaded');
            name = resolved.name;
            source = resolved.source;
          } else {
            let newest = null;
            try {
              const files = fs.readdirSync(backupDir)
                .filter(f => /^(shop-|shop_backup_)[A-Za-z0-9._-]*\.db$/.test(f) && path.basename(f) === f)
                .map(f => {
                  const p = path.join(backupDir, f);
                  try {
                    return { name: f, path: p, mtimeMs: fs.statSync(p).mtimeMs };
                  } catch (_) { return null; }
                })
                .filter(Boolean)
                .sort((a, b) => b.mtimeMs - a.mtimeMs);

              for (const candidate of files) {
                if (verifyBackupFile(candidate.path)) {
                  newest = candidate;
                  break;
                }
              }
            } catch (_) {}
            if (!newest) {
              return sendJson(res, 404, { error: 'No backups found' });
            }
            name = newest.name;
            source = newest.path;
          }

          const bytes = fs.readFileSync(source);
          audit(db, session, true, 'system', 'backup_download', { file: name });
          res.writeHead(200, {
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${name}"`,
            'Content-Length': bytes.length,
            'Cache-Control': 'no-store'
          });
          res.end(bytes);
          return;
        }

        // CSV EXPORTS (accounting / tax hand-off)
        const csvEsc = v => {
          let s = String(v ?? '');
          // Excel executes a leading =,+,@,- as a formula: prefix an apostrophe
          // unless the cell is a plain number, so negative prices survive.
          if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+(\.\d+)?$/.test(s))) s = `'${s}`;
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const sendCsv = (res, filename, header, rows) => {
          const body = [header, ...rows].map(r => r.map(csvEsc).join(',')).join('\r\n');
          res.writeHead(200, {
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="${filename}"`
          });
          res.end(body);
        };

        if (pathname === '/api/inventory/export' && method === 'GET') {
          if (!elevated) return elevationDenied();
          // Same column set as the import, so a round-trip reconciles.
          const items = listInventory(db);
          audit(db, session, true, 'inventory', 'export', { rows: items.length });
          return sendCsv(res, 'inventory.csv',
            ['Brand', 'Model Name', 'Part Type', 'SKU / Barcode', 'Capital', 'Retail Price', 'Wholesale Price', 'Stock Qty', 'Min Stock Alert', 'Supplier', 'Location'],
            items.map(i => [i.brand, i.model_name, i.part_type, i.sku_barcode ?? '', i.cost_price, i.price_retail, i.price_technician, i.stock_quantity, i.min_stock_alert, i.supplier ?? '', i.location ?? '']));
        }

        if (pathname === '/api/export/sales.csv' && method === 'GET') {
          if (!elevated) return elevationDenied();
          // ponytail: newest 500 sales per export (same cap as listSales).
          // Full-history export the day a shop crosses that — until then this
          // covers years of records.
          const sales = listSales(db, { limit: 500 });
          audit(db, session, true, 'system', 'export', { file: 'sales.csv', rows: sales.length });
          return sendCsv(res, 'sales.csv',
            ['sale_code', 'date', 'customer', 'phone', 'payment_method', 'reference', 'subtotal', 'discount', 'total', 'paid', 'change', 'credit_balance', 'voided'],
            sales.map(s => [s.sale_code, s.created_at, s.customer_name, s.customer_phone, s.payment_method, s.payment_reference, s.subtotal, s.discount, s.total_amount, s.amount_paid, s.change_amount, s.credit_balance, s.voided ? '1' : '0']));
        }

        if (pathname === '/api/export/customers.csv' && method === 'GET') {
          if (!elevated) return elevationDenied();
          // ponytail: same 5000 cap as the customer list itself.
          const customers = listCustomers(db, { limit: 5000 });
          audit(db, session, true, 'system', 'export', { file: 'customers.csv', rows: customers.length });
          return sendCsv(res, 'customers.csv',
            ['customer', 'phone', 'orders', 'total_purchases', 'total_spent_paid', 'credit_balance'],
            customers.map(c => [c.customer_name, c.customer_phone, c.sales_count, c.total_purchases, c.total_spent_paid, c.total_credit_balance]));
        }

        // LICENSE & ACTIVATION
        if (pathname === '/api/license/status' && method === 'GET') {
          // version rides along for the feedback report; the value is public
          // in every release note anyway.
          return sendJson(res, 200, { ...getLicenseStatus(db), version: CURRENT_VERSION, service_mode: isServiceMode });
        }

        if (pathname === '/api/license/activate' && method === 'POST') {
          const body = await parseBody(req);
          return sendJson(res, 200, activateLicense(db, body.license_key));
        }

        // MANAGER & STAFF AUTH
        if (pathname === '/api/auth/staff' && method === 'GET') {
          if (!session) return sendJson(res, 401, { error: 'Login required' });
          return sendJson(res, 200, listActiveStaff(db));
        }

        if (pathname === '/api/auth/staff' && method === 'POST') {
          if (!session) return sendJson(res, 401, { error: 'Login required' });
          if (!elevated) return elevationDenied();
          const body = await parseBody(req);
          // Write and audit ride one savepoint: a crash between them must not
          // leave a staff account (or a revoked PIN) with no trail.
          const staff = txn(db, () => {
            const created = createStaff(db, body.name, body.pin); // throws on weak/duplicate
            audit(db, session, true, 'security', 'staff_create', { staff_id: created.id, name: created.name });
            return created;
          });
          return sendJson(res, 201, staff);
        }

        const staffResetMatch = pathname.match(/^\/api\/auth\/staff\/(\d+)\/reset-pin$/);
        if (staffResetMatch && method === 'POST') {
          if (!session) return sendJson(res, 401, { error: 'Login required' });
          if (!elevated) return elevationDenied();
          const body = await parseBody(req);
          const id = Number(staffResetMatch[1]);
          const ok = txn(db, () => {
            if (!resetStaffPin(db, id, body.pin)) return false;
            audit(db, session, true, 'security', 'staff_reset_pin', { staff_id: id });
            return true;
          });
          if (!ok) return sendJson(res, 404, { error: 'Staff not found' });
          return sendJson(res, 200, { success: true });
        }

        const staffDeactivateMatch = pathname.match(/^\/api\/auth\/staff\/(\d+)\/deactivate$/);
        if (staffDeactivateMatch && method === 'POST') {
          if (!session) return sendJson(res, 401, { error: 'Login required' });
          if (!elevated) return elevationDenied();
          const id = Number(staffDeactivateMatch[1]);
          const ok = txn(db, () => {
            if (!deactivateStaff(db, id)) return false;
            audit(db, session, true, 'security', 'staff_deactivate', { staff_id: id });
            return true;
          });
          if (!ok) return sendJson(res, 404, { error: 'Staff not found' });
          return sendJson(res, 200, { success: true });
        }

        if (pathname === '/api/auth/login' && method === 'POST') {
          const body = await parseBody(req);
          // Garbage bodies used to fall through to verifyManagerPin(undefined)
          // → 200 {valid:false} → "Incorrect PIN" in the UI, masking transport
          // bugs as credential errors. Return a 400 the client can show.
          if (!body || typeof body.pin !== 'string') {
            return sendJson(res, 400, { error: 'Request body must be JSON with a string "pin"' });
          }
          let staff = null;
          if (body.staffId !== undefined && body.staffId !== null) {
            staff = db.prepare('SELECT * FROM staff WHERE id = ?').get(Number(body.staffId));
          } else if (body.staffName) {
            staff = db.prepare('SELECT * FROM staff WHERE LOWER(name) = LOWER(?)').get(String(body.staffName).trim());
          }
          if (staff || (body.staffId !== undefined && body.staffId !== null) || body.staffName) {
            if (!staff || !staff.active) return sendJson(res, 200, { valid: false });
            const attempted = { type: 'staff', id: staff.id, name: staff.name };
            let ok;
            try { ok = verifyStaffPin(db, staff.id, body.pin); }
            catch (err) { return sendJson(res, 400, { error: err.message }); }
            if (!ok) {
              audit(db, attempted, false, 'security', 'login_failed', { staff_id: staff.id, note: 'incorrect PIN' });
              return sendJson(res, 200, { valid: false });
            }
            audit(db, attempted, false, 'security', 'login', {});
            return sendJson(res, 200, { token: issueSessionToken(db, attempted), actor: attempted });
          }

          let ok;
          try { ok = verifyManagerPin(db, body.pin); }
          catch (err) { return sendJson(res, 400, { error: err.message }); }
          if (!ok) {
            audit(db, { type: 'manager', id: null, name: 'Manager' }, false, 'security', 'login_failed', { note: 'incorrect PIN' });
            return sendJson(res, 200, { valid: false });
          }
          const actor = { type: 'manager', id: null, name: 'Manager' };
          const sessionToken = issueSessionToken(db, actor);
          // The factory PIN is printed in the manual, so elevation granted
          // against it proves nothing: refuse it here exactly like
          // /api/auth/elevate, or a LAN peer logging in with 1234 walks past the
          // factory gate on every route that only checks elevation. change-pin
          // stays reachable without elevation for first-run setup.
          if (isDefaultPin(db)) {
            audit(db, actor, false, 'security', 'login', {});
            return sendJson(res, 200, { token: sessionToken, actor, pin_change_required: true });
          }
          const { token: elevationToken, expiresAt } = issueElevationToken(db);
          audit(db, actor, true, 'security', 'login', {});
          return sendJson(res, 200, { token: sessionToken, actor, elevationToken, expiresAt });
        }

        if (pathname === '/api/auth/elevate' && method === 'POST') {
          // The factory PIN is printed in the manual, so elevation granted
          // against it proves nothing: refuse the path until it is replaced.
          if (isDefaultPin(db)) {
            return sendJson(res, 403, { error: 'Change the factory PIN before requesting manager access', code: 'elevation_required' });
          }
          const body = await parseBody(req);
          if (!body || typeof body.pin !== 'string') {
            return sendJson(res, 400, { error: 'Request body must be JSON with a string "pin"' });
          }
          let ok;
          try { ok = verifyManagerPin(db, body.pin); }
          catch (err) { return sendJson(res, 400, { error: err.message }); }
          if (!ok) {
            audit(db, session || { type: 'manager', id: null, name: 'unknown' }, false, 'security', 'elevate_failed', {});
            return sendJson(res, 200, { valid: false });
          }
          const { token, expiresAt } = issueElevationToken(db);
          audit(db, session || { type: 'manager', id: null, name: 'Manager' }, true, 'security', 'elevate', {});
          return sendJson(res, 200, { valid: true, elevationToken: token, expiresAt });
        }

        if (pathname === '/api/auth/session' && method === 'GET') {
          if (!session) return sendJson(res, 401, { error: 'Invalid session' });
          return sendJson(res, 200, { valid: true, actor: session });
        }

        if (pathname === '/api/auth/logout' && method === 'POST') {
          if (session) audit(db, session, false, 'security', 'logout', {});
          return sendJson(res, 200, { success: true });
        }

        if (pathname === '/api/auth/change-pin' && method === 'POST') {
          // change-pin verifies the old PIN itself, so it stays reachable
          // without elevation while the factory PIN is live: first-run setup.
          if (session?.type === 'staff' || (!elevated && !isDefaultPin(db))) return elevationDenied();
          const body = await parseBody(req);
          const result = updateManagerPin(db, body.old_pin, body.new_pin); // throws → 400
          audit(db, session || { type: 'manager', id: null, name: 'Manager' }, true, 'security', 'change_pin', {});
          const fresh = { token: issueSessionToken(db, { type: 'manager', id: null, name: session?.name || 'Manager' }) };
          const elev = issueElevationToken(db);
          return sendJson(res, 200, { ...result, ...fresh, elevationToken: elev.token, expiresAt: elev.expiresAt });
        }

        if (pathname === '/api/auth/recovery-status' && method === 'GET') {
          return sendJson(res, 200, { configured: hasRecoveryPassword(db) });
        }

        if (pathname === '/api/auth/recovery-password' && method === 'POST') {
          if (session?.type === 'staff' || !elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const body = await parseBody(req);
          if (!body || typeof body.recovery_password !== 'string') {
            return sendJson(res, 400, { error: 'Request body must be JSON with a string "recovery_password"' });
          }
          txn(db, () => {
            setRecoveryPassword(db, body.recovery_password);
            audit(db, session || { type: 'manager', id: null, name: 'Manager' }, true, 'security', 'set_recovery_password', {});
          });
          return sendJson(res, 200, { success: true, recovery_password_configured: true });
        }

        if (pathname === '/api/auth/recover-pin' && method === 'POST') {
          const body = await parseBody(req);
          if (!body || typeof body.recovery_password !== 'string' || typeof body.new_pin !== 'string') {
            return sendJson(res, 400, { error: 'Request body must be JSON with string "recovery_password" and "new_pin"' });
          }
          const actor = { type: 'manager', id: null, name: 'Manager' };
          let ok;
          try {
            ok = recoverManagerPin(db, body.recovery_password, body.new_pin);
          } catch (err) {
            if (err.statusCode === 429) {
              try { audit(db, actor, false, 'security', 'pin_recover_failed', { note: err.message }); } catch (_) {}
            }
            throw err;
          }
          if (!ok) {
            audit(db, actor, false, 'security', 'pin_recover_failed', { note: 'incorrect recovery password' });
            return sendJson(res, 403, { error: 'Incorrect recovery password.' });
          }
          const token = issueSessionToken(db, actor);
          const { token: elevationToken, expiresAt } = issueElevationToken(db);
          audit(db, actor, true, 'security', 'pin_recovered', {});
          return sendJson(res, 200, { success: true, token, actor, elevationToken, expiresAt });
        }

        // RESET DEMO DATA
        if (pathname === '/api/settings/reset-demo' && method === 'POST') {
          if (!elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          const count = resetDemoData(db, ctx);
          return sendJson(res, 200, { success: true, count });
        }

        // SYSTEM HEARTBEAT & SHUTDOWN
        if (pathname === '/api/system/heartbeat' && method === 'POST') {
          hasReceivedInitialHeartbeat = true;
          lastClientHeartbeat = Date.now();
          return sendJson(res, 200, { ok: true });
        }

        if (pathname === '/api/system/shutdown' && method === 'POST') {
          if (isServiceMode) {
            return sendJson(res, 400, { error: 'Background server stays active in installed mode. Close the POS window instead.' });
          }
          if (!elevated) return elevationDenied();
          if (isDefaultPin(db)) return factoryPinDenied();
          audit(db, session, true, 'system', 'shutdown', {});
          sendJson(res, 200, { success: true, message: 'POS Server shutting down...' });
          if (autoExitWatchdog) clearInterval(autoExitWatchdog);
          // Not under test: the suite drives this route to prove its gates, and a
          // test process must not exit mid-run (same reasoning as the update
          // route's handoff).
          if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') return;
          setTimeout(() => {
            try {
              server.close(() => process.exit(0));
            } catch (_) {}
            setTimeout(() => process.exit(0), 400);
          }, 150);
          return;
        }

        // GITHUB RELEASES UPDATER
        if (pathname === '/api/system/update/check' && method === 'GET') {
          if (updateCheckBudgetExceeded(req)) {
            return sendJson(res, 429, { error: 'Too many update checks; try again in a minute.' });
          }
          const updateInfo = await checkForUpdates();
          return sendJson(res, 200, updateInfo);
        }

        if (pathname === '/api/system/update/progress' && method === 'GET') {
          // Own fixed window, sized for the UI's 400ms poll: the route is
          // unauthenticated and an unbounded loop must not be free.
          if (updateProgressBudgetExceeded(req)) {
            return sendJson(res, 429, { error: 'Too many update checks; try again in a minute.' });
          }
          return sendJson(res, 200, getUpdateProgress());
        }

        if (pathname === '/api/system/update/apply' && method === 'POST') {
          if (!elevated) return elevationDenied();
          // Installing a new binary is the most consequential action in the app,
          // so it honors the same factory-PIN refusal as the other destructive
          // routes (docs/SECURITY_AND_LICENSING.md).
          if (isDefaultPin(db)) return factoryPinDenied();
          const body = await parseBody(req);
          let applyRes;
          try {
            applyRes = await applyUpdate({
              downloadUrl: body?.downloadUrl,
              expectedBytes: body?.expectedBytes,
              serviceMode: isServiceMode
            });
          } catch (err) {
            // The audit row is written AFTER applyUpdate validates, and only ever
            // carries the reason, never the caller's raw URL: that string is
            // untrusted, body-capped at 10MB, and used to be stored verbatim in
            // the append-only trail before anything had checked it. The resolved,
            // trusted URL reaches the trail on the branches that have one.
            audit(db, session, true, 'system', 'update_apply', {
              ok: false, error: String(err.message || err).slice(0, 300)
            });
            throw err;
          }
          audit(db, session, true, 'system', 'update_apply', {
            ok: Boolean(applyRes.success),
            version: applyRes.version || '',
            url: applyRes.url || '',
            running_in_dev: Boolean(applyRes.runningInDev)
          });
          sendJson(res, 200, applyRes);
          // The handoff: exit so the helper can overwrite the running exe. Not
          // under test, where the apply is driven through the update hooks and
          // a test process must not exit mid-suite.
          if (applyRes.success && !process.env.NODE_TEST_CONTEXT && process.env.NODE_ENV !== 'test') {
            if (autoExitWatchdog) clearInterval(autoExitWatchdog);
            setTimeout(() => {
              try { server.close(() => process.exit(0)); } catch (_) {}
              setTimeout(() => process.exit(0), 400);
            }, 300);
          }
          return;
        }

        return sendJson(res, 404, { error: 'Endpoint not found' });
      }

      // --- STATIC FILES ---
      let reqPath = pathname === '/' ? '/index.html' : (pathname === '/report' ? '/report.html' : pathname);
      if (reqPath.includes('\0')) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }
      let filePath = path.resolve(path.join(publicDir, path.normalize(reqPath)));
      if (!filePath.startsWith(publicDir + path.sep) && filePath !== publicDir) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
        return;
      }

      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        // no-cache on disk-served files too: without it the browser applies
        // heuristic freshness and keeps serving a stale UI after a rebuild.
        // (Applies to the dev/`start.bat` path; the embedded branch has its own.)
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'text/plain',
          'Cache-Control': 'no-cache'
        });
        // A mid-read failure with no 'error' listener raises uncaught: the
        // response hangs and the crash handler fires. Headers are already out,
        // so there is nothing to send but a teardown.
        fs.createReadStream(filePath).on('error', () => res.destroy()).pipe(res);
      } else if (global.__EMBEDDED_STATIC__ && global.__EMBEDDED_STATIC__[reqPath]) {
        const file = global.__EMBEDDED_STATIC__[reqPath];
        const ext = path.extname(reqPath);
        // woff2 rides along as base64 (binary); everything else embedded as utf8.
        const body = Buffer.isBuffer(file) ? file : Buffer.from(file, 'utf8');
        res.writeHead(200, {
          'Content-Type': MIME_TYPES[ext] || 'text/plain',
          'Cache-Control': 'no-cache'
        });
        res.end(body);
      } else {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found');
      }
    } catch (err) {
      if (res.headersSent) {
        res.destroy(); // mid-stream static file failure; headers are already out
        return;
      }
      // pos-server.log is the only diagnostic surface the packaged exe has,
      // and until now request failures never reached it. One line per failed
      // request: method, path, actor, and the stack for anything unexpected.
      logLine(`${method} ${pathname} failed: ${err.stack || err.message}${ctx?.actor ? ` [actor ${ctx.actor.name || ctx.actor.id}]` : ''}`);
      if (isInternalError(err)) {
        sendJson(res, 500, { error: 'Something went wrong on the server. Try again, or check pos-server.log.' });
      } else {
        sendJson(res, err.statusCode || 400, { error: err.message, ...(err.code ? { code: err.code } : {}) });
      }
    }
  });

  // getDb(): /api/backup/restore swaps the handle, so the original `db` binding
  // a caller holds can be a closed handle while the live one is the replacement.
  // The test harness closes the live handle through this after a restore, or the
  // restored file stays locked on Windows and the temp database is never removed.
  return { server, db, getDb: () => db };
}

function verifyBackupFile(filePath) {
  let vdb = null;
  try {
    vdb = new DatabaseSync(filePath);
    return vdb.prepare('PRAGMA integrity_check').get()?.integrity_check === 'ok';
  } catch (_) {
    return false;
  } finally {
    try { if (vdb) vdb.close(); } catch (_) {}
  }
}

function resolveVerifiedBackup(backupDir, rawFile, action = 'restored') {
  const name = String(rawFile || '');
  if (!/^(shop-|shop_backup_)[A-Za-z0-9._-]*\.db$/.test(name) || path.basename(name) !== name) {
    const err = new Error('Pick a backup from the list');
    err.statusCode = 400;
    throw err;
  }
  const source = path.join(backupDir, name);
  if (!fs.existsSync(source)) {
    const err = new Error('Backup file no longer exists');
    err.statusCode = 400;
    throw err;
  }
  if (!verifyBackupFile(source)) {
    const err = new Error(`That backup file failed its integrity check and cannot be ${action}`);
    err.statusCode = 400;
    throw err;
  }
  return { name, source };
}

function createDbBackup(db, dbPath, backupDir = RUNTIME_BACKUP_DIR, fileName) {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });
  const finalPath = path.join(backupDir, fileName || `shop_backup_${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  // ponytail: vacuum to tmp then atomic rename — avoids TOCTOU unlink+vacuum race
  const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}`;
  const normalizedSqlPath = tmpPath.replace(/\\/g, '/').replace(/'/g, "''");
  try {
    db.exec(`VACUUM INTO '${normalizedSqlPath}'`);
    // A corrupt or partial backup must never evict the last good one.
    if (!verifyBackupFile(tmpPath)) throw new Error('Backup verification failed: integrity_check did not pass on the temporary backup file');
    if (fs.existsSync(finalPath)) fs.unlinkSync(finalPath);
    fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    throw e;
  }
  return finalPath;
}

// The newest backup file decides how exposed the shop is: last_backup_date
// only tracks the automatic run, and a manual snapshot protects just as well.
function getBackupStatus(db, backupDir = RUNTIME_BACKUP_DIR) {
  let newestMs = 0;
  try {
    for (const f of fs.readdirSync(backupDir)) {
      if (!/^(shop-|shop_backup_)[A-Za-z0-9._-]*\.db$/.test(f)) continue;
      const m = fs.statSync(path.join(backupDir, f)).mtimeMs;
      if (m > newestMs) newestMs = m;
    }
  } catch (_) {}
  if (!newestMs) {
    const last = db.prepare("SELECT value FROM shop_settings WHERE key = 'last_backup_date'").get()?.value;
    // A shop-local calendar date: parse it as the local end of that day, not a
    // UTC instant, or the stale warning fires the UTC-offset hours late.
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(last || ''));
    if (m) newestMs = new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999).getTime();
  }
  // Clamped: last_backup_date is stored as an end-of-day timestamp, so the age
  // of a backup taken minutes ago would otherwise read negative.
  const ageHours = newestMs ? Math.max(0, Math.floor((Date.now() - newestMs) / 3600000)) : null;
  return {
    last_backup_at: newestMs ? new Date(newestMs).toISOString() : null,
    age_hours: ageHours,
    // Daily cadence plus a day's slack: past this the shop is one disk failure
    // from losing more than a day of trade, and the dashboard says so.
    stale: ageHours === null || ageHours > 26
  };
}

function runDailyBackup(db, dbPath, backupDir = RUNTIME_BACKUP_DIR) {
  // Shop-local date, not UTC: in UTC+8 a UTC-keyed guard put the daily
  // snapshot at 08:00-09:00 local and made backup file dates mislead a
  // restore. One extra snapshot fires on the first run after this change.
  const today = db.prepare("SELECT date('now','localtime') AS d").get().d;
  const lastBackup = db.prepare("SELECT value FROM shop_settings WHERE key = 'last_backup_date'").get()?.value;
  if (lastBackup === today) return null;

  const backupPath = createDbBackup(db, dbPath, backupDir, `shop-${today}.db`);
  db.prepare("INSERT OR REPLACE INTO shop_settings (key, value) VALUES ('last_backup_date', ?)").run(today);

  // Prune backups older than 14 days
  try {
    const cutoff = Date.now() - (14 * 24 * 60 * 60 * 1000);
    for (const f of fs.readdirSync(backupDir)) {
      // Interrupted runs leave `shop-….db.tmp-<pid>-<ts>` siblings behind;
      // nothing else names them, so the prune has to.
      const isPrunable = f.startsWith('shop-') || f.startsWith('shop_backup_');
      if (!isPrunable) continue;
      const fp = path.join(backupDir, f);
      if (fs.statSync(fp).mtimeMs < cutoff) fs.unlinkSync(fp);
    }
  } catch (_) {} // ponytail: best-effort pruning

  return backupPath;
}

let runningInstance = null;
let lastClientHeartbeat = Date.now();
let hasReceivedInitialHeartbeat = false;
let autoExitWatchdog = null;
let listenerUp = false;

function serviceModeFromEnv(argv = process.argv) {
  // One derivation for every service-mode check: the --service argv flag or
  // the documented POS_SERVICE_MODE / POS_TEST_SERVICE_MODE env overrides.
  // Splitting this expression across call sites let one site forget the env
  // vars and read the wrong staging dir.
  return (argv || []).includes('--service') || process.env.POS_TEST_SERVICE_MODE === '1' || process.env.POS_SERVICE_MODE === '1';
}
function resolveLaunchMode({ execPath = process.execPath, argv = process.argv, env = process.env } = {}) {
  if ((argv || []).includes('--service')) return 'service';
  if (!/^node(\.exe)?$/i.test(path.basename(execPath || '')) && isProgramFilesPath(path.dirname(execPath || '')) && !env?.POS_DB_PATH) {
    return 'launcher';
  }
  return 'direct';
}

function browserProfileDir(env = process.env) {
  return env?.LOCALAPPDATA
    ? path.join(env.LOCALAPPDATA, 'TechPartsPOS', 'browser-profile')
    : path.join(getBaseDir(), 'browser-profile');
}

// --- single-instance hand-off ---------------------------------------------
// Two live servers cannot share port 3000: the second silently drifts to 3001
// and the user edits a different database than their shortcut opens. A PID
// lock next to the DB makes a second double-click hand off: it reopens the
// browser on the running instance's port and exits. Tests (NODE_ENV=test) and
// deliberate multi-instance runs (POS_ALLOW_MULTI=1) bypass the hand-off.
function instanceLockPath(serviceMode = serviceModeFromEnv()) {
  if (serviceMode) {
    return path.join(getBaseDir(), 'runtime', 'server.lock');
  }
  // Machine-wide, not beside the DB: the packaged exe relocates data to
  // %LOCALAPPDATA%\TechPartsPOS while dev/start.bat runs use the project
  // data/ folder, and per-home locks meant exe and dev never saw each other
  // (measured: the exe silently drifted to port 3001). One machine, one
  // register; POS_ALLOW_MULTI and tests still bypass the hand-off.
  return path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TechPartsPOS', 'server.lock');
}
function isPidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (err) { return !!(err && err.code === 'EPERM'); }
}
function currentBootEpochMs() {
  return Math.round(Date.now() - os.uptime() * 1000);
}
function isPosProcessPidAlive(pid, hooks = {}) {
  const pidAliveFn = hooks.isPidAlive || isPidAlive;
  if (!pidAliveFn(pid)) return false;
  const platform = hooks.platform || process.platform;
  if (platform === 'win32') {
    const queryPidFn = hooks.queryWinPidImage || ((targetPid) => {
      try {
        const { execFileSync } = require('node:child_process');
        return execFileSync('tasklist.exe', ['/FI', `PID eq ${targetPid}`, '/FO', 'CSV', '/NH'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 3000
        });
      } catch (_) {
        return null;
      }
    });
    const out = queryPidFn(pid);
    if (typeof out === 'string' && out.trim()) {
      // tasklist returns either "INFO: No tasks..." or "\"image.exe\",\"pid\",..."
      if (!/"(TechPartsPOS(?:\.exe)?|node(?:\.exe)?)"/i.test(out)) {
        return false;
      }
    }
  }
  return true;
}
function isInstanceLockLive(existing, hooks = {}) {
  if (!existing || !Number.isInteger(existing.pid) || existing.pid === process.pid || !existing.port) {
    return false;
  }
  const bootAt = typeof hooks.nowBootAt === 'number' ? hooks.nowBootAt : currentBootEpochMs();
  // ponytail: boot_at staleness assumes the wall clock steps less than 60 s
  // while a server runs; a manual time change can false-stale a live lock into
  // a second instance on a drifted port. Probing the locked port first is the
  // upgrade path, but it needs async in this sync path.
  if (typeof existing.boot_at === 'number') {
    if (Math.abs(bootAt - existing.boot_at) > 60000) return false;
  } else if (existing.started_at) {
    // Legacy v1.0 lock files lack boot_at: if started before this boot, the PID was recycled (e.g. svchost.exe).
    const startedMs = Date.parse(existing.started_at);
    if (Number.isFinite(startedMs) && startedMs < bootAt - 60000) return false;
  }
  return isPosProcessPidAlive(existing.pid, hooks);
}
function readInstanceLock() {
  try { return JSON.parse(fs.readFileSync(instanceLockPath(), 'utf8')); }
  catch (_) { return null; }
}
// One shape for both state files: the lock (direct runs) and the service
// runtime state share the fields isInstanceLockLive reads back.
function instanceStateRecord(port) {
  return {
    pid: process.pid,
    port,
    started_at: new Date().toISOString(),
    boot_at: currentBootEpochMs()
  };
}
function writeInstanceLock(port) {
  try {
    fs.mkdirSync(path.dirname(instanceLockPath()), { recursive: true });
    fs.writeFileSync(instanceLockPath(), JSON.stringify(instanceStateRecord(port)));
  } catch (_) {}
}
function runtimeStatePath(baseDir = getBaseDir()) {
  return path.join(baseDir, 'runtime', 'server.json');
}
function writeRuntimeState(port, baseDir = getBaseDir()) {
  try {
    const p = runtimeStatePath(baseDir);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(instanceStateRecord(port)));
  } catch (_) {}
}
function releaseInstanceLock() {
  try {
    const lock = readInstanceLock();
    if (lock && lock.pid === process.pid) fs.unlinkSync(instanceLockPath());
  } catch (_) {}
  try {
    const statePath = runtimeStatePath();
    if (fs.existsSync(statePath)) {
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      if (state && state.pid === process.pid) fs.unlinkSync(statePath);
    }
  } catch (_) {}
}

async function runInstalledLauncher(hooks = {}) {
  const fetchImpl = hooks.fetchImpl || globalThis.fetch;
  const readRuntimeState = hooks.readRuntimeState || (() => {
    try {
      const p = runtimeStatePath();
      if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch (_) {}
    return null;
  });
  const launchBrowserFn = hooks.launchBrowser || ((url) => new Promise(resolve => launchBrowser(url, resolve)));
  const logLauncher = (line) => {
    try {
      const dir = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'TechPartsPOS');
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, 'launcher.log'), `[${new Date().toISOString()}] ${line}\n`);
    } catch (_) {}
  };
  const runTaskFn = hooks.runTask || ((taskName = 'TechPartsPOS-Server') => {
    try {
      const { execFileSync } = require('node:child_process');
      execFileSync('schtasks.exe', ['/Run', '/TN', taskName], { stdio: 'pipe', windowsHide: true });
      return true;
    } catch (err) {
      const detail = err?.stderr ? String(err.stderr).trim() : (err?.message || 'unknown error');
      logLauncher(`schtasks /Run /TN ${taskName} failed: ${detail}`);
      return false;
    }
  });
  const showErrorBoxFn = hooks.showErrorBox || ((message, title = 'TechParts POS') => {
    try {
      const { spawnSync } = require('node:child_process');
      const psScript = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${String(message).replace(/'/g, "''")}', '${String(title).replace(/'/g, "''")}', [System.Windows.Forms.MessageBoxButtons]::OK, [System.Windows.Forms.MessageBoxIcon]::Error)`;
      spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true });
    } catch (_) {}
  });
  const sleepFn = hooks.sleep || ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  const initialWaitMs = typeof hooks.initialWaitMs === 'number' ? hooks.initialWaitMs : 1500;
  const totalTimeoutMs = typeof hooks.totalTimeoutMs === 'number' ? hooks.totalTimeoutMs : 15000;

  function getPortsToProbe() {
    const state = readRuntimeState();
    const savedPort = state && typeof state.port === 'number' ? state.port : (state && state.port ? parseInt(state.port, 10) : null);
    const fallbackPorts = [3000, 3001, 3002, 3003, 3004, 3005];
    const ports = [];
    if (savedPort && Number.isInteger(savedPort)) {
      ports.push(savedPort);
    }
    for (const p of fallbackPorts) {
      if (!ports.includes(p)) ports.push(p);
    }
    return ports;
  }

  const startTime = Date.now();
  let taskTriggered = false;

  while (Date.now() - startTime < totalTimeoutMs) {
    const ports = getPortsToProbe();
    for (const port of ports) {
      try {
        const res = await fetchImpl(`http://127.0.0.1:${port}/api/license/status`, { signal: AbortSignal.timeout(500) });
        if (res && (res.ok || res.status === 200)) {
          await launchBrowserFn(`http://localhost:${port}`);
          return { ok: true, port, exitCode: 0 };
        }
      } catch (_) {}
    }

    const elapsed = Date.now() - startTime;
    if (elapsed >= initialWaitMs && !taskTriggered) {
      taskTriggered = true;
      try {
        await runTaskFn('TechPartsPOS-Server');
      } catch (_) {}
    }

    if (Date.now() - startTime >= totalTimeoutMs) break;
    await sleepFn(150);
  }

  const errorMessage = 'TechParts POS could not connect to the background server.\n\nPlease restart Windows or ask your Windows Administrator to verify that the TechPartsPOS-Server scheduled task is running.';
  try {
    await showErrorBoxFn(errorMessage, 'TechParts POS');
  } catch (_) {}
  return { ok: false, exitCode: 1 };
}

// Hardens the dedicated browser profile so Edge / Chrome acts as a strictly
// isolated kiosk POS shell: disables Microsoft/Google account linking, sync consent
// popups (Edge SAN), crash recovery bubbles, password save prompts, and translation bars.
function prepareBrowserProfile(profileDir) {
  try {
    const defaultDir = path.join(profileDir, 'Default');
    fs.mkdirSync(defaultDir, { recursive: true });

    // Purge any credential and autofill databases so the kiosk profile never holds or prompts logins
    for (const f of ['Login Data', 'Login Data-journal', 'Login Data For Account', 'Login Data For Account-journal', 'Web Data', 'Web Data-journal']) {
      try { fs.rmSync(path.join(defaultDir, f), { force: true }); } catch (_) {}
    }

    const loadJson = (p) => {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return {}; }
    };

    const prefPath = path.join(defaultDir, 'Preferences');
    const pref = loadJson(prefPath);
    pref.profile = Object.assign(pref.profile || {}, {
      has_seen_signin_fre: true,
      has_seen_welcome_page: true,
      exit_type: 'Normal',
      exited_cleanly: true,
      password_manager_enabled: false
    });
    pref.sync_profile_info = {
      edge_san_is_option_explicitly_selectedby_user: true,
      edge_san_consent_last_shown_date: '13427699142144502',
      edge_san_consent_last_modified_date: '13427699142144566'
    };
    pref.sync = { keep_everything_synced: false, has_setup_completed: false, has_been_enabled: false };
    pref.signin = { allowed: false, signin_with_explicit_browser_signin_on: false };
    pref.account_info = [];
    pref.password_manager = { enabled: false, profile_store_migrated_to_os_crypt_async: true };
    pref.credentials_enable_service = false;
    pref.credentials_enable_autosignin = false;
    pref.autofill = { profile_enabled: false, credit_card_enabled: false };
    pref.translate = { enabled: false };
    pref.browser = Object.assign(pref.browser || {}, { has_seen_welcome_page: true, check_default_browser: false });
    pref.shopping = { contextual_features_enabled: false, rdx_mode_enabled: false };
    pref.edge = Object.assign(pref.edge || {}, {
      quick_search: { show_mini_menu: false },
      sidebar: { sidebar_status: 0 }
    });
    pref.devtools = { disabled: true };
    pref.download = { prompt_for_download: false };
    fs.writeFileSync(prefPath, JSON.stringify(pref, null, 2), 'utf8');

    const localStatePath = path.join(profileDir, 'Local State');
    const localState = loadJson(localStatePath);
    localState.fre = { has_user_seen_fre: true };
    localState.browser = Object.assign(localState.browser || {}, { has_seen_welcome_page: true, check_default_browser: false });
    if (localState.profile?.info_cache?.Default) {
      Object.assign(localState.profile.info_cache.Default, {
        edge_sync_enabled: false,
        is_consented_primary_account: false,
        user_name: '',
        gaia_id: '',
        edge_account_cid: ''
      });
    }
    fs.writeFileSync(localStatePath, JSON.stringify(localState, null, 2), 'utf8');
    return true;
  } catch (err) {
    logLine(`[!] Failed to prepare browser profile: ${err.message}`);
    return false;
  }
}

// Auto open workstation in app mode with silent kiosk printing (Edge is
// preinstalled on Win10/11; Chrome is the fallback, default browser last).
// The exec callback reports failure: in a GUI-subsystem exe a silently failed
// launch meant no browser, no heartbeat, and a server that killed itself
// minutes later with zero visible error. Now it is logged and it disarms
// the watchdog so the server stays reachable.
function launchBrowser(url, onResult) {
  const localAppData = process.env.LOCALAPPDATA || '';
  const chromePath = fs.existsSync(`${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`)
    ? `${process.env.ProgramFiles}\\Google\\Chrome\\Application\\chrome.exe`
    : fs.existsSync(`${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`)
      ? `${process.env['ProgramFiles(x86)']}\\Google\\Chrome\\Application\\chrome.exe`
      : (localAppData && fs.existsSync(`${localAppData}\\Google\\Chrome\\Application\\chrome.exe`))
        ? `${localAppData}\\Google\\Chrome\\Application\\chrome.exe`
        : null;
  const edgePath = fs.existsSync(`${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`)
    ? `${process.env['ProgramFiles(x86)']}\\Microsoft\\Edge\\Application\\msedge.exe`
    : fs.existsSync(`${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`)
      ? `${process.env.ProgramFiles}\\Microsoft\\Edge\\Application\\msedge.exe`
      : (localAppData && fs.existsSync(`${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`))
        ? `${localAppData}\\Microsoft\\Edge\\Application\\msedge.exe`
        : null;
  const browser = edgePath || chromePath;
  // A dedicated profile forces a fresh browser process. Without it, an
  // already-running Edge/Chrome (the shop PC's normal browsing) adopts the
  // URL and silently drops --kiosk-printing, so every auto-print falls back
  // to the print dialog. Flags live on the process, so every window opened
  // from this profile keeps printing silently.
  const profileDir = browserProfileDir();
  prepareBrowserProfile(profileDir);

  const kioskFlags = `--kiosk-printing --no-first-run --no-default-browser-check --user-data-dir="${profileDir}" ` +
    '--start-maximized --disable-sync --disable-devtools --disable-extensions --disable-pinch --overscroll-history-navigation=0 ' +
    '--disable-features=Translate,OptimizationHints,MediaRouter,EdgeWallet,EdgeShopping,msEdgeFre,InterestFeedContentSuggestions,CalculateNativeWinOcclusion,EdgeSidebar,EdgeCopilot,EdgeWebWidget,SearchInSidebar,msEdgeQuickSearch,msEdgeHub,msEdgeReadAloud,msEdgeWebCapture,msEdgeMathSolver,msEdgeCollections,AutofillServerCommunication,AutofillEnableAccountWalletStorage,PasswordGeneration ' +
    '--disable-session-crashed-bubble --hide-crash-restore-bubble --disable-infobars --disable-notifications --disable-save-password-bubble ' +
    '--disable-password-generation --disable-translate --disable-background-networking --disable-component-update --password-store=basic --noerrdialogs ' +
    `--app=${url}#kiosk=1`;

  const cmd = browser
    ? `start "" "${browser}" ${kioskFlags}`
    : `start "" "${url}"`;
  try {
    require('node:child_process').exec(cmd, (err) => {
      if (err) {
        logLine(`[!] Browser launch failed: ${err.message}. The server stays up — open ${url} manually.`);
      }
      if (onResult) onResult(!err);
    });
  } catch (err) {
    logLine(`[!] Browser launch threw: ${err.message}. The server stays up — open ${url} manually.`);
    if (onResult) onResult(false);
  }
}

// The hourly backup tick. The failure branch goes through logLine, not just
// console.error: the packaged exe is a Windows GUI-subsystem binary whose
// console output is thrown away, and a silent backup failure is exactly the
// kind of fact pos-server.log exists to keep. Module-level so the test can
// force a failure without standing up a server.
function runBackupTick(getDb, dbPath) {
  try {
    const backed = runDailyBackup(getDb(), dbPath);
    if (backed) logLine(`Daily backup created: ${path.basename(backed)}`);
  } catch (err) {
    logLine(`Daily backup warning: ${err.message}`);
  }
}

function startServer(preferredPort = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000, host = process.env.HOST || '127.0.0.1') {
  if (runningInstance) return runningInstance;
  let currentPort = preferredPort;
  lastClientHeartbeat = Date.now();

  // Hand off to an already-running instance instead of racing ports.
  if (!isTestEnv() && !process.env.POS_ALLOW_MULTI) {
    const existing = readInstanceLock();
    if (isInstanceLockLive(existing)) {
      logLine(`[i] TechPartsPOS is already running on http://localhost:${existing.port} — opening it.`);
      if (process.platform === 'win32' && !process.env.NO_AUTO_BROWSER && !process.env.NO_LAUNCH_BROWSER) {
        launchBrowser(`http://localhost:${existing.port}`);
      }
      setTimeout(() => process.exit(0), 300);
      return null;
    }
    if (existing) {
      try { fs.unlinkSync(instanceLockPath()); } catch (_) {}
      logLine(`[i] Cleared stale instance lock (pid=${existing.pid}, started_at=${existing.started_at || 'unknown'}).`);
    }
  }

  const { server, db } = createServer();
  runningInstance = { server, db };

  // Fresh installs start with a completely clean database (no demo data auto-seeded)

  server.on('error', (err) => {
    // Windows reports "port already held" as EACCES at least as often as
    // EADDRINUSE: another app bound on 0.0.0.0 blocks a 127.0.0.1 bind, and
    // Hyper-V/WSL reserve whole port ranges. Treating only EADDRINUSE as busy
    // made the app die instantly whenever anything else owned port 3000.
    if ((err.code === 'EADDRINUSE' || err.code === 'EACCES') && currentPort < preferredPort + 20) {
      console.log(`[!] Port ${currentPort} is busy or blocked (${err.code}), retrying on port ${currentPort + 1}...`);
      logLine(`[!] Port ${currentPort} is busy or blocked (${err.code}), retrying on port ${currentPort + 1}...`);
      currentPort += 1;
      setTimeout(() => server.listen(currentPort, host), 100);
      return;
    }
    logLine(`Fatal Server Error: ${err.message}`);
    console.error('Fatal Server Error:', err.message);
    if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
      console.error(`Ports ${preferredPort}-${currentPort} are all held or blocked by another program.`);
      console.error(`Find the owner with:  netstat -ano | findstr :${preferredPort}   then:  tasklist /fi "PID eq <pid>"`);
    }
    releaseInstanceLock();
    process.exit(1); // lingering unlistening helps nobody; start.bat surfaces the code
  });

  server.listen(currentPort, host, () => {
    listenerUp = true;
    console.log(`\n======================================================`);
    console.log(` Phone Parts POS & Repair System is LIVE (0 Dependencies)`);
    console.log(` Workstation URL: http://localhost:${currentPort}`);
    console.log(` Database: ${RUNTIME_DB_PATH}`);
    console.log(` Log: ${logFilePath()}`);
    console.log(`======================================================\n`);
    logLine(`Server listening on http://localhost:${currentPort} (db: ${RUNTIME_DB_PATH})`);

    // The previous update's helper wrote its milestones here; the swap outcome
    // is otherwise invisible (detached process, stdio ignored).
    consumeHandoffStatus(defaultUpdateStagingDir(serviceModeFromEnv()));

    // Hourly tick on the date-idempotent guard: a startup-only backup lets the
    // data-loss window grow with uptime on a workstation left running for days.
    // The getter, not the destructured db: /api/backup/restore swaps the handle
    // and a captured binding would snapshot a closed database forever after.
    runBackupTick(() => db, RUNTIME_DB_PATH);
    setInterval(() => runBackupTick(() => db, RUNTIME_DB_PATH), 60 * 60 * 1000).unref(); // never holds shutdown open

    try {
      if (process.platform === 'win32' && !process.env.NO_AUTO_BROWSER && !process.env.NO_LAUNCH_BROWSER) {
        launchBrowser(`http://localhost:${currentPort}`, (ok) => {
          // No browser means no heartbeat. Keep the watchdog armed only when
          // a browser window is actually on its way — otherwise the server
          // would die minutes in while the user stares at nothing.
          if (!ok && autoExitWatchdog) {
            clearInterval(autoExitWatchdog);
            autoExitWatchdog = null;
          }
        });
      }
    } catch (_) {}

    // Auto-exit watchdog: cleanly terminate background process when browser is
    // closed. Skipped when the operator chose headless mode (NO_AUTO_BROWSER)
    // — nobody will ever heartbeat by design in that mode.
    if (!process.env.NO_AUTO_EXIT && !isTestEnv() && !process.env.NO_AUTO_BROWSER) {
      if (autoExitWatchdog) clearInterval(autoExitWatchdog);
      autoExitWatchdog = setInterval(() => {
        // 180s before the first heartbeat: a cold machine can take a while to
        // paint the SPA, and a server killed too early presents to the
        // customer as "cannot connect". 120s afterwards covers a closed window.
        const maxSilenceMs = hasReceivedInitialHeartbeat ? 120000 : 180000;
        if (Date.now() - lastClientHeartbeat > maxSilenceMs) {
          logLine('Auto-exit: no client activity detected — shutting down.');
          releaseInstanceLock();
          process.exit(0);
        }
      }, 5000);
      if (autoExitWatchdog.unref) autoExitWatchdog.unref();
    }

    // Tests never hand off (the read is NODE_ENV=test-gated), so they should
    // not write the machine lock either — keeps %LOCALAPPDATA% clean.
    if (!isTestEnv()) {
      writeInstanceLock(currentPort);
      const isService = serviceModeFromEnv();
      if (isService) {
        writeRuntimeState(currentPort);
      }
    }
  });

  // Lock cleanup on every exit path (Ctrl+C, shutdown endpoint, taskkill of
  // the parent) so a stale lock never blocks the next start.
  process.on('exit', releaseInstanceLock);
  for (const sig of ['SIGINT', 'SIGBREAK', 'SIGTERM']) {
    try {
      process.on(sig, () => { releaseInstanceLock(); process.exit(0); });
    } catch (_) {}
  }

  return { server, db };
}

// Global safety crash handler to log and prevent silent exit.
// Pre-listener failures must EXIT, not linger: an exe that stays alive with
// nothing listening is a zombie the customer reads as "the app is running but
// won't connect" — the exact bug this file exists to avoid.
// Under node --test these land in the same per-process temp log as logLine, so
// a test-induced rejection does not drop pos-crash.log into the repo.
function crashFilePath() {
  if (process.env.NODE_TEST_CONTEXT || process.env.NODE_ENV === 'test') {
    return path.join(os.tmpdir(), `pos-crash-test-${process.pid}.log`);
  }
  return path.join(getBaseDir(), 'pos-crash.log');
}
process.on('uncaughtException', (err) => {
  console.error('\n[FATAL ERROR]', err);
  const detail = `[${new Date().toISOString()}] Uncaught Exception:\n${err.stack || err}\n\n`;
  try { fs.appendFileSync(logFilePath(), detail); } catch (_) {}
  try {
    fs.writeFileSync(crashFilePath(), detail, { flag: 'a' });
  } catch (_) {}
  if (!listenerUp) {
    releaseInstanceLock();
    process.exit(1);
  }
  console.log('\nAn unexpected error occurred. Check pos-crash.log for details.');
});

process.on('unhandledRejection', (reason) => {
  console.error('\n[UNHANDLED PROMISE REJECTION]', reason);
  const detail = `[${new Date().toISOString()}] Unhandled Rejection:\n${reason?.stack || reason}\n\n`;
  try { fs.appendFileSync(logFilePath(), detail); } catch (_) {}
  try {
    fs.writeFileSync(crashFilePath(), detail, { flag: 'a' });
  } catch (_) {}
  if (!listenerUp) {
    releaseInstanceLock();
    process.exit(1);
  }
});

// Requiring this module must never boot a server. Two entry points legitimately
// run it and start:
//   - `node src/server.js` (start.bat): require.main === module.
//   - the packaged single-file executable, where process.argv[1] is the .exe
//     path -- the same idiom scripts/generate-license.js uses for LicenseGenerator.exe.
// The old `!process.argv[1]` clause also matched `node -e`, `node -p` and the
// REPL, so any probe that only required this file booted a full server against
// the live data/shop.db, bound port 3000, ran today's backup and launched a
// browser. tests/server.test.js pins that requiring it as a non-main module
// starts nothing, binds no port and opens no database.
if (require.main === module || (process.argv[1] && process.argv[1].endsWith('.exe'))) {
  const mode = resolveLaunchMode();
  if (mode === 'launcher') {
    runInstalledLauncher().then((r) => {
      process.exitCode = (r && typeof r.exitCode === 'number') ? r.exitCode : 0;
    }).catch(() => {
      process.exitCode = 1;
    });
  } else if (mode === 'service') {
    if (!process.env.HOST) process.env.HOST = '127.0.0.1';
    process.env.NO_AUTO_BROWSER = '1';
    process.env.NO_AUTO_EXIT = '1';
    startServer(undefined, process.env.HOST);
  } else {
    if (!process.env.HOST) process.env.HOST = '0.0.0.0';
    if (!process.env.POS_LAN_REPORT_ACK) process.env.POS_LAN_REPORT_ACK = '1';
    startServer();
  }
}

module.exports = {
  createServer,
  startServer,
  createDbBackup,
  runDailyBackup,
  runBackupTick,
  verifyBackupFile,
  getBackupStatus,
  getShopSettings,
  updateShopSettings,
  prepareBrowserProfile,
  logFilePath,
  resolveLaunchMode,
  browserProfileDir,
  runtimeStatePath,
  runInstalledLauncher,
  isInstanceLockLive
};
