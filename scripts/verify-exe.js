const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = process.env.BUILD_OUTPUT_DIR || path.join(ROOT_DIR, 'dist');
const SEA_SENTINEL = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const MIN_EXE_BYTES = 1024 * 1024;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function inspectPe(buffer) {
  assert(Buffer.isBuffer(buffer) && buffer.length >= 64, 'file is too small for a PE header');
  assert(buffer.toString('ascii', 0, 2) === 'MZ', 'missing MZ signature');
  const peOffset = buffer.readUInt32LE(0x3c);
  assert(peOffset >= 64 && peOffset + 24 <= buffer.length, 'invalid PE header offset');
  assert(buffer.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0', 'missing PE signature');
  return { peOffset };
}

function containsSeaMarkers(buffer) {
  return buffer.indexOf(Buffer.from('NODE_SEA_BLOB')) !== -1 &&
    buffer.indexOf(Buffer.from(SEA_SENTINEL)) !== -1;
}

function listFilesRecursive(dir, predicate = () => true) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFilesRecursive(fullPath, predicate));
    else if (predicate(fullPath)) files.push(fullPath);
  }
  return files;
}

function newestMtime(files) {
  assert(files.length > 0, 'no build inputs found');
  return Math.max(...files.map(file => fs.statSync(file).mtimeMs));
}

function hashFile(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function snapshotPaths(paths) {
  const snapshot = new Map();
  for (const target of paths) {
    if (!fs.existsSync(target)) {
      snapshot.set(target, null);
      continue;
    }
    const files = fs.statSync(target).isDirectory() ? listFilesRecursive(target) : [target];
    snapshot.set(target, files.map(file => [path.relative(target, file), fs.statSync(file).size, fs.statSync(file).mtimeMs, hashFile(file)]));
  }
  return JSON.stringify([...snapshot.entries()]);
}

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function request(port, pathname, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: pathname, timeout: timeoutMs }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] || '' }));
    });
    req.once('timeout', () => req.destroy(new Error('request timeout')));
    req.once('error', reject);
  });
}

async function waitForReady(port, child, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`TechPartsPOS.exe exited early with code ${child.exitCode}`);
    try {
      const response = await request(port, '/');
      if (response.status === 200) return response;
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`readiness timeout after ${timeoutMs}ms`);
}

function terminateProcessTree(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let finished = false;
    const done = error => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    child.once('exit', () => done());
    const timer = setTimeout(() => {
      if (process.platform !== 'win32') {
        try { child.kill('SIGKILL'); } catch (_) {}
        done(new Error('process did not terminate in time'));
        return;
      }
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, error => {
        if (error && child.exitCode === null) done(error);
      });
    }, timeoutMs);
    try { child.kill('SIGTERM'); } catch (error) { done(error); }
  });
}

