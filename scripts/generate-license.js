// phone-repair-pos/scripts/generate-license.js
// Vendor CLI & Interactive Generator. Requires the private key, so it must never ship to customers.
//   node scripts/generate-license.js --init
//   node scripts/generate-license.js --machine TP-WIN-XXXX-XXXX --name "Shop Name" [--days 365]
//   node scripts/generate-license.js --list
//   Or run without flags for interactive prompts.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { spawnSync } = require('node:child_process');
const { parseArgs } = require('node:util');
const { verifyLicenseKey, getMachineId, publicKey } = require('../src/license');

const BASE_DIR = process.execPath && !process.execPath.toLowerCase().endsWith('node.exe')
  ? path.dirname(process.execPath)
  : path.join(__dirname, '..');

// The app only ever shows uppercase TP-XXX-XXXX-XXXX ids (src/license.js), so
// whatever casing or dash characters reach this tool are normalized first.
const MACHINE_ID_RE = /^TP-(WIN|LIN|DAR)-[0-9A-F]{4}-[0-9A-F]{4}$/;

function normalizeMachineId(raw) {
  return String(raw).trim().replace(/[–—]/g, '-').toUpperCase();
}

function findKeyFile() {
  // Env var wins even when the file does not exist yet: --init creates the
  // keypair exactly where it points instead of falling back to a default.
  if (process.env.TP_LICENSE_KEY_FILE) return process.env.TP_LICENSE_KEY_FILE;
  const candidates = [
    path.join(BASE_DIR, 'vendor-private-key.pem'),
    path.join(BASE_DIR, '..', 'vendor-private-key.pem'),
    path.join(os.homedir(), '.techparts', 'vendor-private-key.pem'),
    path.join(process.cwd(), 'vendor-private-key.pem')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(BASE_DIR, 'vendor-private-key.pem');
}

function loadPrivateKey(file) {
  return crypto.createPrivateKey(fs.readFileSync(file, 'utf8'));
}

// First 8 bytes of SHA-256 over the public half; enough to compare by eye.
function publicKeyDer(privateKey) {
  return crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
}

function fingerprint(privateKey) {
  return crypto.createHash('sha256').update(publicKeyDer(privateKey)).digest('hex').toUpperCase().slice(0, 16).match(/../g).join(':');
}

function matchesShippedBuild(privateKey) {
  return publicKeyDer(privateKey).equals(publicKey().export({ type: 'spki', format: 'der' }));
}

function planFromDays(days) {
  return days === 0 ? 'lifetime' : days <= 45 ? 'monthly' : 'yearly';
}

function expiresFromDays(days) {
  return days > 0 ? new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().split('T')[0] : '';
}

function generateLicenseKey({ machine_id, plan_type = 'lifetime', expires_at = '', customer_name = '' }, privateKey) {
  if (!privateKey) throw new Error('generateLicenseKey requires the vendor private key');
  const payload = JSON.stringify({ machine_id, plan_type, expires_at, customer_name });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signature = crypto.sign(null, Buffer.from(payloadB64), privateKey).toString('base64url');
  return `${payloadB64}.${signature}`;
}

function ask(rl, query) {
  return new Promise(resolve => {
    rl.question(query, answer => resolve(answer.trim()));
  });
}

function parseDuration(value) {
  if (value === undefined || value === null) return 0;
  if (!/^\d+$/.test(String(value))) throw new Error('Validity days must be a non-negative whole number. Use 0 for lifetime.');
  const days = Number(value);
  // A value whose millisecond total leaves the Date range crashed toISOString
  // with a raw stack; a century is already past any subscription anyone sells.
  if (days > 36500) throw new Error('Validity days are too large; cap a subscription at 36500 days.');
  if (!Number.isSafeInteger(days)) throw new Error('Validity days are too large.');
  return days;
}

// Append-only record next to the private key. The console scrollback is not a
// safe place to keep the only copy of a paid key.
function ledgerPathFor(keyFile) {
  return path.join(path.dirname(keyFile), 'licenses-issued.jsonl');
}

function recordIssuance(ledgerFile, entry) {
  fs.appendFileSync(ledgerFile, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

function listIssued(ledgerFile) {
  if (!fs.existsSync(ledgerFile)) {
    console.log('No issued licenses recorded yet.');
    console.log('Every key you mint is appended to: ' + ledgerFile);
    return;
  }
  const rows = [];
  for (const line of fs.readFileSync(ledgerFile, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (_) {}
  }
  console.log(`Issued licenses (${rows.length}) — ${ledgerFile}`);
  for (const r of rows) {
    const customer = String(r.customer_name || '').slice(0, 24).padEnd(24);
    const flag = r.verified === false ? '  [UNVERIFIED]' : '';
    console.log(`${String(r.issued_at || '').slice(0, 10)}  ${String(r.machine_id || '').padEnd(17)} ${customer} ${String(r.plan_type || '').padEnd(8)} ${r.expires_at || 'lifetime'}${flag}`);
  }
}

function issueLicense({ machineId, customerName, days, privateKey, ledgerFile }) {
  const planType = planFromDays(days);
  const expiresAt = expiresFromDays(days);
  const key = generateLicenseKey(
    { machine_id: machineId, plan_type: planType, expires_at: expiresAt, customer_name: customerName },
    privateKey
  );
  const verification = verifyLicenseKey(key, machineId, publicKey());
  const record = {
    issued_at: new Date().toISOString(),
    machine_id: machineId,
    customer_name: customerName,
    plan_type: planType,
    expires_at: expiresAt,
    verified: verification.valid,
    license_key: key
  };
  // A paid key that exists only in console scrollback is not a record. Try the
  // ledger, spill to a fallback file beside it, and refuse to hand out the key
  // if neither write lands.
  try {
    recordIssuance(ledgerFile, record);
  } catch (err) {
    const fallback = `${ledgerFile}.fallback`;
    try {
      recordIssuance(fallback, record);
      console.warn(`⚠ Could not write ${ledgerFile} (${err.message}); the issuance went to ${fallback} instead. Merge it into the ledger.`);
    } catch (fallbackErr) {
      throw new Error(`Could not record this issuance in ${ledgerFile} (${err.message}) nor ${fallback} (${fallbackErr.message}). Fix the disk and re-run; no key was handed out.`);
    }
  }
  return { key, planType, expiresAt, verification };
}

function copyToClipboard(text) {
  try {
    const cmd = process.platform === 'win32' ? 'clip' : process.platform === 'darwin' ? 'pbcopy' : 'wl-copy';
    return spawnSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] }).status === 0;
  } catch (_) {
    return false;
  }
}

// Returns true when a keypair was created. Callers handle the "already exists" refusal.
function createKeypair(keyFile) {
  if (fs.existsSync(keyFile)) {
    console.error(`Refusing to overwrite ${keyFile}.`);
    console.error('Every license you have already issued was signed by it; delete it by hand only if');
    console.error('you intend to invalidate all of them.');
    return false;
  }
  const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(keyFile), { recursive: true });
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const pubB64 = pub.export({ type: 'spki', format: 'der' }).toString('base64');

  console.log('\nNew vendor keypair generated.');
  console.log(`Private key: ${keyFile}`);
  console.log(`Fingerprint: ${fingerprint(privateKey)}`);
  console.log('  Back this file up offline NOW. Losing it means you can never issue a key again.');
  console.log('  Leaking it means anyone can. Never commit it, never ship it.');
  console.log('  A new keypair also voids every license issued under the old one.');
  console.log('\nPaste this into VENDOR_PUBLIC_KEY_B64 in src/license.js, then rebuild both exes:\n');
  console.log(`const VENDOR_PUBLIC_KEY_B64 = '${pubB64}';\n`);
  return true;
}

