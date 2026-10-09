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
import { allKeys } from './_i18n.mjs';

const WEB = path.resolve(import.meta.dirname, '..', 'web');
const CHROME = [process.env.CHROME, '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) => p && fs.existsSync(p));
const skip = !process.env.SPG_E2E ? 'set SPG_E2E=1 to run (needs Chrome)' : !CHROME ? 'Chrome not found (set CHROME)' : false;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.jpg': 'image/jpeg' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('browser smoke test', { skip, timeout: 480_000 }, () => {
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
    let port, exited = null;
    chrome.on('exit', (code) => { exited = code; });
    for (let i = 0; i < 300 && !port && exited === null; i++) { // a cold CI runner can take well over 10 s
      await sleep(100);
      try { port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0]; } catch { /* not yet */ }
    }
    assert.ok(port, exited === null ? 'Chrome did not start within 30 s' : `Chrome exited with code ${exited}`);
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
    assert.match(await ev(`document.getElementById('subtitle').textContent`), /31\sDec\s2024/);
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

  test('a hand-edited link with stray values still loads; filters go into the URL', async () => {
    page.errors.length = 0;
    await page.send('Page.navigate', { url: `${base}?edited=1#map=9/46.948/7.44&mp=50%&m=constructor&t=toString&ty=__proto__&b=constructor` });
    assert.ok(await page.waitFor(`!document.getElementById('loading') && document.getElementById('kpi-ant').textContent !== '–'`, 90_000), 'loads');
    const ev = page.ev;
    assert.equal(await ev(`document.getElementById('metric').value`), 'pop');
    await ev(`document.querySelector('#ant-ops input').click()`);
    assert.match(await ev(`location.hash`), /op=0/);
    await ev(`document.querySelector('#ant-ops input').click()`);
    await ev(`document.getElementById('sum-view').click()`);
    assert.match(await ev(`location.hash`), /sc=view/);
    await ev(`document.getElementById('d-close').click()`);
    assert.deepEqual(page.errors.filter((e) => !/geo\.admin\.ch|503|terrain/i.test(e)), []);
  });

  test('search: an address flies there and selects its hectare', async () => {
    await load(1280, 800, false);
    const ev = page.ev;
    await ev(`(() => { const i = document.getElementById('search'); i.focus(); i.value = 'Bahnhofstrasse 1'; i.dispatchEvent(new Event('input')); })()`);
    assert.ok(await page.waitFor(`document.querySelectorAll('#search-results li').length === 1`, 5000), 'search results');
    assert.equal(await ev(`document.querySelector('#search-results li').getAttribute('aria-label')`), 'Bahnhofstrasse 1 8001 Zürich, Address');
    await ev(`document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    assert.ok(await page.waitFor(`location.hash.startsWith('#map=15.5/') && location.hash.includes('sel=2683100,1247100')`, 20_000), // CI runners are ~3x slower
      `flew to the address: ${await ev('location.hash')}`);
    assert.ok(await ev(`!document.getElementById('detail').hidden`));
  });

  test('exports: the map as a PNG with its legend, the details as CSV', async () => { // the search left a hectare open
    const ev = page.ev;
    await ev(`(() => { window.__files = []; HTMLAnchorElement.prototype.click = function () {
      window.__files.push(fetch(this.href).then((r) => r.arrayBuffer()).then((b) => ({ name: this.download, bytes: [...new Uint8Array(b)] }))); }; })()`);
    const files = () => ev(`Promise.all(window.__files).then((f) => { window.__files = []; return f; })`);
    await ev(`document.getElementById('save-image').click()`);
    assert.ok(await page.waitFor(`window.__files.length === 1`, 60_000), 'image saved'); // PNG encoding is slow in software rendering
    const [png] = await files();
    assert.match(png.name, /^swiss-atlas-pop-\d{4}-\d\d-\d\d\.png$/);
    assert.deepEqual(png.bytes.slice(1, 4), [80, 78, 71], 'PNG signature');
    const csvBtn = `[...document.querySelectorAll('#detail .link-btn')].find((b) => b.textContent === 'Download as CSV')`;
    await ev(`${csvBtn}.click()`);
    assert.ok(await page.waitFor(`window.__files.length === 1`, 5000), 'CSV saved');
    const [csv] = await files();
    assert.deepEqual(csv.bytes.slice(0, 3), [0xef, 0xbb, 0xbf], 'UTF-8 byte-order mark, for Excel');
    const text = new TextDecoder().decode(new Uint8Array(csv.bytes)); // drops the mark
    assert.ok(text.startsWith('area,code,attribute,value,source\r\n'), text.slice(0, 60));
    assert.match(text, /\r\n"Hectare E 2683100, N 1247100 [^\r\n]*",BBTOT,"Residents, total",\d+,"STATPOP2024, FSO GEOSTAT"\r\n/);
    assert.deepEqual(page.errors.filter((e) => !/geo\.admin\.ch|503|terrain/i.test(e)), []);
  });

  test('commune: a searched commune opens its summary; URL and CSV follow', async () => {
    const ev = page.ev;
    await ev(`document.querySelector('[data-scope="cell"]').click()`);
    await ev(`(() => { const i = document.getElementById('search'); i.focus(); i.value = 'Testwil'; i.dispatchEvent(new Event('input')); })()`);
    assert.ok(await page.waitFor(`document.querySelector('#search-results li')?.getAttribute('aria-label') === 'Testwil (ZH), Commune'`, 5000), 'search results');
    await ev(`document.getElementById('search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))`);
    assert.ok(await page.waitFor(`document.getElementById('d-title').textContent === 'Testwil (ZH)'`, 30_000), 'boundary loaded');
    assert.match(await ev(`document.getElementById('d-sub').textContent`), /^[\d'’,]+ inhabited hectares$/);
    assert.equal(await ev(`document.querySelectorAll('#detail .tile').length`), 6);
    assert.match(await ev(`location.hash`), /sel=2683100,1247100&sc=commune/);
    await ev(`[...document.querySelectorAll('#detail .link-btn')].find((b) => b.textContent === 'Download as CSV').click()`);
    assert.ok(await page.waitFor(`window.__files.length === 1`, 5000), 'CSV saved');
    const [csv] = await ev(`Promise.all(window.__files).then((f) => { window.__files = []; return f; })`);
    assert.match(new TextDecoder().decode(new Uint8Array(csv.bytes)), /\r\n"Commune Testwil \(ZH\), FSO no\. 9999, as of 1 January 2025",BBTOT,/);
    await ev(`document.querySelector('[data-scope="cell"]').click()`);
    assert.deepEqual(page.errors.filter((e) => !/geo\.admin\.ch|503|terrain/i.test(e)), []);
  });

  test('languages: German, French and Italian pages have no English left; the switch keeps the view', async () => {
    const keys = (await allKeys()).filter((k) => !/\{/.test(k));
    const visible = `(() => {
      const out = [];
      const walk = (n) => { for (const c of n.childNodes) {
        if (c.nodeType === 3) { const s = c.textContent.trim(); if (s) out.push(s); }
        else if (c.nodeType === 1 && !c.hidden && getComputedStyle(c).display !== 'none') walk(c);
      } };
      for (const id of ['panel', 'detail']) walk(document.getElementById(id));
      for (const e of document.querySelectorAll('[aria-label], [title], [placeholder]')) for (const a of ['aria-label', 'title', 'placeholder']) if (e.getAttribute(a)) out.push(e.getAttribute(a));
      for (const o of document.querySelectorAll('option, optgroup')) out.push(o.label || o.textContent.trim());
      return out;
    })()`;
    const check = async (code, sample) => {
      const dict = (await import(`../web/i18n/${code}.js`)).default;
      const english = new Set(keys.filter((k) => dict[k] !== k));
      assert.ok(await page.waitFor(`!document.getElementById('loading') && document.documentElement.lang === '${code}'`, 90_000), `${code} loads`);
      assert.ok(await page.waitFor(`!document.getElementById('detail').hidden`, 10_000), `${code}: the link's selection opens`);
      const texts = await page.ev(visible);
      const left = [...new Set(texts.filter((x) => english.has(x) && !Object.values(dict).includes(x)))];
      assert.deepEqual(left, [], `${code}: untranslated`);
      for (const [sel, want] of sample) assert.equal(await page.ev(`document.querySelector('${sel}').textContent.trim()`), want, `${code}: ${sel}`);
      assert.equal(await page.ev(`document.documentElement.classList.contains('i18n-pending')`), false);
    };
    page.errors.length = 0;
    await page.send('Page.navigate', { url: `${base}?lang=1#map=14/46.948/7.44&m=foreign&sel=2600100,1199600&sc=radius&r=2&l=de` });
    await check('de', [['label[for="metric"]', 'Einfärben nach'], ['#d-title', 'Umkreis 2 km'], ['[data-scope="commune"]', 'Gemeinde']]);
    assert.match(await page.ev(`document.querySelector('#detail .tile .v').textContent`), /^\d{1,3}(['’]\d{3})*$/, 'de-CH digit grouping (ICU versions differ on the apostrophe)');
    // the language menu: the page reloads in French with the same view
    await page.ev(`(() => { const s = document.getElementById('lang'); s.value = 'fr'; s.dispatchEvent(new Event('change')); })()`);
    await check('fr', [['label[for="metric"]', 'Couleur selon'], ['#d-title', 'Rayon de 2 km'], ['[data-scope="view"]', 'Vue']]);
    const hash = await page.ev(`location.hash`);
    for (const part of ['m=foreign', 'sel=2600100,1199600', 'sc=radius', 'l=fr']) assert.ok(hash.includes(part), `${part} in ${hash}`);
    assert.match(await page.ev(`document.querySelectorAll('#detail .tile .v')[2].textContent`), /^\d,\d\d$/, 'decimal comma');
    await page.ev(`(() => { const s = document.getElementById('lang'); s.value = 'it'; s.dispatchEvent(new Event('change')); })()`);
    await check('it', [['label[for="metric"]', 'Colora per'], ['#d-title', 'Entro 2 km'], ['#metric option[value="foreign"]', 'Stranieri']]);
    await page.ev(`(() => { const s = document.getElementById('lang'); s.value = 'en'; s.dispatchEvent(new Event('change')); })()`);
    assert.ok(await page.waitFor(`!document.getElementById('loading') && document.documentElement.lang === 'en' && document.querySelector('label[for="metric"]').textContent === 'Colour by'`, 90_000), 'back to English');
    await page.ev(`history.replaceState(null, '', location.pathname); localStorage.removeItem('spg-lang')`);
    assert.deepEqual(page.errors.filter((e) => !/geo\.admin\.ch|503|terrain/i.test(e)), []);
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

const SEARCH_RESULT = { results: [{ attrs: {
  label: '<b>Bahnhofstrasse 1</b> 8001 Zürich', origin: 'address', lat: 47.36975, lon: 8.53913,
  geom_st_box2d: 'BOX(8.53913 47.36975,8.53913 47.36975)',
} }] };

// Searching that commune by name (origin gg25), and its boundary: a made-up 1.5 km square around the
// searched address, as swisstopo's identify answers.
const COMMUNE_SEARCH = { results: [{ attrs: {
  label: '<b>Testwil (ZH)</b>', origin: 'gg25', featureId: '9999', lat: 47.36975, lon: 8.53913,
  geom_st_box2d: 'BOX(8.53 47.363,8.55 47.377)',
} }] };
const COMMUNE_RESULT = { results: [{ featureId: '9999-2025', id: '9999-2025',
  properties: { gemname: 'Testwil', kanton: 'ZH', gde_nr: 9999, jahr: 2025, gemflaeche: 225 },
  geometry: { type: 'Polygon', coordinates: [[[2682400, 1246400], [2683900, 1246400], [2683900, 1247900], [2682400, 1247900], [2682400, 1246400]]] },
}] };

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
    } else if (m.method === 'Fetch.requestPaused') { // geo.admin.ch: canned search and boundary answers, 503 for the rest
      const { url } = m.params.request;
      const canned = url.includes('/SearchServer') ? (url.includes('Testwil') ? COMMUNE_SEARCH : SEARCH_RESULT)
        : url.includes('gemeinde-flaeche.fill/9999-') ? { feature: COMMUNE_RESULT.results[0] } : url.includes('/identify') && url.includes('returnGeometry=true') ? COMMUNE_RESULT : null;
      send('Fetch.fulfillRequest', {
        requestId: m.params.requestId, responseCode: canned ? 200 : 503,
        responseHeaders: [{ name: 'Content-Type', value: 'application/json' }, { name: 'Access-Control-Allow-Origin', value: '*' }],
        body: canned ? Buffer.from(JSON.stringify(canned)).toString('base64') : '',
      }).catch(() => {});
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