function runBounded(executable, args, options = {}, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { ...options, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`process timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function verifyArtifact(filePath) {
  assert(fs.existsSync(filePath), `${path.basename(filePath)} does not exist`);
  const stat = fs.statSync(filePath);
  assert(stat.size >= MIN_EXE_BYTES, `${path.basename(filePath)} is unexpectedly small`);
  const data = fs.readFileSync(filePath);
  inspectPe(data);
  assert(containsSeaMarkers(data), `${path.basename(filePath)} is missing SEA markers`);
  const manifestPath = `${filePath}.manifest.json`;
  assert(fs.existsSync(manifestPath), `${path.basename(filePath)} build manifest is missing`);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  verifyBuildManifest(filePath, manifest);
  return { size: stat.size, hash: hashBuffer(data), mtimeMs: stat.mtimeMs };
}

function verifyBuildManifest(filePath, manifest, postjectVersion = require('../node_modules/postject/package.json').version) {
  assert(manifest.artifact === path.basename(filePath), `${path.basename(filePath)} build manifest is invalid`);
  assert(manifest.node === process.version, `${path.basename(filePath)} was built with ${manifest.node}, not ${process.version}`);
  assert(manifest.postject === postjectVersion, `${path.basename(filePath)} postject version is stale`);
  const inputs = manifest.inputs.map(file => path.join(ROOT_DIR, file));
  assert(inputs.every(file => fs.existsSync(file)), `${path.basename(filePath)} build input is missing`);
  const inputMtime = newestMtime(inputs);
  assert(fs.statSync(filePath).mtimeMs >= inputMtime, `${path.basename(filePath)} is stale`);
  assert(fs.statSync(`${filePath}.manifest.json`).mtimeMs >= inputMtime, `${path.basename(filePath)} build manifest is stale`);
}

function pass(stage, evidence) {
  console.log(`PASS ${stage}: ${evidence}`);
}

async function main() {
  let tempDir;
  let appChild;
  let failure;
  const livePaths = [
    path.join(ROOT_DIR, 'data'),
    path.join(ROOT_DIR, 'backups'),
    path.join(DIST_DIR, 'data'),
    path.join(DIST_DIR, 'backups'),
    path.join(ROOT_DIR, 'vendor-private-key.pem'),
    path.join(DIST_DIR, 'vendor-private-key.pem')
  ];
  const liveBefore = snapshotPaths(livePaths);
  try {
    for (const name of ['TechPartsPOS.exe', 'LicenseGenerator.exe']) {
      const result = verifyArtifact(path.join(DIST_DIR, name));
      pass(`artifact/${name}`, `size=${result.size} sha256=${result.hash} fresh=true MZ=true PE=true SEA=true`);
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'techparts-pos-verify-'));
    const dbPath = path.join(tempDir, 'data', 'shop.db');
    const backupDir = path.join(tempDir, 'backups');
    const port = await reservePort();
    appChild = spawn(path.join(DIST_DIR, 'TechPartsPOS.exe'), [], {
      cwd: tempDir,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), POS_DB_PATH: dbPath, POS_BACKUP_DIR: backupDir, NO_AUTO_BROWSER: '1', NODE_ENV: 'test' }
    });
    await waitForReady(port, appChild);
    const checks = [
      ['root', '/', response => response.status === 200 && /<!doctype html/i.test(response.body)],
      ['module', '/js/main.js', response => response.status === 200 && /javascript/i.test(response.type)],
      ['license', '/api/license/status', response => response.status === 200 && /machine_id/.test(response.body)],
      ['auth', '/api/auth/session', response => response.status === 401 && /Invalid session/.test(response.body)]
    ];
    for (const [name, pathname, validate] of checks) {
      const response = await request(port, pathname);
      assert(validate(response), `${name} endpoint returned unexpected response (${response.status})`);
      pass(`endpoint/${name}`, `GET ${pathname} status=${response.status}`);
    }
    assert(fs.existsSync(dbPath), 'isolated smoke database was not created');
    pass('isolation', `db=${dbPath} backup=${backupDir} loopback=127.0.0.1 port=${port}`);

    const cliTemp = fs.mkdtempSync(path.join(tempDir, 'license-cli-'));
    // 30s, not 5s: the first run of a freshly built 92MB unsigned exe can sit
    // in Windows Defender's scan for tens of seconds, which killed this smoke
    // step on every release build until the timeout learned that.
    const cli = await runBounded(path.join(DIST_DIR, 'LicenseGenerator.exe'), ['--help'], {
      cwd: cliTemp,
      env: { ...process.env, TP_LICENSE_KEY_FILE: path.join(cliTemp, 'missing-private-key.pem') }
    }, 30000);
    assert(cli.code === 0 && /Usage: LicenseGenerator\.exe/.test(cli.stdout),
      `LicenseGenerator.exe --help failed: exit=${cli.code} stdout=${JSON.stringify(cli.stdout.slice(0, 200))} stderr=${JSON.stringify(cli.stderr.slice(0, 200))}`);
    assert(!fs.existsSync(path.join(cliTemp, 'missing-private-key.pem')), 'license help created a private key');
    pass('license-cli', '--help exit=0 private-key-read=false private-key-created=false');
  } catch (error) {
    failure = error;
    console.error(`FAIL ${error.message}`);
  } finally {
    try {
      await terminateProcessTree(appChild);
      pass('cleanup/process', 'exact spawned process tree terminated');
    } catch (error) {
      failure ||= error;
      console.error(`FAIL cleanup/process: ${error.message}`);
    }
    try {
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      assert(!tempDir || !fs.existsSync(tempDir), 'temporary directory remains');
      pass('cleanup/files', 'temporary files removed');
    } catch (error) {
      failure ||= error;
      console.error(`FAIL cleanup/files: ${error.message}`);
    }
    try {
      assert(snapshotPaths(livePaths) === liveBefore, 'live data, backups, or vendor private key changed during verification');
      pass('no-live-data-contamination', 'live data, backups, and vendor key unchanged');
    } catch (error) {
      failure ||= error;
      console.error(`FAIL no-live-data-contamination: ${error.message}`);
    }
  }
  if (failure) throw failure;
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = {
  inspectPe,
  containsSeaMarkers,
  listFilesRecursive,
  newestMtime,
  snapshotPaths,
  verifyArtifact,
  verifyBuildManifest,
  reservePort,
  request
};