async function runInteractive(keyFile) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  console.log('======================================================');
  console.log('   TechParts POS - Vendor License Key Generator');
  console.log('======================================================');
  console.log('This Machine ID: ' + getMachineId());

  let privateKey;
  if (!fs.existsSync(keyFile)) {
    console.log('❌ No vendor private key at:');
    console.log('   ' + keyFile);
    console.log('\nSearched next to the exe, its parent folder, %USERPROFILE%\\.techparts,');
    console.log('and the current directory. You can also point TP_LICENSE_KEY_FILE at the pem.');
    console.log('\nIf you have issued licenses before: restore your backed-up vendor-private-key.pem.');
    console.log('Do NOT create a new keypair, it voids every key you already issued.');
    const make = (await ask(rl, '\nBrand-new vendor setup: create a new keypair now? (y/N): ')).toLowerCase();
    if (make !== 'y' && make !== 'yes') {
      await ask(rl, 'Press Enter to exit...');
      rl.close();
      return;
    }
    if (!createKeypair(keyFile)) {
      await ask(rl, 'Press Enter to exit...');
      rl.close();
      return;
    }
  }

  try {
    privateKey = loadPrivateKey(keyFile);
  } catch (err) {
    console.log('❌ The private key file could not be read: ' + err.message);
    await ask(rl, 'Press Enter to exit...');
    rl.close();
    return;
  }

  console.log('Private Key:     ' + keyFile);
  console.log('Fingerprint:     ' + fingerprint(privateKey));
  if (matchesShippedBuild(privateKey)) {
    console.log('Key match:       matches the key baked into this build');
  } else {
    console.log('⚠ Key match:     DOES NOT match VENDOR_PUBLIC_KEY_B64 in this build.');
    console.log('  Keys minted here will NOT activate. Update src/license.js and rebuild,');
    console.log('  or this pem is not the key this build was made with.');
  }
  console.log('======================================================\n');

  while (true) {
    console.log('--- Generate Client License ---');
    const machineId = normalizeMachineId(await ask(rl, 'Client Machine ID (e.g. TP-WIN-XXXX-XXXX): '));
    if (!machineId) {
      console.log('⚠️ Machine ID cannot be empty.\n');
      continue;
    }
    if (!MACHINE_ID_RE.test(machineId)) {
      console.log(`⚠ "${machineId}" does not look like a TechParts Machine ID.`);
      console.log('  It must read TP-WIN-XXXX-XXXX exactly as shown on the app activation screen.');
      const force = (await ask(rl, 'Issue for this ID anyway? (y/N): ')).toLowerCase();
      if (force !== 'y' && force !== 'yes') continue;
    }

    let customerName = await ask(rl, 'Customer / Shop Name [Default: Customer]: ');
    if (!customerName) customerName = 'Customer';

    const daysStr = await ask(rl, 'Validity in Days [0 for Lifetime]: ');
    let days;
    try {
      days = parseDuration(daysStr);
    } catch (error) {
      console.log(`Error: ${error.message}\n`);
      continue;
    }

    try {
      const { key, planType, expiresAt, verification } = issueLicense({
        machineId, customerName, days, privateKey, ledgerFile: ledgerPathFor(keyFile)
      });

      console.log('\n======================================================');
      console.log('🎉 LICENSE KEY GENERATED SUCCESSFULLY:');
      console.log('------------------------------------------------------');
      console.log('Machine ID:    ' + machineId);
      console.log('Customer:      ' + customerName);
      console.log('Plan:          ' + planType);
      if (expiresAt) console.log('Expires:       ' + expiresAt);
      console.log('------------------------------------------------------');
      console.log('LICENSE KEY (Copy below):');
      console.log(key);
      console.log('------------------------------------------------------');
      console.log('Verification:  ' + (verification.valid ? 'VALID' : 'INVALID: ' + verification.error));
      if (copyToClipboard(key)) console.log('(Key copied to the clipboard.)');
      console.log('Recorded to:   ' + ledgerPathFor(keyFile));
      console.log('======================================================\n');
    } catch (err) {
      console.error('❌ Error: ' + err.message + '\n');
    }

    const again = await ask(rl, 'Generate another license? (y/N): ');
    if (again.toLowerCase() !== 'y' && again.toLowerCase() !== 'yes') {
      break;
    }
    console.log('\n');
  }

  await ask(rl, 'Press Enter to exit...');
  rl.close();
}

