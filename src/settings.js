// src/settings.js
// Shop settings read/write. Private keys never leave the server, and only
// the editable whitelist can be written.
const dns = require('node:dns');
const PRIVATE_SETTINGS = new Set([
  'manager_pin_hash', 'license_key', 'pin_failed_attempts', 'pin_lockout_until',
  'report_pin_failed_attempts', 'report_pin_lockout_until',
  'recovery_password_hash', 'recovery_failed_attempts', 'recovery_lockout_until',
  'report_token', 'report_token_expires_at', 'counter_session_secret', 'sync_token'
]);

function getShopSettings(db) {
  const rows = db.prepare('SELECT key, value FROM shop_settings').all();
  const settings = {};
  for (const r of rows) {
    if (PRIVATE_SETTINGS.has(r.key)) continue;
    settings[r.key] = r.value;
  }
  return settings;
}

const EDITABLE_SETTINGS = new Set([
  'gcash_name', 'gcash_number', 'gcash_qr_url', 'receipt_paper_width', 'printer_name',
  // Template + item rows are validated by the route (server.js) before this
  // whitelist runs; missing them made updateShopSettings throw on every save
  // the Printing pane sent, so no choice (and nothing else in the form) stuck.
  'receipt_template', 'receipt_item_rows',
  'warranty_days', 'warranty_policy_text', 'shop_footer_note',
  'owner_name', 'shop_address', 'settle_elevation_threshold', 'shift_variance_threshold',
  'default_retail_markup_pct', 'default_wholesale_markup_pct',
  'business_type', 'enable_service_bench', 'enable_fractional_qty', 'enable_serial_tracking',
  'wholesale_tier_label'
]);

function getDefaultRetailMarkup(db) {
  const raw = db.prepare("SELECT value FROM shop_settings WHERE key = 'default_retail_markup_pct'").get()?.value;
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

function getDefaultWholesaleMarkup(db) {
  const raw = db.prepare("SELECT value FROM shop_settings WHERE key = 'default_wholesale_markup_pct'").get()?.value;
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 20;
}

// Collections above this amount need a manager; below it a cashier may take
// the payment. Read with a guard so a hand-edited row cannot disable the gate.
function getSettleElevationThreshold(db) {
  const raw = db.prepare("SELECT value FROM shop_settings WHERE key = 'settle_elevation_threshold'").get()?.value;
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 500;
}

// Same guarded pattern for the shift-variance materiality line the exceptions
// report flags at; 50 was hardcoded in the query before this existed.
function getShiftVarianceThreshold(db) {
  const raw = db.prepare("SELECT value FROM shop_settings WHERE key = 'shift_variance_threshold'").get()?.value;
  const n = raw == null || String(raw).trim() === '' ? NaN : Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

function updateShopSettings(db, key, value) {
  if (PRIVATE_SETTINGS.has(key)) {
    throw new Error(`Setting '${key}' cannot be changed here`);
  }
  if (!EDITABLE_SETTINGS.has(key)) {
    throw new Error(`Unknown setting '${key}'`);
  }
  db.prepare('INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run(key, value);
}

const SYNC_SETTINGS = new Set(['sync_url', 'sync_token']);
// ponytail: block SSRF — sync target POSTs shop rows, so an attacker-controlled
// sync_url could exfiltrate DB. Empty string disables sync; otherwise require https
// and reject private/link-local/metadata hosts.
function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase();
  return h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')
    || /^127\./.test(h) || h.startsWith('10.') || h.startsWith('192.168.') || h.startsWith('169.254.')
    || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h);
}
function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}
function validateSyncUrl(raw) {
  const v = String(raw || '').trim();
  if (!v) return;
  let parsed;
  try { parsed = new URL(v); } catch { throw new Error('sync_url must be a valid URL'); }
  const h = parsed.hostname.toLowerCase();
  const loopback = isLoopbackHost(h);
  if (!loopback && parsed.protocol !== 'https:') throw new Error('sync_url must be https');
  if (!loopback && (h.endsWith('.local') || h.endsWith('.internal')
    || isPrivateIp(h)
    || h === 'metadata.google.internal')) {
    throw new Error('sync_url host not allowed (private/local address)');
  }
}
// Save-time only, and never called by the drain: a public hostname that
// resolves into a private range is the SSRF shape string checks cannot see.
// A failed lookup warns instead of blocking (transient DNS must not stop a
// legitimate save), and the drain gains no new failure mode.
async function validateSyncUrlHost(raw) {
  const v = String(raw || '').trim();
  if (!v) return null;
  let h;
  try { h = new URL(v).hostname.toLowerCase(); } catch { return null; }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') || h === 'localhost') return null; // literals: validateSyncUrl already ruled
  let addrs;
  try {
    addrs = await dns.promises.lookup(h, { all: true });
  } catch (_) {
    return `sync_url host "${h}" could not be resolved right now; saved, but the shop will not reach it until DNS works`;
  }
  if (addrs.some(a => isPrivateIp(a.address))) {
    try {
      await dns.promises.resolve(h);
    } catch (_) {
      // Any confirm-leg failure counts as "could not confirm", EAI_AGAIN and
      // friends included: a lookup that answered a private address while the
      // direct A query fails is the transient-resolver shape the comment above
      // says must not block the save.
      return `sync_url host "${h}" could not be resolved right now; saved, but the shop will not reach it until DNS works`;
    }
    throw new Error(`sync_url host "${h}" resolves to a private address, which is not allowed`);
  }
  return null;
}
function updateSyncSetting(db, key, value) {
  if (!SYNC_SETTINGS.has(key)) throw new Error(`Unknown sync setting '${key}'`);
  if (key === 'sync_url') validateSyncUrl(value);
  db.prepare('INSERT OR REPLACE INTO shop_settings (key, value) VALUES (?, ?)').run(key, String(value));
}

module.exports = {
  getDefaultRetailMarkup,
  getDefaultWholesaleMarkup,
  getSettleElevationThreshold,
  getShiftVarianceThreshold,
  getShopSettings,
  updateShopSettings,
  updateSyncSetting,
  validateSyncUrl,
  validateSyncUrlHost,
  PRIVATE_SETTINGS,
  EDITABLE_SETTINGS
};
