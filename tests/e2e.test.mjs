// Browser smoke test: the real page in headless Chrome, driven over the DevTools protocol (no
// dependencies). Opt-in locally with SPG_E2E=1 (CI sets it); it needs Chrome or Chromium.
//
// It runs offline and deterministically: the basemap is "None" and every geo.admin.ch request is
// answered with 503, which also exercises the app's fallbacks (no commune name, no terrain).

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';

const WEB = path.resolve(import.meta.dirname, '..', 'web');
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
const skip = !process.env.SPG_E2E ? 'set SPG_E2E=1 to run (needs Chrome)' : !CHROME ? 'Chrome not found (set CHROME)' : false;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('browser smoke test', { skip, timeout: 240_000 }, () => {
  let server, chrome, profile, base, page;

  before(async () => {
    server = http.createServer((req, res) => { // static files, like GitHub Pages
      const file = path.join(WEB, decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
      if (!file.startsWith(WEB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404).end(); return; }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
      fs.createReadStream(file).pipe(res);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}/`;

    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'spg-e2e-'));
    chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run',
      '--no-default-browser-check', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars',
      ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), 'about:blank'], { stdio: 'ignore' });
    let port;
    for (let i = 0; i < 100 && !port; i++) {
      await sleep(100);
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
    }
    assert.ok(port, 'Chrome did not start');
    page = await openPage(port);
  });

  after(async () => {
    page?.ws.close();
    chrome?.kill();
    server?.close();
    await sleep(300);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold files */ }
  });

  async function load(width, height, mobile) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile });
    page.errors.length = 0;
    await page.send('Page.navigate', { url: base });
    assert.ok(await page.waitFor(`!document.getElementById('loading') && document.querySelectorAll('#legend button').length > 0`, 90_000),
      `page did not load: ${await page.ev(`document.getElementById('loading-msg')?.textContent`)}`);
  }

  test('desktop: loads, every control works, no errors', async () => {
    await load(1280, 800, false);
    const ev = page.ev;
    assert.equal(await ev(`document.title`), 'Swiss atlas – population and mobile antennas');
    assert.match(await ev(`document.getElementById('subtitle').textContent`), /31 Dec 2024/);
    const residents = Number((await ev(`document.getElementById('kpi-view').textContent`)).replace(/\D/g, ''));
    assert.ok(residents > 9_000_000 && residents <= 9_123_704, `residents in view ${residents}`); // first view: all of Switzerland
    assert.equal(await ev(`document.querySelectorAll('#legend button.legend-row').length`), 7);

    // every colour metric, and a raw attribute both ways
    const metrics = await ev(`[...document.getElementById('metric').options].map((o) => o.value)`);
    assert.ok(metrics.length >= 20);
    for (const m of metrics) {
      await ev(`(() => { const s = document.getElementById('metric'); s.value = '${m}'; s.dispatchEvent(new Event('change')); })()`);
      assert.ok(await ev(`document.querySelectorAll('#legend .legend-row').length >= 1`), `legend for ${m}`);
    }
    await ev(`document.querySelector('[data-raw-mode="count"]').click()`);
    await ev(`(() => { const s = document.getElementById('raw-col'); s.value = 'HPTOT'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await ev(`document.getElementById('legend').textContent.includes('Under')`));

    // antenna filters and the distance metric: none matching, then back
    await ev(`(() => { const s = document.getElementById('metric'); s.value = 'dist'; s.dispatchEvent(new Event('change')); })()`);
    await ev(`[...document.querySelectorAll('#ant-ops input')].forEach((c) => { if (c.checked) c.click(); })`);
    assert.equal(await ev(`document.getElementById('kpi-ant').textContent`), '0');
    assert.match(await ev(`document.getElementById('legend').textContent`), /No value/);
    await ev(`[...document.querySelectorAll('#ant-ops input')].slice(0, 3).forEach((c) => c.click())`);
    assert.match(await ev(`document.getElementById('legend').textContent`), /Under \d+ m/);

    // analysis panel
    await ev(`document.getElementById('open-analysis').click()`);
    assert.equal(await ev(`document.querySelectorAll('#analysis .tile').length`), 6);
    assert.match(await ev(`document.querySelector('#analysis .tile').textContent`), /residents per site/);
    await ev(`document.querySelectorAll('#a-body .row-pick')[2].click()`);
    assert.equal(await ev(`document.querySelector('#a-body tr.sel button').textContent`), '2 km');
    await ev(`document.getElementById('a-close').click()`);

    // a hectare: zoom to Bern, select the centre with Enter (the commune lookup fails offline)
    await ev(`(() => { const s = document.getElementById('metric'); s.value = 'pop'; s.dispatchEvent(new Event('change')); })()`);
    await ev(`location.hash = '#map=15/46.948/7.44'`);
    await sleep(1500);
    await ev(`(() => { const c = document.querySelector('.maplibregl-canvas'); c.focus(); c.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); })()`);
    assert.ok(await page.waitFor(`!document.getElementById('detail').hidden && document.querySelectorAll('#detail .tile').length === 6`, 5000));
    assert.ok(await page.waitFor(`document.getElementById('d-title').textContent === 'Hectare'`, 5000), 'fallback title');
    for (const scope of ['radius', 'view', 'cell']) {
      await ev(`document.querySelector('[data-scope="${scope}"]').click()`);
      assert.ok(await ev(`document.querySelectorAll('#detail .tile').length === 6`), `scope ${scope}`);
    }
    await ev(`document.getElementById('d-close').click()`);

    // smooth heatmap, columns, terrain (fails offline and falls back to the flat map)
    await ev(`document.getElementById('smooth').click()`);
    assert.ok(await page.waitFor(`!!document.querySelector('#legend .gradient')`, 20_000));
    assert.ok(await page.waitFor(`/fades where few hectares/.test(document.getElementById('res-note').textContent)`, 30_000), 'smoothed surface');
    await ev(`document.getElementById('smooth').click()`);
    await ev(`document.querySelector('[data-view="3d"]').click()`);
    assert.equal(await ev(`document.querySelector('[data-view][aria-checked="true"]').dataset.view`), '3d');
    await ev(`document.querySelector('[data-view="terrain"]').click()`);
    assert.ok(await page.waitFor(`document.querySelector('[data-view][aria-checked="true"]').dataset.view === '2d'`, 10_000), 'terrain falls back');
    assert.match(await ev(`document.getElementById('terrain-note').textContent`), /Could not load/);

    assert.deepEqual(page.errors.filter((e) => !/geo\.admin\.ch|503|terrain/i.test(e)), []);
  });

  test('a shared link restores the metric, view and selection', async () => {
    await page.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
    await page.send('Page.navigate', { url: `${base}?shared=1#map=14/46.948/7.44&m=foreign&v=3d&sel=2600100,1199600&sc=radius&r=5` });
    assert.ok(await page.waitFor(`!document.getElementById('loading') && !document.getElementById('detail').hidden`, 90_000));
    const ev = page.ev;
    assert.equal(await ev(`document.getElementById('metric').value`), 'foreign');
    assert.equal(await ev(`document.querySelector('[data-view][aria-checked="true"]').dataset.view`), '3d');
    assert.equal(await ev(`document.getElementById('d-title').textContent`), 'Within 5 km');
    await ev(`(() => { const s = document.getElementById('metric'); s.value = 'senior'; s.dispatchEvent(new Event('change')); })()`);
    assert.match(await ev(`location.hash`), /m=senior/);
    await ev(`document.getElementById('d-close').click()`);
    assert.doesNotMatch(await ev(`location.hash`), /sel=/);
  });

  test('phone: folded panel, collapsed credits, details as a sheet', async () => {
    await page.ev(`localStorage.removeItem('spg-settings')`).catch(() => {});
    await load(375, 812, true);
    const ev = page.ev;
    assert.ok(await ev(`document.getElementById('panel').classList.contains('collapsed')`));
    assert.equal(await ev(`document.querySelector('.maplibregl-ctrl-attrib').hasAttribute('open')`), false);
    await ev(`document.getElementById('collapse').click()`);
    assert.equal(await ev(`document.getElementById('collapse').getAttribute('aria-expanded')`), 'true');
    await ev(`document.getElementById('sum-view').click()`);
    assert.ok(await ev(`!document.getElementById('detail').hidden && document.getElementById('panel').classList.contains('collapsed')`));
    const sheet = await ev(`(() => { const r = document.getElementById('detail').getBoundingClientRect(); return [r.left, r.right, r.bottom]; })()`);
    assert.ok(sheet[0] >= 0 && sheet[1] <= 375 && sheet[2] <= 812, `sheet inside the screen: ${sheet}`);
    assert.equal(await ev(`document.documentElement.scrollWidth`), 375, 'no horizontal scrolling');
    assert.deepEqual(page.errors.filter((e) => !/geo\.admin\.ch|503|terrain/i.test(e)), []);
  });
});

// One page over the DevTools protocol, with geo.admin.ch blocked and the basemap set to "None".
async function openPage(port) {
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
  let id = 0;
  const pending = new Map(), errors = [];
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    pending.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.addEventListener('message', (msg) => {
    const m = JSON.parse(msg.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) rej(new Error(JSON.stringify(m.error))); else res(m.result);
    } else if (m.method === 'Runtime.exceptionThrown') {
      errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      errors.push(m.params.args.map((a) => a.value ?? a.description).join(' '));
    } else if (m.method === 'Fetch.requestPaused') {
      send('Fetch.fulfillRequest', { requestId: m.params.requestId, responseCode: 503, body: '' }).catch(() => {});
    }
  });
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Fetch.enable', { patterns: [{ urlPattern: '*geo.admin.ch*' }] });
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `if (!localStorage.getItem('spg-settings')) localStorage.setItem('spg-settings', '{"basemap":"none"}');`,
  });
  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  };
  const waitFor = async (expression, timeout) => {
    for (const t0 = Date.now(); Date.now() - t0 < timeout; await sleep(200)) {
      try { if (await ev(expression)) return true; } catch { /* page still loading */ }
    }
    return false;
  };
  return { ws, send, ev, waitFor, errors };
}
