// One name shape on write. Reads compare with the namefold() collation helper
// below, so a stored spelling can never split one person's debt in two.

// Unicode-aware case folding for customer names. SQLite's COLLATE NOCASE and
// lower() fold ASCII only, so 'Muñoz' and 'MUÑOZ' (common in Filipino names)
// counted as two debtors: one person's utang split across two rows, the
// variants review list (built on lower()) never surfaced the pair, and a
// diacritic name re-cased walked past the credit-limit sum in src/sales.js.
// NFC first, so a combining tilde compares equal to a composed one.
function foldName(name) {
  return String(name ?? '').normalize('NFC').toLowerCase();
}

function cleanName(name, fallback = '') {
  const s = String(name ?? '').normalize('NFC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return s || fallback;
}

// The SQL twin of foldName, registered on the node:sqlite handle on first use.
// Every query that groups or matches names uses namefold(expr) when the runtime
// offers db.function() (Node 23.5+/22.13+), and degrades to lower() on older
// runtimes instead of failing outright: lower() is exactly the ASCII-only
// behaviour this replaces, so a degraded runtime gets the old behaviour, never
// an error -- but the split-debtor hole from the diacritic fix quietly returns,
// so the first degraded use says so out loud.
const foldRegistered = new WeakSet();
let foldDegradedLogged = false;
function foldSql(db, expr) {
  if (db && typeof db.function === 'function') {
    if (!foldRegistered.has(db)) {
      db.function('namefold', (v) => foldName(v == null ? '' : String(v)));
      foldRegistered.add(db);
    }
    return `namefold(${expr})`;
  }
  if (!foldDegradedLogged) {
    foldDegradedLogged = true;
    console.error(`[names] db.function is unavailable on this Node ${process.version}; name matching falls back to ASCII-only lower(), so diacritic names can split debts again (needs Node 22.13+ or 23.5+)`);
  }
  return `LOWER(${expr})`;
}

module.exports = { cleanName, foldName, foldSql };