async function runCli() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: 'boolean', short: 'h' },
        init: { type: 'boolean' },
        list: { type: 'boolean' },
        machine: { type: 'string' },
        name: { type: 'string', default: 'Customer' },
        days: { type: 'string' }
      },
      strict: true,
      allowPositionals: false
    }));
  } catch (error) {
    console.error(`Invalid arguments: ${error.message}`);
    console.error('Run with --help for usage.');
    process.exitCode = 1;
    return;
  }

  if (values.help) {
    console.log('Usage: LicenseGenerator.exe --machine ID [--name NAME] [--days DAYS]');
    console.log('       LicenseGenerator.exe --list');
    console.log('       LicenseGenerator.exe --init');
    console.log('Options: --help, --init, --list, --machine, --name, --days');
    return;
  }

  const KEY_FILE = findKeyFile();

  if (values.init && (values.machine || values.days !== undefined || values.name !== 'Customer')) {
    console.error('--init cannot be combined with --machine, --name, or --days.');
    process.exitCode = 1;
    return;
  }

  if (!values.machine && (values.days !== undefined || values.name !== 'Customer')) {
    console.error('--name and --days require --machine.');
    process.exitCode = 1;
    return;
  }

  if (values.init) {
    process.exitCode = createKeypair(KEY_FILE) ? 0 : 1;
    return;
  }

  if (values.list) {
    listIssued(ledgerPathFor(KEY_FILE));
    return;
  }

  const machineId = normalizeMachineId(values.machine || '');
  if (!machineId) {
    // If no CLI args passed, run interactive mode so double-clicking .exe does not auto-exit!
    await runInteractive(KEY_FILE);
    return;
  }
  if (!MACHINE_ID_RE.test(machineId)) {
    console.error(`⚠ Warning: "${machineId}" does not match the TP-WIN-XXXX-XXXX format the app displays.`);
  }

  let days;
  try {
    days = parseDuration(values.days);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(KEY_FILE)) {
    console.error(`No vendor private key at ${KEY_FILE}.`);
    console.error('Restore your backed-up vendor-private-key.pem (or set TP_LICENSE_KEY_FILE).');
    console.error('If you have NEVER issued a license, create a keypair: LicenseGenerator.exe --init');
    process.exit(1);
  }
  let privateKey;
  try {
    privateKey = loadPrivateKey(KEY_FILE);
  } catch (err) {
    console.error(`The private key file could not be read: ${err.message}`);
    process.exit(1);
  }

  const customerName = values.name || 'Customer';
  const { key, planType, expiresAt, verification } = issueLicense({
    machineId, customerName, days, privateKey, ledgerFile: ledgerPathFor(KEY_FILE)
  });

  console.log('');
  console.log('=== LICENSE KEY GENERATED ===');
  console.log('Machine ID:    ' + machineId);
  console.log('Customer:      ' + customerName);
  console.log('Plan:          ' + planType);
  if (expiresAt) console.log('Expires:       ' + expiresAt);
  console.log('');
  console.log('LICENSE KEY:');
  console.log(key);
  console.log('');
  console.log('Recorded to:   ' + ledgerPathFor(KEY_FILE));
  console.log('Verification:  ' + (verification.valid ? 'VALID' : 'INVALID'));
  if (!verification.valid) {
    console.error(`\nThis key will NOT activate: ${verification.error}`);
    console.error('The private key does not match VENDOR_PUBLIC_KEY_B64 in the current build.');
    process.exit(1);
  }
}

if (require.main === module || (process.argv[1] && process.argv[1].endsWith('.exe'))) {
  runCli().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { generateLicenseKey, parseDuration, runCli, normalizeMachineId, planFromDays, MACHINE_ID_RE, fingerprint, matchesShippedBuild, issueLicense, listIssued, createKeypair };
