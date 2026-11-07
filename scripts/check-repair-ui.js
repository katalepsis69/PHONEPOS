// Run manually: node scripts/check-repair-ui.js. Uses a temporary DB and Edge profile.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { createServer } = require('../src/server');
const pause = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-ui-'));
  const { server, db } = createServer({ dbPath: path.join(temp, 'test.db') });
  let edge, ws;
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const url = process.env.REPAIR_UI_URL || `http://127.0.0.1:${server.address().port}`;
    await fetch(url + '/styles.css');
    edge = spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
      '--headless=new', '--remote-debugging-port=0', '--no-first-run',
      '--user-data-dir=' + temp, url
    ], { stdio: 'ignore' });
    let port;
    for (let i = 0; i < 100; i++) {
      try { port = fs.readFileSync(path.join(temp, 'DevToolsActivePort'), 'utf8').split('\n')[0]; break; }
      catch { await pause(100); }
    }
    assert.ok(port, 'Edge debugging port available');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    ws = new WebSocket(pages.find(p => p.type === 'page').webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0;
    const pending = new Map();
    ws.onmessage = event => {
      const msg = JSON.parse(event.data);
      if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    };
    const send = async (method, params = {}) => {
      const n = ++id;
      const reply = new Promise(resolve => pending.set(n, resolve));
      ws.send(JSON.stringify({ id: n, method, params }));
      const msg = await reply;
      if (msg.error) throw Error(JSON.stringify(msg.error));
      return msg.result;
    };
    const evaluate = async expression => {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      return r.result.value;
    };
    await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await pause(1800);
    // ponytail: visual fixture only; hides gates in this isolated browser, never changes production auth.
    await evaluate(`(async () => {
      const { S } = await import('/js/state.js');
      const { applyAppearance } = await import('/js/theme.js');
      const { renderPartsTable } = await import('/js/views/pos.js');
      S.posCatalog = []; S.inventoryItems = []; S.cart = [];
      applyAppearance({mode:'light',accent:'rose',fontScale:'1',density:'cozy',numFont:'mono'});
      renderPartsTable();
      document.querySelectorAll('body > div:not(.app)').forEach(e => e.style.display='none');
      document.querySelectorAll('[inert]').forEach(e => e.inert=false);
    })()`);
    await pause(400);
    const output = path.resolve(__dirname, '../gui-test-screenshots/repair-light-verified.png');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, Buffer.from((await send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
    const metrics = await evaluate(`(() => {
      const intake = document.querySelector('.intake-bar');
      const shelf = document.querySelector('.shelf-panel');
      const foot = shelf.querySelector('.parts-foot');
      const r = e => e.getBoundingClientRect();
      return { intake: getComputedStyle(intake).backgroundColor,
        surface: getComputedStyle(shelf).backgroundColor,
        shelfWidth:r(shelf).width, intakeWidth:r(intake).width,
        bottomGap:r(document.querySelector('.counter__side')).bottom-r(shelf).bottom,
        shelfHeight:r(shelf).height, footerGap:r(shelf).bottom-r(foot).bottom,
        empty:document.querySelector('#pos-parts-body').textContent.trim() };
    })()`);
    console.log(JSON.stringify(metrics, null, 2));
    assert.equal(metrics.intake, 'rgb(255, 255, 255)', 'light intake is white, not navy');
    assert.equal(metrics.intake, metrics.surface, 'intake follows the panel surface');
    assert.ok(Math.abs(metrics.shelfWidth - metrics.intakeWidth) < 2, 'empty shelf retains full width');
    assert.ok(metrics.footerGap < 25, 'no blank region below footer');
    assert.ok(Math.abs(metrics.bottomGap) < 2, 'parts panel fills height to the summary bottom edge');
    assert.match(metrics.empty, /No parts in inventory yet/);
    console.log('PASS Repair light-mode browser checks. Screenshot: ' + output);
    await evaluate(`(async () => {
      const { applyAppearance } = await import('/js/theme.js');
      applyAppearance({mode:'dark',accent:'rose',fontScale:'1',density:'cozy',numFont:'mono'});
    })()`);
    await pause(400);
    const dark = await evaluate(`({
      intake:getComputedStyle(document.querySelector('.intake-bar')).backgroundColor,
      surface:getComputedStyle(document.querySelector('.shelf-panel')).backgroundColor
    })`);
    assert.equal(dark.intake, dark.surface, 'dark intake follows dark surface');
    assert.notEqual(dark.intake, metrics.intake, 'theme switch changes intake');
    fs.writeFileSync(output.replace('-light-', '-dark-'), Buffer.from((await send('Page.captureScreenshot', {format:'png'})).data, 'base64'));
    console.log('PASS Repair dark-mode intake: ' + dark.intake);
  } finally {
    if (ws?.readyState === WebSocket.OPEN) ws.close();
    if (edge) edge.kill();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
    db.close();
    await pause(700);
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
