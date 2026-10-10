/* Swiss population grid – hectare map of STATPOP data with OFCOM mobile antenna sites.
 * Data comes from web/data (built by scripts/); rendering is MapLibre + deck.gl (globals from index.html). */

import { lv95ToWgs, wgsToLv95, squareRing, areaTest } from './geo.js';
import { blurSurface, makeColorScale, colorize, toTiles, pixelAt } from './smooth.js';
import * as ANT from './antennas.js';
import { blockPairs, correlate, distanceCurve, cdfChart, scatterChart } from './analysis.js';
import { terrainSource, registerTileProtocol, antennaImages } from './terrain.js';
import { detectProxy, geoUrl, transformRequest } from './remote.js';
import { t, tp, isOne, lang, locale, LINKS, fmtFixed, fmtNum, fmtPct, fmtDate, translatePage, setLang } from './i18n.js';

translatePage();
document.title = t('Swiss atlas – population and mobile antennas');
const $ = (id) => document.getElementById(id);
const canHover = matchMedia('(hover: hover)').matches; // touch screens: a tap selects; no hover tooltips
// An instruction for the pointer in use: "Click …" with a mouse, "Tap …" on touch screens.
const press = (click, tap) => t(canHover ? click : tap);

// A message in place of the loading card when the map cannot start.
function showFatal(...parts) {
  $('panel').removeAttribute('aria-busy');
  const box = $('loading');
  if (!box) return;
  box.classList.add('error');
  const msg = $('loading-msg');
  msg.setAttribute('role', 'alert');
  msg.replaceChildren(...parts);
}
{
  const problem = !window.maplibregl || !window.deck ? t('The map libraries did not load. Check your connection and reload the page.')
    : !document.createElement('canvas').getContext('webgl2') ? t('This map needs WebGL 2, which this browser or device does not provide. Try an up-to-date Chrome, Firefox, Safari or Edge with hardware acceleration turned on.')
      : typeof DecompressionStream === 'undefined' || typeof Object.hasOwn !== 'function'
        ? t('This browser is too old for the map. It needs Chrome 93, Firefox 113, Safari 16.4 or newer.')
        : null;
  if (problem) { showFatal(problem); throw new Error(problem); }
}
const nf = new Intl.NumberFormat(locale); // 138’141 (138 141 in French)
const pad2 = (i) => String(i).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const fmtCoord = (v) => nf.format(Math.round(v));
const fmtM = (m) => (!Number.isFinite(m) ? '–' : m >= 1000 ? `${fmtFixed(m / 1000, m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
const fmtKm = (km) => (km < 1 ? `${km * 1000} m` : `${km} km`);

// ---------------------------------------------------------------- palettes
// Sequential blue (one hue, light -> dark; flipped anchor on dark basemaps) and a blue <-> red
// diverging ramp with a neutral grey midpoint.
const SEQ = {
  light: ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'],
  dark: ['#104281', '#1c5cab', '#2a78d6', '#5598e7', '#86b6ef', '#b7d3f6', '#cde2fb'],
};
const DIV = {
  light: ['#184f95', '#3987e5', '#9ec5f4', '#f0efec', '#f1aea8', '#d75853', '#892b2a'],
  dark: ['#86b6ef', '#2a78d6', '#1c5cab', '#383835', '#9e3432', '#c74845', '#ea9a93'],
};
const NA_COLOR = { light: '#a9a8a2', dark: '#6b6a65' };
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

// All basemaps are swisstopo's free services (vector tiles + WMTS on geo.admin.ch, no key needed).
const VT = 'https://vectortiles.geo.admin.ch/styles';
const WMTS = (layer, maxzoom) => ({ raster: `https://wmts.geo.admin.ch/1.0.0/${layer}/default/current/3857/{z}/{x}/{y}.jpeg`, maxzoom });
const BASEMAPS = {
  imagery: { dark: true, style: `${VT}/ch.swisstopo.imagerybasemap.vt/style.json` },
  swissimage: { dark: true, ...WMTS('ch.swisstopo.swissimage', 20) },
  national: { dark: false, ...WMTS('ch.swisstopo.pixelkarte-farbe', 18) },
  nationalGrey: { dark: false, ...WMTS('ch.swisstopo.pixelkarte-grau', 18) },
  light: { dark: false, style: `${VT}/ch.swisstopo.lightbasemap.vt/style.json` },
  base: { dark: false, style: `${VT}/ch.swisstopo.basemap.vt/style.json` },
  none: { dark: null },
};
const uiDark = () => matchMedia('(prefers-color-scheme: dark)').matches;
const basemapDark = () => BASEMAPS[state.basemap].dark ?? uiDark();
function styleFor(key) {
  const b = BASEMAPS[key];
  if (b.style) return b.style;
  if (b.raster) {
    return {
      version: 8,
      sources: {
        swisstopo: {
          type: 'raster', tiles: [b.raster], tileSize: 256, maxzoom: b.maxzoom,
          attribution: `<a href="${LINKS.swisstopo}" target="_blank" rel="noopener">© swisstopo</a>`,
        },
      },
      layers: [{ id: 'swisstopo', type: 'raster', source: 'swisstopo' }],
    };
  }
  return { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': uiDark() ? '#0d0d0d' : '#f9f9f7' } }] };
}

// ---------------------------------------------------------------- state
const SIGMAS = [100, 200, 300, 500, 1000, 2000, 5000]; // smoothing kernel sigma, metres
const DEFAULTS = {
  metric: 'pop', rawCol: 'BB12', rawMode: 'share', minPop: 1, excludeNoloc: false,
  view: '2d', heightScale: 3, opacity: 0.85, dim: 0.1, basemap: 'imagery', scope: 'cell', radiusKm: 2,
  smooth: false, sigma: 300, analysisScale: 1000, exaggeration: 1.5,
  ant: { show: true, ops: [true, true, true, false, false], tech: '', type: '', color: 'single', sizeByPower: true },
};
const SCOPES = ['cell', 'radius', 'commune', 'view']; // the details' Summarise options
const HASH_KEYS = ['m', 'a', 'as', 'mp', 'x', 'v', 's', 'b', 'an', 'op', 't', 'ty', 'sel', 'site', 'sc', 'r']; // see writeHash()
const SETTINGS_VERSION = 2; // 2: basemap dimming 0.1 by default (was 0.45, stored by everyone who visited)
const saved = loadSettings();
delete saved.minPop; // every visit starts with all hectares shown; a link keeps its minimum (mp=)
if (saved.v !== SETTINGS_VERSION) delete saved.dim;
const state = {
  ...DEFAULTS, ...saved, ant: { ...DEFAULTS.ant, ops: [...DEFAULTS.ant.ops], ...(saved.ant || {}) },
  isolate: null, selected: -1, antenna: -1, hoverBlock: null, beforeId: undefined,
};
const BOOT_HASH = hashParams(); // read before anything rewrites the URL (sel= and site= apply once the data is in)
stateFromHash(BOOT_HASH);
// Own keys only: a link with b=constructor or t=toString must not match an inherited property.
if (!Object.hasOwn(BASEMAPS, state.basemap)) state.basemap = DEFAULTS.basemap;
if (!SIGMAS.includes(state.sigma)) state.sigma = DEFAULTS.sigma;
if (!Object.hasOwn(ANT.COLOR_MODES, state.ant.color)) state.ant.color = 'single';
if (!Object.hasOwn(ANT.TECH, state.ant.tech)) state.ant.tech = '';
if (!Object.hasOwn(ANT.TYPE_GROUPS, state.ant.type)) state.ant.type = '';
state.ant.ops = Array.isArray(state.ant.ops) && state.ant.ops.length === 5 ? state.ant.ops.map(Boolean) : [...DEFAULTS.ant.ops];
if (!['2d', '3d', 'terrain'].includes(state.view)) state.view = '2d';
if (!SCOPES.includes(state.scope)) state.scope = DEFAULTS.scope;
const isTerrain = () => state.view === 'terrain';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('spg-settings') || '{}'); } catch { return {}; }
}
function saveSettings() {
  const keep = ['metric', 'rawCol', 'rawMode', 'excludeNoloc', 'view', 'heightScale', 'opacity', 'dim', 'basemap',
    'scope', 'radiusKm', 'smooth', 'sigma', 'analysisScale', 'ant', 'exaggeration'];
  const settings = { v: SETTINGS_VERSION, ...Object.fromEntries(keep.map((k) => [k, state[k]])) };
  try { localStorage.setItem('spg-settings', JSON.stringify(settings)); } catch { /* private mode */ }
  writeHash();
}

// Shareable links: next to MapLibre's map=zoom/lat/lon, the URL hash carries what the map shows
// (defaults left out). A link with any of these opens exactly that view, overriding saved settings;
// a plain map= link keeps the visitor's own. sel= is the selected hectare (LV95 south-west corner),
// site= a selected antenna site (its LV95 position, which survives data updates unlike its index).
function hashParams() {
  return Object.fromEntries(location.hash.slice(1).split('&').filter(Boolean).map((p) => {
    const k = p.indexOf('=');
    if (k < 0) return [p, ''];
    try { return [p.slice(0, k), decodeURIComponent(p.slice(k + 1))]; } catch { return [p.slice(0, k), p.slice(k + 1)]; }
  }));
}
function stateFromHash(h) {
  if (!HASH_KEYS.some((k) => k in h)) return;
  Object.assign(state, { ...DEFAULTS, ant: { ...DEFAULTS.ant, ops: [...DEFAULTS.ant.ops], color: state.ant.color, sizeByPower: state.ant.sizeByPower },
    heightScale: state.heightScale, opacity: state.opacity, dim: state.dim, analysisScale: state.analysisScale, exaggeration: state.exaggeration });
  if (h.m) state.metric = h.m; // validated once the controls are built
  if (h.a) state.rawCol = h.a;
  if (h.as === 'count') state.rawMode = 'count';
  if (h.mp) state.minPop = Math.min(100, Math.max(1, Math.round(+h.mp) || DEFAULTS.minPop));
  if (h.x === '1') state.excludeNoloc = true;
  if (h.v) state.view = h.v;
  if (h.s) { state.smooth = true; state.sigma = +h.s; }
  if (h.b) state.basemap = h.b;
  if (h.an === '0') state.ant.show = false;
  if (/^[01]{5}$/.test(h.op ?? '')) state.ant.ops = [...h.op].map((c) => c === '1');
  if (Object.hasOwn(ANT.TECH, h.t ?? '')) state.ant.tech = h.t;
  if (Object.hasOwn(ANT.TYPE_GROUPS, h.ty ?? '')) state.ant.type = h.ty;
  if (SCOPES.includes(h.sc)) state.scope = h.sc;
  else if ('site' in h) state.scope = 'radius'; // a site opens on its radius summary
  if ([0.5, 1, 2, 5, 10, 20].includes(+h.r)) state.radiusKm = +h.r;
}
function hashFor() {
  const keep = location.hash.slice(1).split('&').filter((p) => p && !HASH_KEYS.includes(p.split('=')[0]));
  const add = [], a = state.ant, d = DEFAULTS;
  if (state.metric !== d.metric) add.push(`m=${state.metric}`);
  if (state.metric === 'raw') { add.push(`a=${state.rawCol}`); if (state.rawMode === 'count') add.push('as=count'); }
  if (state.minPop !== d.minPop) add.push(`mp=${state.minPop}`);
  if (state.excludeNoloc) add.push('x=1');
  if (state.view !== d.view) add.push(`v=${state.view}`);
  if (state.smooth) add.push(`s=${state.sigma}`);
  if (state.basemap !== d.basemap) add.push(`b=${state.basemap}`);
  if (!a.show) add.push('an=0');
  const ops = a.ops.map((o) => (o ? 1 : 0)).join('');
  if (ops !== d.ant.ops.map((o) => (o ? 1 : 0)).join('')) add.push(`op=${ops}`);
  if (a.tech) add.push(`t=${a.tech}`);
  if (a.type) add.push(`ty=${a.type}`);
  if (state.antenna >= 0 && !$('detail').hidden) {
    add.push(`site=${A.e[state.antenna]},${A.N[state.antenna]}`);
    if (state.scope !== 'radius') add.push(`sc=${state.scope}`);
    if (state.scope === 'radius') add.push(`r=${state.radiusKm}`);
  } else if (state.selected >= 0 && N && !$('detail').hidden) {
    add.push(`sel=${cellE(state.selected)},${cellN(state.selected)}`);
    if (state.scope !== 'cell') add.push(`sc=${state.scope}`);
    if (state.scope === 'radius') add.push(`r=${state.radiusKm}`);
  } else if (state.scope === 'view' && N && !$('detail').hidden) {
    add.push('sc=view'); // the "In view" summary, which needs no selection
  }
  return `#${[...keep, ...add].join('&')}`;
}
function writeHash() {
  const next = hashFor();
  if (next !== (location.hash || '#')) history.replaceState(history.state, '', next);
}
// A link pasted into an open tab only changes the hash: MapLibre moves the camera, but the metric,
// filters and selection would stay as they were. Reopen the page so that the link applies in full.
// (MapLibre and writeHash() use replaceState, which fires no hashchange.)
addEventListener('hashchange', () => {
  const h = hashParams();
  if (h.l && h.l !== lang && ['en', 'de', 'fr', 'it'].includes(h.l)) location.reload(); // another language
  else if (HASH_KEYS.some((k) => k in h) && location.hash !== hashFor()) location.reload();
  else writeHash(); // a plain map= link keeps the visitor's own settings, as on load
});

// ---------------------------------------------------------------- data
let META, N, M, E_IDX, N_IDX, POS, CENTER, BBOX, BBOX_LL, NOLOC_IDX;
const RAW = {}, NOLOC = {}, NOLOC_OF = new Map(), ADJ = {};
let CELL_OF; // (E index × 65536 + N index) -> hectare, see cellIndex()
let COLORS, ELEV, CLASS, CELL_DATA;

function setProgress(pc) {
  $('loading-bar').style.width = `${pc}%`;
  $('loading-bar').parentElement.setAttribute('aria-valuenow', String(Math.round(pc)));
}
// index.html starts these downloads before the libraries load (window.SPG_FETCH).
const early = (name, url) => window.SPG_FETCH?.[name] ?? fetch(url, { cache: 'no-cache' });
async function loadData() {
  if (location.protocol === 'file:') throw new Error('file');
  const [metaRes, res] = await Promise.all([early('meta', 'data/meta.json'), early('cells', 'data/cells.bin.gz')]);
  if (!metaRes.ok || !res.ok) throw new Error('missing');
  META = await metaRes.json();
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const head = [];
  let got = 0;
  while (got < 2) { // enough bytes to recognise gzip
    const { done, value } = await reader.read();
    if (done) throw new Error('missing');
    head.push(value);
    got += value.byteLength;
  }
  // Decompress while the rest downloads (no intermediate Blobs).
  const body = new ReadableStream({
    start(c) { head.forEach((chunk) => c.enqueue(chunk)); },
    async pull(c) {
      const { done, value } = await reader.read();
      if (done) { c.close(); return; }
      got += value.byteLength;
      if (total) setProgress(Math.min(99, (got / total) * 100));
      c.enqueue(value);
    },
  });
  const gz = head[0][0] === 0x1f && (head[0][1] ?? head[1][0]) === 0x8b; // not already decoded by the server
  const buf = await new Response(gz ? body.pipeThrough(new DecompressionStream('gzip')) : body).arrayBuffer();
  setProgress(100);
  parse(buf);
}

function parse(buf) {
  N = META.n;
  M = META.noloc.m;
  E_IDX = new Uint16Array(buf, 0, N);
  N_IDX = new Uint16Array(buf, 2 * N, N);
  META.columns.forEach((c, k) => { RAW[c] = new Uint16Array(buf, (2 + k) * 2 * N, N); });
  const off = META.noloc.offset;
  NOLOC_IDX = new Uint32Array(buf, off, M);
  META.columns.forEach((c, k) => { NOLOC[c] = new Uint16Array(buf, off + 4 * M + k * 2 * M, M); });
  for (let j = 0; j < M; j++) NOLOC_OF.set(NOLOC_IDX[j], j);

  POS = new Float32Array(2 * N);     // SW corner (GridCellLayer anchor)
  CENTER = new Float32Array(2 * N);  // cell centre, for view/bounds tests
  BBOX = [Infinity, Infinity, -Infinity, -Infinity];
  for (let i = 0; i < N; i++) {
    const E = META.e0 + E_IDX[i] * 100, Nn = META.n0 + N_IDX[i] * 100;
    const sw = lv95ToWgs(E, Nn), c = lv95ToWgs(E + 50, Nn + 50);
    POS[2 * i] = sw[0]; POS[2 * i + 1] = sw[1];
    CENTER[2 * i] = c[0]; CENTER[2 * i + 1] = c[1];
    BBOX[0] = Math.min(BBOX[0], E); BBOX[1] = Math.min(BBOX[1], Nn);
    BBOX[2] = Math.max(BBOX[2], E + 100); BBOX[3] = Math.max(BBOX[3], Nn + 100);
  }
  CELL_OF = cellIndex();
  const corners = [[BBOX[0], BBOX[1]], [BBOX[0], BBOX[3]], [BBOX[2], BBOX[1]], [BBOX[2], BBOX[3]]].map(([e, n]) => lv95ToWgs(e, n));
  BBOX_LL = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])),
    Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
}

// The data lists hectares sorted by E index, then N index: per E column, the start of its hectares,
// then a binary search over N. Same get() as a Map, in 14 KB instead of a 15 MB Map (and 20 ms faster).
function cellIndex() {
  for (let i = 1; i < N; i++) {
    if (E_IDX[i] < E_IDX[i - 1] || (E_IDX[i] === E_IDX[i - 1] && N_IDX[i] <= N_IDX[i - 1])) { // not sorted: plain Map
      const m = new Map();
      for (let k = 0; k < N; k++) m.set(E_IDX[k] * 65536 + N_IDX[k], k);
      return m;
    }
  }
  const eMax = E_IDX[N - 1], start = new Int32Array(eMax + 2);
  for (let i = 0; i < N; i++) start[E_IDX[i] + 1]++;
  for (let e = 0; e <= eMax; e++) start[e + 1] += start[e];
  return {
    get(key) {
      const e = Math.floor(key / 65536), n = key - e * 65536;
      if (e < 0 || e > eMax) return undefined;
      let lo = start[e], hi = start[e + 1] - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1, v = N_IDX[mid];
        if (v === n) return mid;
        if (v < n) lo = mid + 1; else hi = mid - 1;
      }
      return undefined;
    },
  };
}

// Active column, optionally with the non-geocoded (commune-centre) residents removed.
function col(code) {
  if (!state.excludeNoloc || code === 'HPI') return RAW[code];
  if (ADJ[code]) return ADJ[code];
  const a = RAW[code].slice(), nl = NOLOC[code];
  for (let j = 0; j < M; j++) { const i = NOLOC_IDX[j]; a[i] = Math.max(0, a[i] - nl[j]); }
  return (ADJ[code] = a);
}
const cellE = (i) => META.e0 + E_IDX[i] * 100;
const cellN = (i) => META.n0 + N_IDX[i] * 100;
function cellAt(E, Nn) {
  const i = CELL_OF.get(Math.floor((E - META.e0) / 100) * 65536 + Math.floor((Nn - META.n0) / 100));
  return i !== undefined && col('BBTOT')[i] > 0 ? i : -1;
}

// ---------------------------------------------------------------- antennas
let A = null;          // all sites (antennas.js)
let SITES = new Int32Array(0), SITE_LIST = [], AIDX = null;
let DIST = null, NEAR = null; // per hectare: distance (m) to / index of the nearest filtered site
let antVersion = 0;

function updateSites() {
  if (!A) return;
  SITES = ANT.filterSites(A, state.ant);
  SITE_LIST = Array.from(SITES); // deck.gl layer data
  AIDX = ANT.buildIndex(A, SITES);
  antVersion++;
  ANALYSIS = null;
}
// Distance from every hectare to its nearest filtered site (~0.1 s): only for the distance metric
// and the analysis panel, not on every filter change.
let distVersion = -1;
function ensureDist() {
  if (distVersion === antVersion || !A) return;
  DIST = new Float32Array(N);
  NEAR = new Int32Array(N);
  ANT.nearestAll(A, SITES, (i) => cellE(i) + 50, (i) => cellN(i) + 50, N, DIST, NEAR);
  distVersion = antVersion;
}

// ---------------------------------------------------------------- metrics
const age = (from, to) => range(from, to).flatMap((k) => [`BBM${pad2(k)}`, `BBW${pad2(k)}`]);
const ALL_AGES = age(1, 19);
const DURATION = ['BB41', 'BB42', 'BB43', 'BB44', 'BB45', 'BB46'];
const PREV = ['BB51', 'BB52', 'BB53', 'BB54', 'BB55', 'BB56'];
const HH = range(1, 6).map((k) => `HP${pad2(k)}`);
const AGE_MID = [...range(0, 17).map((k) => k * 5 + 2.5), 92.5];
const meanAgeWeights = range(1, 19).flatMap((k) => [AGE_MID[k - 1], AGE_MID[k - 1]]);

// ---------------------------------------------------------------- grids
// A 100 m cell is < 1 px when zoomed out, so the browser would draw a random subset of cells.
// Zoomed out we therefore aggregate hectares into coarser LV95-aligned blocks.
const LEVELS = [100, 200, 500, 1000, 2000];
const GRIDS = {};
function gridFor(s) {
  if (GRIDS[s]) return GRIDS[s];
  if (s === 100) return (GRIDS[s] = { s, n: N, pos: POS, col, inhabited: () => null, sum: (a) => a });
  const f = s / 100, keyOf = new Map(), blockOf = new Uint32Array(N), be = [], bn = [];
  for (let i = 0; i < N; i++) {
    const e = Math.floor(E_IDX[i] / f), n = Math.floor(N_IDX[i] / f), k = e * 65536 + n;
    let b = keyOf.get(k);
    if (b === undefined) { b = be.length; keyOf.set(k, b); be.push(e); bn.push(n); }
    blockOf[i] = b;
  }
  const nb = be.length, pos = new Float32Array(2 * nb), center = new Float32Array(2 * nb);
  for (let b = 0; b < nb; b++) {
    const E = META.e0 + be[b] * s, Nn = META.n0 + bn[b] * s;
    const sw = lv95ToWgs(E, Nn), c = lv95ToWgs(E + s / 2, Nn + s / 2);
    pos[2 * b] = sw[0]; pos[2 * b + 1] = sw[1];
    center[2 * b] = c[0]; center[2 * b + 1] = c[1];
  }
  const cache = {};
  const sum = (a) => { const out = new Float32Array(nb); for (let i = 0; i < N; i++) out[blockOf[i]] += a[i]; return out; };
  return (GRIDS[s] = {
    s, n: nb, pos, center, keyOf, be, bn, sum,
    inhabited() { // number of inhabited hectares per block
      const key = `#ha${state.excludeNoloc ? '*' : ''}`;
      if (cache[key]) return cache[key];
      const pop = col('BBTOT'), out = new Float32Array(nb);
      for (let i = 0; i < N; i++) if (pop[i] > 0) out[blockOf[i]]++;
      return (cache[key] = out);
    },
    col(code) {
      const key = code + (state.excludeNoloc ? '*' : '');
      return cache[key] || (cache[key] = sum(col(code)));
    },
  });
}
function levelForZoom(z) {
  const mpp = (156543.03 * Math.cos((46.8 * Math.PI) / 180)) / 2 ** z;
  return LEVELS.find((s) => s / mpp >= 2.5) ?? LEVELS[LEVELS.length - 1];
}

// Each metric is num / den over a grid. src describes where num and den come from:
//   count: a column per inhabited hectare (blocks: mean over their inhabited hectares)
//   ratio: sum(num columns) / sum(den columns)
//   mean:  sum(column × weight) / sum(column)
//   dist:  population-weighted distance to the nearest antenna site
function sumCols(g, codes, weights) {
  const out = new Float32Array(g.n);
  codes.forEach((c, k) => { const a = g.col(c), w = weights ? weights[k] : 1; for (let i = 0; i < g.n; i++) out[i] += a[i] * w; });
  return out;
}
function inhabitedIndicator() {
  const pop = col('BBTOT'), out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = pop[i] > 0 ? 1 : 0;
  return out;
}
function parts(src, g) {
  if (src.type === 'count') return { num: g.col(src.code), den: g.s === 100 ? inhabitedIndicator() : g.inhabited() };
  if (src.type === 'ratio') return { num: sumCols(g, src.num), den: sumCols(g, src.den) };
  if (src.type === 'mean') return { num: sumCols(g, src.codes, src.weights), den: sumCols(g, src.codes) };
  if (src.type === 'dist') {
    ensureDist();
    const pop = col('BBTOT'), num = new Float32Array(N), den = new Float32Array(N);
    for (let i = 0; i < N; i++) if (pop[i] > 0 && DIST && Number.isFinite(DIST[i])) { num[i] = DIST[i] * pop[i]; den[i] = pop[i]; }
    return { num: g.sum(num), den: g.sum(den) };
  }
  if (src.type === 'none') return { num: new Float32Array(g.n).fill(NaN), den: new Float32Array(g.n).fill(1) };
  throw new Error(src.type);
}
// Numerator and denominator per hectare, for a few recent metrics. Coarser grids sum these once,
// instead of summing every input column per block (38 columns for the age metrics).
const partsCache = new Map();
function baseParts(m) {
  const key = metricKey(m);
  let b = partsCache.get(key);
  if (!b) {
    partsCache.set(key, (b = parts(m.src, gridFor(100))));
    if (partsCache.size > 4) partsCache.delete(partsCache.keys().next().value);
  }
  return b;
}
function computeMetric(m, g) {
  const b = baseParts(m), num = g.sum(b.num), den = g.sum(b.den); // g.sum is the identity at 100 m
  const out = new Float32Array(g.n), clamp = m.kind === 'share' || m.kind === 'diverging';
  for (let i = 0; i < g.n; i++) {
    const v = den[i] > 0 ? num[i] / den[i] : NaN;
    out[i] = m.src.type === 'count' && !(num[i] > 0) ? NaN : clamp ? Math.min(1, v) : v;
  }
  return out;
}

const count = (code) => ({ type: 'count', code });
const ratio = (num, den) => ({ type: 'ratio', num, den });
const METRICS = [
  { id: 'pop', group: t('Population'), label: t('Residents per hectare'), what: t('Residents'), kind: 'count', breaks: [4, 10, 25, 50, 100, 250],
    desc: t('Permanent residents on each hectare (100 × 100 m).'), src: count('BBTOT') },
  { id: 'hh', group: t('Population'), label: t('Private households per hectare'), what: t('Private households'), kind: 'count', breaks: [4, 10, 20, 40, 80, 150],
    desc: t('Private households on each hectare.'), src: count('HPTOT') },
  { id: 'foreign', group: t('Nationality'), label: t('Foreign nationals'), kind: 'share',
    desc: t('Share of residents without Swiss citizenship (dual nationals count as Swiss).'), src: ratio(['BB12'], ['BB11', 'BB12']) },
  { id: 'euefta', group: t('Nationality'), label: t('EU/EFTA nationals'), kind: 'share',
    desc: t('Share of residents with the nationality of an EU or EFTA state.'), src: ratio(['BB13'], ['BB11', 'BB12']) },
  { id: 'noneu', group: t('Nationality'), label: t('Non-European nationals'), kind: 'share',
    desc: t('Share of residents with the nationality of a country outside Europe.'), src: ratio(['BB15'], ['BB11', 'BB12']) },
  { id: 'abroad', group: t('Place of birth'), label: t('Born abroad'), kind: 'share',
    desc: t('Share of residents born outside Switzerland.'), src: ratio(['BB26'], ['BB21', 'BB26']) },
  { id: 'native', group: t('Place of birth'), label: t('Born in their current commune'), kind: 'share',
    desc: t('Share of residents born in the commune they live in today.'), src: ratio(['BB22'], ['BB21', 'BB26']) },
  { id: 'meanAge', group: t('Age and sex'), label: t('Average age'), kind: 'value', unit: 'years', step: 1, decimals: 1,
    desc: t('Estimated from 5-year age bands (midpoints; 90+ counted as 92.5).'),
    src: { type: 'mean', codes: ALL_AGES, weights: meanAgeWeights } },
  { id: 'young', group: t('Age and sex'), label: t('Aged 0–19'), kind: 'share', desc: t('Share of residents under 20.'), src: ratio(age(1, 4), ALL_AGES) },
  { id: 'working', group: t('Age and sex'), label: t('Aged 20–64'), kind: 'share', desc: t('Share of working-age residents.'), src: ratio(age(5, 13), ALL_AGES) },
  { id: 'senior', group: t('Age and sex'), label: t('Aged 65+'), kind: 'share', desc: t('Share of residents aged 65 and over.'), src: ratio(age(14, 19), ALL_AGES) },
  { id: 'old', group: t('Age and sex'), label: t('Aged 80+'), kind: 'share', desc: t('Share of residents aged 80 and over.'), src: ratio(age(17, 19), ALL_AGES) },
  { id: 'women', group: t('Age and sex'), label: t('Women'), kind: 'diverging', breaks: [0.40, 0.45, 0.48, 0.52, 0.55, 0.60],
    desc: t('Share of women. Grey: balanced (48–52%); blue: more men; red: more women.'), src: ratio(['BBWTOT'], ['BBMTOT', 'BBWTOT']) },
  { id: 'newcomers', group: t('Mobility'), label: t('Newcomers (under 1 year)'), kind: 'share',
    desc: t('Share of residents who have lived in their commune for under one year.'), src: ratio(['BB41'], DURATION) },
  { id: 'longterm', group: t('Mobility'), label: t('Long-standing residents'), kind: 'share',
    desc: t('Share of residents who have lived in their commune for more than 10 years or since birth.'), src: ratio(['BB44', 'BB45'], DURATION) },
  { id: 'fromAbroad', group: t('Mobility'), label: t('Lived abroad a year ago'), kind: 'share',
    desc: t('Share of residents who lived abroad one year earlier.'), src: ratio(['BB54'], PREV) },
  { id: 'fromCanton', group: t('Mobility'), label: t('Lived in another canton a year ago'), kind: 'share',
    desc: t('Share of residents who lived in another canton one year earlier.'), src: ratio(['BB53'], PREV) },
  { id: 'hhSize', group: t('Households'), label: t('Average household size'), kind: 'value', unit: 'persons', step: 0.1, decimals: 2,
    desc: t('Persons per private household (households of 6+ counted as 6, so a slight underestimate).'),
    src: { type: 'mean', codes: HH, weights: [1, 2, 3, 4, 5, 6] } },
  { id: 'single', group: t('Households'), label: t('Single-person households'), kind: 'share',
    desc: t('Share of private households with one person.'), src: ratio(['HP01'], HH) },
  { id: 'dist', group: t('Antennas'), label: t('Distance to nearest antenna site'), kind: 'value', unit: 'm', step: 50, decimals: 0, noMinPop: true,
    desc: t('Straight-line distance to the nearest site passing the antenna filters (blocks: average per resident).'),
    src: { type: 'dist' } },
  { id: 'raw', group: t('All attributes'), label: t('Any of the 77 attributes…'), kind: 'raw' },
];
const METRIC = Object.fromEntries(METRICS.map((m) => [m.id, m]));
// An FSO attribute's name, e.g. "Foreign nationals, total" (the data has them in English).
const attrLabel = (code) => t(META.labels[code]);
const metricDef = () => (Object.hasOwn(METRIC, state.metric) ? METRIC[state.metric] : METRIC.pop);

// Resolve the raw attribute pseudo-metric to a concrete definition.
function activeMetric() {
  const m = metricDef();
  if (m.kind !== 'raw') return m;
  const c = state.rawCol, label = attrLabel(c);
  if (c === 'HPI') return { id: 'raw:HPI', label, kind: 'class', desc: t('{label} (FSO code {code}).', { label, code: c }), src: count('HPI') };
  if (state.rawMode === 'count' || c === 'BBTOT' || c === 'HPTOT') { // a total as a share of itself is always 100 %
    return { id: `raw:${c}:count`, label: t('{label} per hectare', { label }), what: label, kind: 'count',
      desc: t('{label} per hectare (FSO code {code}).', { label, code: c }), src: count(c) };
  }
  const hh = c.startsWith('HP');
  return { id: `raw:${c}:share`, label: t(hh ? '{label} (% of households)' : '{label} (% of residents)', { label }), kind: 'share',
    desc: t(hh ? '{label} as a share of all private households (FSO code {code}).' : '{label} as a share of all residents (FSO code {code}).', { label, code: c }),
    src: ratio([c], [hh ? 'HPTOT' : 'BBTOT']) };
}

// ---------------------------------------------------------------- classification
const valueCache = new Map();
const metricKey = (m) => `${m.id}|${state.excludeNoloc}|${m.src.type === 'dist' ? antVersion : ''}`;
function metricValues(m, g) {
  if (m.kind === 'class' && g.s !== 100) return new Float32Array(g.n).fill(NaN); // classes cannot be aggregated
  const key = `${metricKey(m)}|${g.s}`;
  let v = valueCache.get(key);
  if (v) { valueCache.delete(key); valueCache.set(key, v); return v; } // most recently used last
  valueCache.set(key, (v = computeMetric(m, g)));
  if (valueCache.size > 30) valueCache.delete(valueCache.keys().next().value); // ~1.4 MB per 100 m entry
  return v;
}
// The minimum residents per hectare greys out every metric's small hectares (the distance metric is per resident).
const gated = (m) => !m.noMinPop;

function niceRound(x) { // 1, 2, 2.5, 5 × 10^k
  if (x <= 0) return 0;
  const p = 10 ** Math.floor(Math.log10(x));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.75 ? 2.5 : f < 7.5 ? 5 : 10) * p;
}
function roundShare(x) { // x in 0..1 -> nice percentage
  const pc = x * 100;
  const r = pc >= 10 ? Math.round(pc) : pc >= 1 ? Math.round(pc * 2) / 2 : Math.round(pc * 10) / 10;
  return r / 100;
}
const quantile = (sorted, q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
const uniqAsc = (a) => a.filter((v, i) => v > 0 && (i === 0 || v > a[i - 1]));

function computeBreaks(m, values, valid) {
  if (m.breaks) return { breaks: m.breaks, zeroClass: false };
  const v = [];
  for (let i = 0; i < N; i++) if (valid(i)) v.push(values[i]);
  const s = Float32Array.from(v).sort();
  if (!s.length) return { breaks: [], zeroClass: false };
  if (m.kind === 'class') return { breaks: [2], zeroClass: false };
  if (m.kind === 'count') {
    const pos = s.filter((x) => x >= 4);
    const b = [4, ...range(1, 5).map((k) => niceRound(quantile(pos, k / 6)))];
    return { breaks: uniqAsc(b.sort((a, c) => a - c)), zeroClass: false };
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === 0) zeros++;
  const round = m.kind === 'share' ? roundShare : (x) => Math.round(x / m.step) * m.step;
  let b;
  let zeroClass = false;
  if (zeros / s.length > 1 / 7 && m.kind === 'share') {
    zeroClass = true;
    const pos = s.subarray(zeros);
    b = range(1, 5).map((k) => round(quantile(pos, k / 6)));
    b = [1e-9, ...uniqAsc(b)];
  } else {
    b = uniqAsc(range(1, 6).map((k) => round(quantile(s, k / 7))));
  }
  return { breaks: b, zeroClass };
}

// A unit after the value v, in the language's singular or plural ("1,8 personne" in French, "1.8 persons").
const UNIT_ONE = { years: 'year', persons: 'person' };
const unitOf = (m, v, decimals) => (m.unit === 'm' ? 'm' : t(isOne(v, decimals) ? UNIT_ONE[m.unit] : m.unit));
function fmtValue(m, v, digits) {
  if (Number.isNaN(v)) return '–';
  if (m.kind === 'share' || m.kind === 'diverging') {
    const pc = v * 100;
    return fmtPct(v, digits ?? (pc < 1 && pc > 0 ? 1 : pc < 10 && pc % 1 ? 1 : 0));
  }
  if (m.kind === 'value') return m.unit === 'm' ? fmtM(v) : `${fmtFixed(v, digits ?? m.decimals)} ${unitOf(m, v, digits ?? m.decimals)}`;
  return nf.format(v);
}
// A class boundary with its unit: 12.5%, 4, 1’500 m, 2.4 persons.
const fmtBreak = (m, b) => (m.kind === 'value' ? `${m.unit === 'm' ? nf.format(b) : fmtNum(b)} ${unitOf(m, b)}`
  : m.kind === 'count' ? nf.format(b) : fmtPct(b, 1).replace(/[.,]0(?=\D*$)/, ''));
// "12.5–17%" rather than "12.5%–17%", "1.8–2.1 persons": the unit once, after a range.
const fmtRange = (m, a, b) => {
  const lo = m.kind === 'value' ? (m.unit === 'm' ? nf.format(a) : fmtNum(a)) : fmtBreak(m, a).replace(/[\s\u00a0\u202f]?%$/, '');
  return `${lo}–${fmtBreak(m, b)}`;
};

function classLabels(m, breaks, zeroClass) {
  if (!breaks.length) return []; // nothing to classify: every hectare is shown as "no value"
  if (m.kind === 'class') return [t('1 · all plausible'), t('2 · at least one implausible')];
  if (m.kind === 'count') {
    return [...breaks, Infinity].map((b, k) => (k === 0 ? t('Under {v}', { v: nf.format(b) })
      : b === Infinity ? t('{v} or more', { v: nf.format(breaks[k - 1]) }) : `${nf.format(breaks[k - 1])}–${nf.format(b)}`));
  }
  const labels = [];
  const start = zeroClass ? 1 : 0;
  if (zeroClass) labels.push(m.kind === 'value' ? `0 ${unitOf(m, 0)}` : fmtPct(0));
  const bs = breaks.slice(start);
  labels.push(t('Under {v}', { v: fmtBreak(m, bs[0]) }));
  for (let k = 1; k < bs.length; k++) labels.push(fmtRange(m, bs[k - 1], bs[k]));
  labels.push(t('{v} or more', { v: fmtBreak(m, bs[bs.length - 1]) }));
  return labels;
}

function rampFor(m, nClasses) {
  const mode = basemapDark() ? 'dark' : 'light';
  const full = m.kind === 'diverging' ? DIV[mode] : SEQ[mode];
  if (m.kind === 'class') return [full[1], full[5]];
  if (nClasses >= full.length) return full;
  return range(0, nClasses - 1).map((k) => full[Math.round((k * (full.length - 1)) / Math.max(1, nClasses - 1))]);
}

let CLASSES = null; // legend state: breaks and per-class hectare counts, always at 100 m
let GRID = null;     // grid currently drawn (100 m hectares or an aggregate level)

const classOf = (v, breaks) => { let k = 0; while (k < breaks.length && v >= breaks[k]) k++; return k; };
function validator(m, g) {
  const values = metricValues(m, g), pop = g.col('BBTOT'), gate = gated(m);
  return { values, pop, gate, valid: (i) => pop[i] > 0 && !Number.isNaN(values[i]) && (!gate || pop[i] >= state.minPop) };
}

// Per-grid colours (and 3D heights) for the current classes. Cached per grid size, so the deck.gl
// grid and the terrain tiles (which need several sizes at once) share one computation.
let colorVersion = 0;
const colorCache = new Map();
function bumpColors() { colorVersion++; colorCache.clear(); }
function colorsFor(g) {
  const hit = colorCache.get(g.s);
  if (hit) return hit;
  const { m, breaks, ramp } = CLASSES;
  const { values, pop, valid } = validator(m, g);
  const ha = g.inhabited();
  const na = hexRgb(NA_COLOR[basemapDark() ? 'dark' : 'light']);
  // On dark/imagery basemaps the low end of the ramp is dark; fade it so the map shows through.
  const fade = basemapDark() && m.kind !== 'diverging'
    ? ramp.map((_, k) => Math.round(255 * Math.min(1, 0.45 + (0.55 * k) / Math.max(1, ramp.length - 2)))) : ramp.map(() => 255);
  const cls = new Uint8Array(g.n), colors = new Uint8Array(4 * g.n), elev = new Float32Array(g.n);
  for (let i = 0; i < g.n; i++) {
    const o = 4 * i;
    if (!(pop[i] > 0)) { cls[i] = 255; continue; }
    const k = valid(i) ? classOf(values[i], breaks) : 254;
    cls[i] = k;
    const rgb = k === 254 ? na : ramp[k];
    colors[o] = rgb[0]; colors[o + 1] = rgb[1]; colors[o + 2] = rgb[2];
    colors[o + 3] = state.isolate !== null && state.isolate !== k ? 18 : k === 254 ? 150 : fade[k];
    elev[i] = ha ? pop[i] / ha[i] : pop[i];
  }
  const out = { CLASS: cls, COLORS: colors, ELEV: elev };
  colorCache.set(g.s, out);
  return out;
}

// Class breaks and legend counts are computed on the hectares; coarser grids reuse the same classes.
function classify() {
  bumpColors();
  const m = activeMetric();
  const g = gridFor(100);
  const { values, pop, gate, valid } = validator(m, g);
  const { breaks, zeroClass } = computeBreaks(m, values, valid);
  const nClasses = breaks.length + 1;
  const counts = new Array(nClasses).fill(0);
  let naCount = 0;
  for (let i = 0; i < N; i++) {
    if (!(pop[i] > 0)) continue;
    if (valid(i)) counts[classOf(values[i], breaks)]++; else naCount++;
  }
  const ramp = rampFor(m, nClasses).map(hexRgb);
  const labels = classLabels(m, breaks, zeroClass);
  if (CLASSES && labels.join('|') !== CLASSES.labels.join('|')) state.isolate = null; // other classes now
  CLASSES = { m, breaks, labels, ramp, counts, naCount, gate };
  renderLegend();
  paint();
  prewarm();
}

// Colours for the other zoom levels in idle time, so crossing a level while zooming does not stall.
function prewarm() {
  const version = colorVersion, todo = LEVELS.filter((s) => !colorCache.has(s));
  const idle = self.requestIdleCallback // not in Safari: a 12 ms slice every 50 ms instead
    ?? ((f) => setTimeout(() => { const end = performance.now() + 12; f({ timeRemaining: () => end - performance.now() }); }, 50));
  const step = (deadline) => {
    while (todo.length && version === colorVersion && deadline.timeRemaining() > 6) colorsFor(gridFor(todo.shift()));
    if (todo.length && version === colorVersion) idle(step);
  };
  idle(step);
}

// Colours (and 3D heights) for the grid that matches the current zoom.
function paint() {
  if (!CLASSES) return; // data not loaded yet; classify() paints once it is
  const g = (GRID = gridFor(levelForZoom(map.getZoom())));
  ({ CLASS, COLORS, ELEV } = colorsFor(g));
  // One data object per paint, so re-renders (hover, sliders) don't re-upload the attributes.
  CELL_DATA = {
    length: g.n,
    attributes: {
      getPosition: (g.posAttr ??= { value: g.pos, size: 2 }),
      getFillColor: { value: COLORS, size: 4, normalized: true },
      getElevation: { value: ELEV, size: 1 },
    },
  };
  const res = $('res-note');
  if (isTerrain() && !state.smooth) {
    res.textContent = t('Distant areas use coarser blocks (up to 2 km); counts are averaged per inhabited hectare.');
  } else if (state.smooth) {
    res.textContent = computeSmooth() || CLASSES.m.kind === 'class'
      ? t('Counts are averaged per inhabited hectare; the surface fades where few hectares are inhabited.')
      : t('Smoothing the surface…');
  } else {
    res.textContent = g.s === 100 ? press('Showing 100 m hectares. Click one for details.', 'Showing 100 m hectares. Tap one for details.')
      : CLASSES.m.kind === 'class' ? t('This attribute is shown at 100 m only. Zoom in.')
        : t('Showing {size} blocks; counts are averaged per inhabited hectare. Zoom in for hectares.', { size: blockLabel(g.s) });
  }
  refreshPopTiles();
  render();
}

// ---------------------------------------------------------------- smooth heatmap
let SMOOTH = null; // { key, surface, rgba, tiles, value(p), alpha(p) }
let SURF = null;   // { key, s }: blurred layers, which depend only on the metric and sigma (the slow part)
let smoothVersion = 0;
// The blur runs in a worker when possible; until it answers, the map shows the hectares. One job at a
// time: settings changed meanwhile (say, stepping through metrics) are blurred once it answers.
let smoothWorker = null, workerJob = 0, workerKey = null; // workerKey: the surface being blurred, if any
try {
  smoothWorker = new Worker(new URL('smooth-worker.js', import.meta.url), { type: 'module' });
  smoothWorker.onerror = (e) => { console.warn('smoothing worker failed; smoothing on the main thread', e); smoothWorker = null; workerKey = null; paint(); };
  smoothWorker.onmessage = ({ data }) => {
    const key = workerKey;
    workerKey = null;
    if (!state.smooth) return; // switched off meanwhile: drop the ~150 MB result
    SURF = { key, s: data.surface }; // if the settings changed meanwhile, computeSmooth() drops it and asks again
    paint();
  };
} catch { /* no module workers: smooth on the main thread */ }
// Arrays with buffers of their own: posting a view of the downloaded data would copy all of it (~55 MB).
const ownBuffer = (a) => (a.byteOffset === 0 && a.byteLength === a.buffer.byteLength ? a : a.slice());
function blurLayers(m) {
  const { num, den } = baseParts(m);
  const layers = { num: ownBuffer(num), den: ownBuffer(den), sup: ownBuffer(inhabitedIndicator()) };
  if (gated(m)) layers.pop = Float32Array.from(col('BBTOT'));
  return layers;
}
function computeSmooth() {
  const { m, breaks, ramp } = CLASSES;
  const key = [metricKey(m), state.sigma, state.minPop, basemapDark(), breaks.join(',')].join('|');
  if (SMOOTH?.key === key) return SMOOTH;
  if (m.kind === 'class') { SMOOTH = { key, tiles: [], value: () => NaN, alpha: () => 0 }; return SMOOTH; }
  const t0 = performance.now();
  const gate = gated(m) && state.minPop > 1;
  const surfKey = `${metricKey(m)}|${state.sigma}`;
  if (SURF?.key !== surfKey) {
    SURF = null; // let the old surface go before allocating the new one
    if (SMOOTH) { SMOOTH = null; smoothVersion++; } // never show a surface for other settings meanwhile (terrain tiles too)
    if (smoothWorker) {
      if (workerKey === null) {
        if (workerJob === 0) { // first job: the hectare centres, once
          const E = new Float64Array(N), Nn = new Float64Array(N);
          for (let i = 0; i < N; i++) { E[i] = cellE(i) + 50; Nn[i] = cellN(i) + 50; }
          smoothWorker.postMessage({ centres: { E, N: Nn } }, [E.buffer, Nn.buffer]);
        }
        workerKey = surfKey;
        smoothWorker.postMessage({ id: ++workerJob, layers: blurLayers(m), bbox: BBOX, sigma: state.sigma });
      }
      return null;
    }
    const pts = { n: N, E: (i) => cellE(i) + 50, N: (i) => cellN(i) + 50 };
    SURF = { key: surfKey, s: blurSurface(pts, blurLayers(m), BBOX, state.sigma) };
  }
  const s = SURF.s;
  const perCell = (s.cell / 100) ** 2;                       // hectares per raster cell
  const kernelCells = 2 * Math.PI * s.sigmaCells ** 2;       // effective area of the Gaussian, in raster cells
  const clamp = m.kind === 'share' || m.kind === 'diverging';
  const value = (p) => (s.den[p] > 1e-9 ? (clamp ? Math.min(1, s.num[p] / s.den[p]) : s.num[p] / s.den[p]) : NaN);
  const alpha = (p) => {
    let a = Math.min(1, s.sup[p] / perCell / 0.12) ** 0.8;   // fade where few hectares are inhabited
    if (gate) a *= Math.min(1, (s.pop[p] * kernelCells) / state.minPop);
    return a;
  };
  const rgba = colorize(s, value, alpha, makeColorScale(breaks, ramp));
  SMOOTH = { key, surface: s, rgba, tiles: isTerrain() ? [] : toTiles(s, rgba), value, alpha };
  smoothVersion++;
  console.debug(`smooth surface ${s.W}×${s.H} @ ${s.cell} m in ${Math.round(performance.now() - t0)} ms`);
  return SMOOTH;
}

// ---------------------------------------------------------------- map + layers
const GEO_PROXY = await detectProxy(); // local caching proxy for swisstopo (see remote.js)
const narrow = () => innerWidth <= 720; // phone layout (see style.css)
// swisstopo's WMTS imagery covers about lon 2.8–14.1, lat 43.1–48.9 and answers 400 elsewhere; raster
// sources without bounds (theirs included) would request those tiles whenever the map is zoomed out.
const IMAGERY_BOUNDS = [2.9, 43.1, 14, 48.9];
const boundRasters = (_, style) => ({
  ...style,
  sources: Object.fromEntries(Object.entries(style.sources).map(([id, src]) =>
    [id, src.type === 'raster' && !src.bounds ? { ...src, bounds: IMAGERY_BOUNDS } : src])),
});
const map = new maplibregl.Map({
  transformRequest,
  container: 'map',
  // Without a #map= position in the URL, fit Switzerland next to the panel (above it on phones).
  bounds: [[5.96, 45.82], [10.49, 47.81]],
  fitBoundsOptions: { padding: narrow() ? { top: 84, bottom: 40, left: 8, right: 8 } : { top: 40, bottom: 40, left: 372, right: 60 } },
  minZoom: 5.5,
  maxZoom: 18,
  maxPitch: isTerrain() ? 80 : 70, // as setView(); a lower limit would reject a terrain link's map= (pitch > 70)
  maxBounds: [[2.5, 43], [14, 50.6]], // tall enough for a portrait phone to show the whole country
  hash: 'map',
  attributionControl: false,
  locale: {
    'Map.Title': t('Map. Arrow keys pan, plus and minus zoom; Enter selects the hectare at the centre.'),
    'AttributionControl.ToggleAttribution': t('Show or hide the credits'),
    'NavigationControl.ZoomIn': t('Zoom in'),
    'NavigationControl.ZoomOut': t('Zoom out'),
    'NavigationControl.ResetBearing': t('Drag to rotate the map; click to point north'),
    'GeolocateControl.FindMyLocation': t('Find my location'),
    'GeolocateControl.LocationNotAvailable': t('Location not available'),
  },
});
map.getCanvas().addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || !CLASSES) return;
  const c = map.getCenter(), i = cellAt(...wgsToLv95(c.lng, c.lat));
  if (i >= 0) { e.preventDefault(); selectCell(i); } else announce(t('No residents at the map centre.'));
});
map.setStyle(styleFor(state.basemap), { transformStyle: boundRasters });
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: `${t('Population:')} <a href="${LINKS.fso}" target="_blank" rel="noopener">${t('STATPOP2024, FSO GEOSTAT')}</a> · ${t('Antenna sites:')} <a href="${LINKS.ofcom}" target="_blank" rel="noopener">${t('OFCOM')}</a>`,
}), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
if (isSecureContext && navigator.geolocation) { // browsers only share the position with https pages
  map.addControl(new maplibregl.GeolocateControl({ fitBoundsOptions: { maxZoom: 14 } }), 'bottom-right');
}
if (narrow()) { // the expanded credits would cover the bottom of a phone screen; the (i) button opens them
  const attrib = map.getContainer().querySelector('.maplibregl-ctrl-attrib');
  attrib?.classList.remove('maplibregl-compact-show');
  attrib?.removeAttribute('open');
}
// MapLibre ignores the first callback of its ResizeObserver. A page loaded in a background tab gets that
// callback only when first shown, so a window resized in between left the map at its old size.
const fitCanvas = () => {
  const c = map.getCanvas(), box = map.getContainer();
  if (c.clientWidth !== box.clientWidth || c.clientHeight !== box.clientHeight) map.resize();
};
addEventListener('resize', fitCanvas);
// MapLibre logs errors only when nobody listens; tile requests cancelled by quick zooming or a basemap
// switch surface as AbortErrors, which are expected and not worth a console error.
map.on('error', (e) => { if (e.error?.name !== 'AbortError') console.error(e.error ?? e); });
// With basemap "None" the background and the colour ramps follow the system theme: redo them on a switch.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.basemap === 'none' && CLASSES) setBasemap('none'); });
document.addEventListener('visibilitychange', fitCanvas);

const overlay = new deck.MapboxOverlay({ interleaved: true, layers: [], onHover, onClick });
map.addControl(overlay);

function firstSymbolId() {
  const layers = map.getStyle()?.layers || [];
  return layers.find((l) => l.type === 'symbol')?.id;
}

const ATLAS = ANT.shapeAtlas();
const ATLAS_URL = ATLAS.canvas.toDataURL();
const antSize = (i) => (state.ant.sizeByPower ? [6, 8, 10, 13][A.power[i]] : 9);
// Markers shrink when zoomed out; at country scale 20k full-size markers would hide the population.
const antScale = () => Math.max(0.16, Math.min(1, 0.28 + (map.getZoom() - 7.5) * 0.18));

function antennaLayers(dark) {
  if (!A || !state.ant.show) return [];
  const mode = ANT.COLOR_MODES[state.ant.color];
  const pal = ANT.PALETTE[dark ? 'dark' : 'light'].map(hexRgb);
  const ring = dark ? [26, 26, 25, 255] : [255, 255, 255, 255];
  const common = {
    data: SITE_LIST,
    getPosition: (i) => [A.pos[2 * i], A.pos[2 * i + 1]],
    getIcon: (i) => ANT.SHAPES[mode.of(A, i)],
    iconAtlas: ATLAS_URL,
    iconMapping: ATLAS.mapping,
    sizeUnits: 'pixels',
    sizeScale: antScale(),
    beforeId: state.beforeId, // keep place labels readable on top
  };
  const scale = antScale();
  const layers = [
    new deck.IconLayer({
      ...common, id: 'ant-ring', getSize: (i) => antSize(i) + 3 / scale, getColor: ring,
      visible: scale > 0.5, // a ring on a 2 px dot is just clutter
      updateTriggers: { getIcon: state.ant.color, getSize: [state.ant.sizeByPower, scale], getColor: dark },
    }),
    new deck.IconLayer({
      ...common, id: 'ant', getSize: antSize, getColor: (i) => pal[mode.of(A, i)], opacity: scale < 0.5 ? 0.85 : 1,
      pickable: true, autoHighlight: true, highlightColor: dark ? [255, 255, 255, 160] : [11, 11, 11, 120],
      updateTriggers: { getIcon: state.ant.color, getSize: state.ant.sizeByPower, getColor: [state.ant.color, dark] },
    }),
  ];
  if (state.antenna >= 0) {
    const i = state.antenna;
    layers.push(new deck.ScatterplotLayer({
      id: 'ant-selected', data: [0], getPosition: () => [A.pos[2 * i], A.pos[2 * i + 1]],
      radiusUnits: 'pixels', getRadius: antSize(i) * antScale() / 2 + 5, filled: false, stroked: true,
      lineWidthUnits: 'pixels', getLineWidth: 2.5, getLineColor: dark ? [255, 255, 255, 255] : [11, 11, 11, 255],
      updateTriggers: { getPosition: i, getRadius: [i, state.ant.sizeByPower, GRID?.s], getLineColor: dark },
    }));
  }
  return layers;
}

// Column heights follow the zoom (×1 at zoom 11, halved per level in, doubled per level out, within
// ±3 levels): hectares of 300 residents would otherwise be kilometre-high walls in a city, and 2 km
// blocks (averages per hectare) flat when zoomed out.
const columnScale = () => 2 ** Math.max(-3, Math.min(3, 11 - map.getZoom()));
function render() {
  if (!COLORS) return;
  if (isTerrain()) { overlay.setProps({ layers: [] }); renderTerrainOverlays(); return; }
  const dark = basemapDark();
  const ink = dark ? [255, 255, 255, 255] : [11, 11, 11, 255];
  const layers = [];
  if (state.smooth && SMOOTH?.surface) {
    if (!SMOOTH.tiles.length && SMOOTH.rgba) SMOOTH.tiles = toTiles(SMOOTH.surface, SMOOTH.rgba); // built lazily after terrain mode
    for (const tile of SMOOTH.tiles) {
      layers.push(new deck.BitmapLayer({
        id: `smooth-${tile.id}`, beforeId: state.beforeId, image: tile.image, bounds: tile.bounds, opacity: state.opacity,
        textureParameters: { minFilter: 'linear', magFilter: 'linear' },
      }));
    }
  } else {
    layers.push(new deck.GridCellLayer({
      id: 'cells',
      beforeId: state.beforeId,
      data: CELL_DATA,
      cellSize: GRID.s,
      extruded: state.view === '3d',
      elevationScale: state.heightScale * columnScale(),
      opacity: state.opacity,
      pickable: true,
      autoHighlight: true,
      highlightColor: dark ? [255, 255, 255, 110] : [11, 11, 11, 70],
      material: { ambient: 0.55, diffuse: 0.6, shininess: 16, specularColor: [40, 40, 40] },
    }));
  }
  const c = center();
  if (c && state.scope === 'radius' && !$('detail').hidden) {
    layers.push(new deck.ScatterplotLayer({
      id: 'radius',
      data: [0],
      getPosition: () => lv95ToWgs(c[0], c[1]),
      getRadius: state.radiusKm * 1000,
      radiusUnits: 'meters',
      filled: true,
      getFillColor: [...ink.slice(0, 3), 18],
      stroked: true,
      getLineColor: [...ink.slice(0, 3), 200],
      lineWidthUnits: 'pixels',
      getLineWidth: 1.5,
      updateTriggers: { getPosition: c.join(), getRadius: state.radiusKm, getFillColor: dark, getLineColor: dark },
    }));
  }
  const cm = state.scope === 'commune' && !$('detail').hidden ? communeNow() : null;
  if (cm) {
    layers.push(new deck.PolygonLayer({
      id: 'commune', data: cm.ll, getPolygon: (p) => p,
      filled: true, getFillColor: [...ink.slice(0, 3), 18],
      stroked: true, getLineColor: [...ink.slice(0, 3), 200], lineWidthUnits: 'pixels', getLineWidth: 1.5,
      updateTriggers: { getFillColor: dark, getLineColor: dark },
    }));
  }
  const outlines = [];
  if (state.selected >= 0) outlines.push(squareRing(cellE(state.selected), cellN(state.selected), 100));
  if (state.hoverBlock) outlines.push(squareRing(state.hoverBlock.E, state.hoverBlock.N, state.hoverBlock.s));
  if (outlines.length) {
    layers.push(new deck.PathLayer({
      id: 'outlines', data: outlines, getPath: (d) => d, getColor: ink, widthUnits: 'pixels', getWidth: 2.5,
      updateTriggers: { getColor: dark },
    }));
  }
  layers.push(...antennaLayers(dark));
  overlay.setProps({ layers });
}

// Dimming/desaturating raster basemaps (SWISSIMAGE, national maps) lets the data stand out.
const rasterLayers = () => (map.getStyle()?.layers || []).filter((l) => l.type === 'raster' && l.id !== 'spg-pop').map((l) => l.id);
function applyDim() {
  const ids = rasterLayers();
  $('dim-row').hidden = !ids.length;
  for (const id of ids) {
    map.setPaintProperty(id, 'raster-brightness-max', 1 - state.dim * 0.75);
    map.setPaintProperty(id, 'raster-saturation', -state.dim * 0.8);
  }
}

// isStyleLoaded() is also false while tiles load, so track "style parsed" ourselves.
let styleReady = false;
map.on('style.load', () => {
  styleReady = true;
  state.beforeId = firstSymbolId();
  applyDim();
  if (isTerrain()) installTerrain();
  render();
});

let lastLevel = 0, zoomRaf = 0;
map.on('zoom', () => {
  const lvl = levelForZoom(map.getZoom());
  if (CLASSES && lvl !== lastLevel) { lastLevel = lvl; hideTip(); paint(); return; }
  if (((A && state.ant.show) || state.view === '3d') && !zoomRaf) zoomRaf = requestAnimationFrame(() => { zoomRaf = 0; render(); }); // marker size and column height follow zoom
});

function setBasemap(key) {
  state.basemap = key;
  state.beforeId = undefined; // the old label layer is about to disappear
  render();
  styleReady = false;
  // Terrain must be off while the new style loads: MapLibre would draw it with the new style's projection
  // before that exists ("shaderPreludeCode" of undefined). style.load installs it again.
  try { map.setTerrain(null); } catch { /* the previous style is still loading and has no terrain yet */ }
  map.setStyle(styleFor(key), { diff: false, transformStyle: boundRasters });
  classify(); // ramp orientation depends on the basemap
  renderAntLegend();
  renderDetail();
  saveSettings();
}

// ---------------------------------------------------------------- hover / click
const tip = $('tooltip');
function showTip(x, y, build) {
  tip.replaceChildren();
  build(tip);
  tip.hidden = false;
  const r = tip.getBoundingClientRect();
  const px = x + 14 + r.width > innerWidth ? x - r.width - 14 : x + 14;
  const py = y + 14 + r.height > innerHeight ? y - r.height - 14 : y + 14;
  tip.style.left = `${Math.max(4, px)}px`;
  tip.style.top = `${Math.max(4, py)}px`;
}
const hideTip = () => { tip.hidden = true; };
const tipLines = (x, y, lines) => showTip(x, y, (box) => lines.forEach((l, k) => box.append(el('div', k ? 'tl' : 'tv', l))));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const announce = (msg) => { $('sr-status').textContent = msg; }; // screen readers (one polite live region)
const fmtCount = (v, cell) => (cell && v === 3 ? '1–3' : nf.format(Math.round(v)));
const blockLabel = (s) => (s >= 1000 ? `${s / 1000} km` : `${s} m`);
// Antenna data labels (in English in the data): operators, types, power classes.
const opLabel = (k) => t(A.operatorLabels[k]);
const shortOp = (k) => t({ 'SBB (railway GSM-R)': 'SBB', 'German networks (border)': 'German (border)' }[A.operatorLabels[k]] ?? A.operatorLabels[k]);
const typeLabel = (i) => t(A.types[A.type[i]]);
const powerLabel = (i) => t(A.powers[A.power[i]]);
const POWER_SHORT = ['very low power', 'low power', 'medium power', 'high power'];

function antennaSummary(i) {
  return [A.name[i], `${opLabel(A.op[i])} · ${typeLabel(i)}`, `${ANT.TECH_LABEL(A.tech[i])} · ${t(POWER_SHORT[A.power[i]])}`];
}

// Tooltip for block/hectare i of grid g (shared by the flat deck.gl view and the terrain view).
function cellTip(g, i, x, y) {
  const { m, gate } = CLASSES;
  const raw = metricValues(m, g)[i];
  const v = m.kind === 'count' && Number.isNaN(raw) ? 0 : raw; // counts are NaN where the count is 0
  const pop = g.col('BBTOT')[i];
  const isHa = g.s === 100;
  showTip(x, y, (box) => {
    const hidden = gate && pop < state.minPop; // greyed out on the map
    if (m.kind === 'count') { // the count itself, greyed or not
      box.append(el('div', 'tv', isHa ? fmtCount(v, true) : fmtFixed(v, v < 10 ? 1 : 0)));
      box.append(el('div', 'tl', isHa ? m.what : t('{what} (average per inhabited hectare)', { what: m.what })));
      if (hidden && m.id === 'pop' && isHa) box.append(el('div', 'tl', t('Below the minimum of {n} residents', { n: state.minPop })));
    } else {
      box.append(el('div', 'tv', hidden ? t('Too few residents') : fmtValue(m, v)));
      box.append(el('div', 'tl', m.label));
    }
    if (m.id !== 'pop' || !isHa) {
      const n = fmtCount(pop, isHa);
      const line = isHa ? t('{n} residents', { n }) : t('{n} residents in this {size} block', { n, size: blockLabel(g.s) });
      box.append(el('div', 'tl', hidden ? `${line} ${t('(min. {n})', { n: state.minPop })}` : line));
    }
    if (isHa && NOLOC_OF.has(i)) box.append(el('div', 'tl', t('Commune centre (incl. unlocated residents)')));
    if (!isHa && !isTerrain()) box.append(el('div', 'tl', t('Click to zoom in')));
  });
}
// Tooltip for the smoothed surface at (E, N); returns false where there is nothing to show.
function smoothTip(E, Nn, x, y) {
  const p = pixelAt(SMOOTH.surface, E, Nn);
  const { m } = CLASSES;
  if (p < 0 || SMOOTH.alpha(p) < 0.05 || Number.isNaN(SMOOTH.value(p))) return false;
  const v = SMOOTH.value(p);
  tipLines(x, y, [
    m.kind === 'count' ? fmtFixed(v, v < 10 ? 1 : 0) : fmtValue(m, v),
    m.kind === 'count' ? t('{what} (average per inhabited hectare)', { what: m.what }) : m.label,
    t('Smoothed over {dist}', { dist: fmtM(state.sigma) })]);
  return true;
}
// Grid block under an LV95 point for grid size s (the hectare index when s = 100), or -1.
function blockAt(s, E, Nn) {
  const keyOf = s === 100 ? CELL_OF : gridFor(s).keyOf;
  const b = keyOf.get(Math.floor((E - META.e0) / s) * 65536 + Math.floor((Nn - META.n0) / s));
  return b === undefined ? -1 : b;
}

function onHover(info) {
  if (isTerrain() || !canHover) return; // MapLibre handles pointer events on the terrain (see terrain section)
  const canvas = map.getCanvas();
  if (info.layer?.id === 'ant' && info.index >= 0) {
    canvas.style.cursor = 'pointer';
    tipLines(info.x, info.y, [...antennaSummary(info.object), t('Click for details')]);
    return;
  }
  if (state.smooth && SMOOTH?.surface && info.coordinate) {
    const [E, Nn] = wgsToLv95(info.coordinate[0], info.coordinate[1]);
    const shown = smoothTip(E, Nn, info.x, info.y);
    canvas.style.cursor = shown && cellAt(E, Nn) >= 0 ? 'pointer' : '';
    if (!shown) hideTip();
    return;
  }
  const i = info.index;
  if (info.layer?.id !== 'cells' || i == null || i < 0 || !CLASSES || !CLASS || i >= CLASS.length || CLASS[i] === 255) {
    canvas.style.cursor = '';
    hideTip();
    return;
  }
  canvas.style.cursor = 'pointer';
  cellTip(GRID, i, info.x, info.y);
}

function onClick(info) {
  if (isTerrain()) return;
  if (info.layer?.id === 'ant' && info.index >= 0) { selectAntenna(info.object); return; }
  if (state.smooth) {
    if (!info.coordinate) return;
    const i = cellAt(...wgsToLv95(info.coordinate[0], info.coordinate[1]));
    if (i >= 0) selectCell(i);
    return;
  }
  const i = info.index;
  if (info.layer?.id !== 'cells' || i < 0 || !CLASS || CLASS[i] === 255) return;
  if (GRID.s === 100) { selectCell(i); return; }
  map.flyTo({ center: [GRID.center[2 * i], GRID.center[2 * i + 1]], zoom: Math.max(map.getZoom() + 2, 12.3), duration: 900 });
}

function selectCell(i, pan = true) {
  state.selected = i;
  state.antenna = -1;
  if (state.scope === 'view') state.scope = 'cell';
  openDetail(pan);
  writeHash();
}
function selectAntenna(i) {
  state.antenna = i;
  state.selected = cellAt(A.e[i], A.N[i]);
  if (state.scope !== 'radius' && state.scope !== 'commune') state.scope = 'radius'; // a site's own hectare says little
  openDetail();
  writeHash();
}
// Centre for the radius summary: the selected antenna, else the selected hectare's centre.
function center() {
  if (state.antenna >= 0) return [A.e[state.antenna], A.N[state.antenna]];
  if (state.selected >= 0) return [cellE(state.selected) + 50, cellN(state.selected) + 50];
  return null;
}

// ---------------------------------------------------------------- terrain (swisstopo relief)
// deck.gl layers are not draped by MapLibre's terrain, so in terrain mode the population becomes a
// raster source whose tiles are drawn on demand from our data, and antennas / outlines become
// MapLibre layers. Everything below only runs while state.view === 'terrain'.
const POP_TILES = registerTileProtocol('spgpop', drawPopTile);
let popTilesVersion = '';
const popTilesKey = () => (state.smooth ? `s${smoothVersion}` : `c${colorVersion}`);
const TERRAIN_LAYERS = ['spg-ant-sel', 'spg-ant', 'spg-over-line', 'spg-over-fill', 'spg-pop'];
const TERRAIN_SOURCES = ['spg-ant', 'spg-over', 'spg-pop', 'spg-dem'];

// Fill one 256 px Web-Mercator tile: each pixel's centre is converted to LV95 and looked up in the
// grid that the flat map would use at this zoom (or sampled from the smoothed surface).
function drawPopTile(z, x, y, out) {
  if (!CLASSES) return;
  const n = 2 ** z;
  const west = (x / n) * 360 - 180, east = ((x + 1) / n) * 360 - 180;
  const lat = (row) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n)));
  if (east < BBOX_LL[0] || west > BBOX_LL[2] || lat(y + 1) > BBOX_LL[3] || lat(y) < BBOX_LL[1]) return;
  const smooth = state.smooth && SMOOTH?.rgba ? SMOOTH : null;
  const s = levelForZoom(z + 0.5);
  const keyOf = s === 100 ? CELL_OF : gridFor(s).keyOf;
  const col = smooth ? null : colorsFor(gridFor(s)).COLORS;
  const e0 = META.e0, n0 = META.n0;
  for (let py = 0, o = 0; py < 256; py++) {
    const la = lat(y + (py + 0.5) / 256);
    const p = (la * 3600 - 169028.66) / 10000;
    for (let px = 0; px < 256; px++, o += 4) {
      const lo = ((x + (px + 0.5) / 256) / n) * 360 - 180;
      const l = (lo * 3600 - 26782.5) / 10000; // WGS84 -> LV95, as in geo.js (inlined: hot loop)
      const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
      const Nn = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
      if (smooth) { sampleSmooth(smooth, E, Nn, out, o); continue; }
      const b = keyOf.get(Math.floor((E - e0) / s) * 65536 + Math.floor((Nn - n0) / s));
      if (b === undefined) continue;
      const c = 4 * b;
      out[o] = col[c]; out[o + 1] = col[c + 1]; out[o + 2] = col[c + 2]; out[o + 3] = col[c + 3];
    }
  }
}
// Bilinear sample of the smoothed RGBA raster (alpha-weighted, so edges don't darken).
function sampleSmooth({ surface: sf, rgba }, E, Nn, out, o) {
  const fx = (E - sf.x0) / sf.cell - 0.5, fy = (sf.yTop - Nn) / sf.cell - 0.5;
  const ix = Math.floor(fx), iy = Math.floor(fy);
  if (ix < 0 || iy < 0 || ix + 1 >= sf.W || iy + 1 >= sf.H) return;
  const tx = fx - ix, ty = fy - iy;
  let r = 0, g = 0, b = 0, a = 0;
  for (const [dx, dy, w] of [[0, 0, (1 - tx) * (1 - ty)], [1, 0, tx * (1 - ty)], [0, 1, (1 - tx) * ty], [1, 1, tx * ty]]) {
    const k = 4 * ((iy + dy) * sf.W + ix + dx), wa = w * rgba[k + 3];
    r += rgba[k] * wa; g += rgba[k + 1] * wa; b += rgba[k + 2] * wa; a += wa;
  }
  if (a < 1) return;
  out[o] = r / a; out[o + 1] = g / a; out[o + 2] = b / a; out[o + 3] = a;
}

// Re-request population tiles when colours or the smoothed surface changed.
function refreshPopTiles() {
  if (!isTerrain()) return;
  const src = map.getSource('spg-pop');
  if (!src || popTilesKey() === popTilesVersion) return;
  popTilesVersion = popTilesKey();
  src.setTiles([`${POP_TILES}?v=${popTilesVersion}`]);
  map.setPaintProperty('spg-pop', 'raster-resampling', state.smooth ? 'linear' : 'nearest');
}

let terrainBusy = null;
async function installTerrain() {
  const note = $('terrain-note');
  note.textContent = t('Loading swisstopo terrain…');
  let spec;
  try {
    spec = await terrainSource();
  } catch (e) {
    console.error(e);
    setView('2d');
    note.textContent = t('Could not load the swisstopo terrain; showing the flat map.'); // after setView, which clears it
    return;
  }
  if (!isTerrain() || !styleReady) return; // left terrain mode, or a new style is loading (style.load re-runs this)
  if (!map.getSource('spg-dem')) map.addSource('spg-dem', spec);
  map.setTerrain({ source: 'spg-dem', exaggeration: state.exaggeration });
  const dark = basemapDark();
  map.setSky({
    'sky-color': dark ? '#0d366b' : '#86b6ef', 'horizon-color': dark ? '#383835' : '#f0efec',
    'fog-color': dark ? '#1a1a19' : '#f9f9f7', 'sky-horizon-blend': 0.6, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.8, 'atmosphere-blend': 0.6,
  });
  const before = state.beforeId;
  if (!map.getSource('spg-pop')) {
    popTilesVersion = popTilesKey();
    map.addSource('spg-pop', { type: 'raster', tiles: [`${POP_TILES}?v=${popTilesVersion}`], tileSize: 256, minzoom: 5, maxzoom: 16, bounds: BBOX_LL });
    map.addLayer({ id: 'spg-pop', type: 'raster', source: 'spg-pop',
      paint: { 'raster-opacity': state.opacity, 'raster-resampling': state.smooth ? 'linear' : 'nearest', 'raster-fade-duration': 0 } }, before);
  }
  if (!map.getSource('spg-over')) {
    map.addSource('spg-over', { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
    const ink = dark ? '#ffffff' : '#0b0b0b';
    map.addLayer({ id: 'spg-over-fill', type: 'fill', source: 'spg-over', filter: ['==', ['get', 'kind'], 'radius'],
      paint: { 'fill-color': ink, 'fill-opacity': 0.07 } }, before);
    map.addLayer({ id: 'spg-over-line', type: 'line', source: 'spg-over', filter: ['!=', ['get', 'kind'], 'antenna'],
      paint: { 'line-color': ink, 'line-width': ['match', ['get', 'kind'], 'radius', 1.5, 2.5] } }, before);
  }
  if (A && !map.getSource('spg-ant')) {
    const pal = ANT.PALETTE[dark ? 'dark' : 'light'];
    const { images } = antennaImages(pal, dark ? '#1a1a19' : '#ffffff');
    for (const im of images) if (!map.hasImage(im.id)) map.addImage(im.id, im.data, { pixelRatio: 2 });
    map.addSource('spg-ant', { type: 'geojson', data: antennaGeoJSON() });
    map.addLayer({
      id: 'spg-ant', type: 'symbol', source: 'spg-ant',
      layout: {
        'icon-image': ['get', 'img'], 'icon-allow-overlap': true, 'icon-ignore-placement': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6.8, ['*', ['get', 'sz'], 0.16], 7.5, ['*', ['get', 'sz'], 0.28], 11.5, ['get', 'sz']],
        visibility: state.ant.show ? 'visible' : 'none',
      },
    }, before);
    map.addLayer({ id: 'spg-ant-sel', type: 'circle', source: 'spg-over', filter: ['==', ['get', 'kind'], 'antenna'],
      paint: { 'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2.5, 'circle-stroke-color': dark ? '#ffffff' : '#0b0b0b' } }, before);
  }
  note.textContent = t('Right-drag or Ctrl + drag to tilt and rotate; two fingers on touch screens.');
  renderTerrainOverlays();
}

function removeTerrain() {
  $('terrain-note').textContent = '';
  try {
    for (const id of TERRAIN_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
    map.setTerrain(null);
    for (const id of TERRAIN_SOURCES) if (map.getSource(id)) map.removeSource(id);
  } catch { /* a new basemap style is still loading, so none of these exist yet */ }
}

// Two images per category would be enough; the image id encodes shape and colour (same index).
function antennaGeoJSON() {
  const mode = ANT.COLOR_MODES[state.ant.color];
  return {
    type: 'FeatureCollection',
    features: SITE_LIST.map((i) => {
      const k = mode.of(A, i);
      return { type: 'Feature', geometry: { type: 'Point', coordinates: [A.pos[2 * i], A.pos[2 * i + 1]] },
        properties: { i, img: `ant-${k}-${k}`, sz: (antSize(i) + 3) / 22 } };
    }),
  };
}
function updateTerrainAntennas() {
  if (!isTerrain() || !map.getSource('spg-ant')) return;
  map.getSource('spg-ant').setData(antennaGeoJSON());
  map.setLayoutProperty('spg-ant', 'visibility', state.ant.show ? 'visible' : 'none');
}

function circleRing(cE, cN, r, steps = 96) {
  return Array.from({ length: steps + 1 }, (_, k) => {
    const a = (2 * Math.PI * k) / steps;
    return lv95ToWgs(cE + r * Math.cos(a), cN + r * Math.sin(a));
  });
}
// Selection outline, scatter hover block, radius circle and selected antenna as draped GeoJSON.
function renderTerrainOverlays() {
  const src = map.getSource('spg-over');
  if (!src) return;
  const f = [];
  const c = center();
  if (c && state.scope === 'radius' && !$('detail').hidden) {
    const ring = circleRing(c[0], c[1], state.radiusKm * 1000);
    f.push({ type: 'Feature', properties: { kind: 'radius' }, geometry: { type: 'Polygon', coordinates: [ring] } });
  }
  const cm = state.scope === 'commune' && !$('detail').hidden ? communeNow() : null;
  if (cm) f.push({ type: 'Feature', properties: { kind: 'radius' }, geometry: { type: 'MultiPolygon', coordinates: cm.ll } }); // drawn as the circle
  if (state.selected >= 0) f.push({ type: 'Feature', properties: { kind: 'cell' }, geometry: { type: 'LineString', coordinates: squareRing(cellE(state.selected), cellN(state.selected), 100) } });
  if (state.hoverBlock) f.push({ type: 'Feature', properties: { kind: 'block' }, geometry: { type: 'LineString', coordinates: squareRing(state.hoverBlock.E, state.hoverBlock.N, state.hoverBlock.s) } });
  if (state.antenna >= 0) f.push({ type: 'Feature', properties: { kind: 'antenna' }, geometry: { type: 'Point', coordinates: [A.pos[2 * state.antenna], A.pos[2 * state.antenna + 1]] } });
  src.setData({ type: 'FeatureCollection', features: f });
  if (map.getLayer('spg-pop')) map.setPaintProperty('spg-pop', 'raster-opacity', state.opacity);
}

// Pointer events on the terrain: MapLibre's lngLat accounts for the relief, deck.gl's would not.
function terrainAntennaAt(point) {
  if (!A || !state.ant.show || !map.getLayer('spg-ant')) return -1;
  const hit = map.queryRenderedFeatures([[point.x - 3, point.y - 3], [point.x + 3, point.y + 3]], { layers: ['spg-ant'] })[0];
  return hit ? hit.properties.i : -1;
}
map.on('movestart', () => hideTip());
addEventListener('scroll', () => hideTip(), true); // a panel scrolled under a tapped (touch) tooltip
map.on('mousemove', (e) => {
  if (!isTerrain() || !CLASSES || !canHover) return;
  const canvas = map.getCanvas();
  const ai = terrainAntennaAt(e.point);
  if (ai >= 0) { canvas.style.cursor = 'pointer'; tipLines(e.point.x, e.point.y, [...antennaSummary(ai), t('Click for details')]); return; }
  const [E, Nn] = wgsToLv95(e.lngLat.lng, e.lngLat.lat);
  if (state.smooth && SMOOTH?.surface) {
    const shown = smoothTip(E, Nn, e.point.x, e.point.y);
    canvas.style.cursor = shown && cellAt(E, Nn) >= 0 ? 'pointer' : '';
    if (!shown) hideTip();
    return;
  }
  const s = levelForZoom(Math.round(map.getZoom() + 1) + 0.5), b = blockAt(s, E, Nn); // as drawPopTile at the tile zoom
  if (b < 0 || colorsFor(gridFor(s)).CLASS[b] === 255) { canvas.style.cursor = ''; hideTip(); return; }
  canvas.style.cursor = cellAt(E, Nn) >= 0 ? 'pointer' : '';
  cellTip(gridFor(s), b, e.point.x, e.point.y);
});
map.on('mouseout', () => { if (isTerrain()) hideTip(); });
map.on('click', (e) => {
  if (!isTerrain() || !CLASSES) return;
  const ai = terrainAntennaAt(e.point);
  if (ai >= 0) { selectAntenna(ai); return; }
  const i = cellAt(...wgsToLv95(e.lngLat.lng, e.lngLat.lat));
  if (i >= 0) selectCell(i);
});

// Flat (deck.gl), extruded columns (deck.gl), or draped over the swisstopo terrain.
function setView(v) {
  const prev = state.view;
  state.view = v;
  if (v === 'terrain' && prev !== 'terrain') {
    map.setMaxPitch(80);
    map.easeTo({ pitch: 62, duration: 1000 });
    popTilesVersion = '';
    installTerrain();
  } else if (v !== 'terrain' && prev === 'terrain') {
    removeTerrain();
    map.setMaxPitch(70);
  }
  if (v === '3d') map.easeTo({ pitch: 55, duration: 900 });
  if (v === '2d') map.easeTo({ pitch: 0, bearing: 0, duration: 700 });
  hideTip();
  syncControls();
  paint();
  saveSettings();
}

// ---------------------------------------------------------------- legend & controls
function renderLegend() {
  const { m, labels, ramp, counts, naCount } = CLASSES;
  const box = $('legend');
  box.replaceChildren();
  if (state.smooth) {
    const grad = el('div', 'gradient');
    grad.style.background = `linear-gradient(to right, ${ramp.map((c) => `rgb(${c.join(',')})`).join(', ')})`;
    box.append(grad);
  }
  labels.forEach((label, k) => {
    const b = el('button', `legend-row${state.isolate !== null && state.isolate !== k ? ' off' : ''}${state.smooth ? ' static' : ''}`);
    b.type = 'button';
    b.disabled = state.smooth;
    b.title = state.smooth ? '' : state.isolate === k ? t('Show all classes') : t('Show only this class');
    b.setAttribute('aria-pressed', String(state.isolate === k));
    const sw = el('span', 'sw');
    sw.style.background = `rgb(${ramp[k].join(',')})`;
    b.append(sw, el('span', 'rng', label), el('span', 'cnt', `${nf.format(counts[k])} ha`));
    b.addEventListener('click', () => {
      state.isolate = state.isolate === k ? null : k;
      bumpColors(); renderLegend(); paint();
      $('legend').querySelectorAll('button.legend-row')[k]?.focus(); // the rows were rebuilt
      announce(state.isolate === null ? t('Showing all classes') : tp(counts[k], 'Showing only {label}: {n} hectare', 'Showing only {label}: {n} hectares', { label }));
    });
    box.append(b);
  });
  if (naCount && !state.smooth) {
    const b = el('div', 'legend-row static');
    const sw = el('span', 'sw');
    sw.style.background = NA_COLOR[basemapDark() ? 'dark' : 'light'];
    b.append(sw, el('span', 'rng', naLabel()), el('span', 'cnt', `${nf.format(naCount)} ha`));
    box.append(b);
  }
  const note = el('div', 'legend-note', state.smooth ? t('Hectare counts per class, before smoothing.')
    : m.breaks || m.kind === 'class' ? press('Click a class to show only it.', 'Tap a class to show only it.')
      : press('Each class holds a similar number of hectares. Click one to show only it.', 'Each class holds a similar number of hectares. Tap one to show only it.'));
  box.append(note);
  $('metric-desc').textContent = m.desc || '';
}
// The grey "no value" class, in the legend and under a saved image.
function naLabel() {
  const { m, gate } = CLASSES;
  if (gate && state.minPop > 1) return tp(state.minPop, 'Under {n} resident or no value', 'Under {n} residents or no value');
  return m.kind === 'count' ? '0' : t('No value');
}

function shapeSvg(shape, color) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 18 14');
  svg.setAttribute('class', 'shape');
  svg.setAttribute('aria-hidden', 'true');
  const d = { circle: 'M9 2a5 5 0 1 0 0.01 0Z', square: 'M4.5 2.5h9v9h-9Z', triangle: 'M9 1.5l6 10.5h-12Z', diamond: 'M9 1l6 6-6 6-6-6Z' }[shape];
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', d);
  p.setAttribute('fill', color);
  p.setAttribute('stroke', basemapDark() ? '#1a1a19' : '#ffffff');
  p.setAttribute('stroke-width', '1.2');
  svg.append(p);
  return svg;
}

function renderAntLegend() {
  const box = $('ant-legend');
  box.replaceChildren();
  if (!A) return;
  const mode = ANT.COLOR_MODES[state.ant.color];
  const pal = ANT.PALETTE[basemapDark() ? 'dark' : 'light'];
  const counts = new Array(mode.cats.length).fill(0);
  for (const i of SITES) counts[mode.of(A, i)]++;
  mode.cats.forEach((label, k) => {
    if (state.ant.color !== 'single' && !counts[k]) return;
    const row = el('div', 'legend-row static');
    row.append(shapeSvg(ANT.SHAPES[k], pal[k]), el('span', 'rng', state.ant.color === 'single' ? t('All sites') : t(label)),
      el('span', 'cnt', tp(counts[k], '{n} site', '{n} sites')));
    box.append(row);
  });
  // operator checkbox counts
  document.querySelectorAll('#ant-ops small').forEach((s) => { s.textContent = nf.format(opCounts()[+s.dataset.op]); });
}
let OP_COUNTS = null;
function opCounts() {
  if (OP_COUNTS) return OP_COUNTS;
  OP_COUNTS = new Array(A.operators.length).fill(0);
  for (let i = 0; i < A.n; i++) OP_COUNTS[A.op[i]]++;
  return OP_COUNTS;
}

function antennasChanged() {
  updateSites();
  renderAntLegend();
  updateTerrainAntennas();
  if (activeMetric().src.type === 'dist') classify(); else render();
  updateViewStats();
  renderDetail();
  renderAnalysis();
  saveSettings();
}

function buildControls() {
  const sel = $('metric');
  let group = null, og = null;
  for (const m of METRICS) {
    if (m.src?.type === 'dist' && !A) continue;
    if (m.group !== group) { og = document.createElement('optgroup'); og.label = group = m.group; sel.append(og); } // groups and labels are translated
    const o = el('option', null, m.label);
    o.value = m.id;
    og.append(o);
  }
  if (!Object.hasOwn(METRIC, state.metric) || (state.metric === 'dist' && !A)) state.metric = 'pop';
  sel.value = state.metric;
  sel.addEventListener('change', () => { state.metric = sel.value; state.isolate = null; syncControls(); refresh(); });

  if (!META.columns.includes(state.rawCol)) state.rawCol = DEFAULTS.rawCol;
  if (!SCALES.includes(state.analysisScale)) state.analysisScale = DEFAULTS.analysisScale;
  const raw = $('raw-col');
  const groups = [
    [t('Totals'), ['BBTOT', 'BBMTOT', 'BBWTOT', 'HPTOT']],
    [t('Nationality'), ['BB11', 'BB12', 'BB13', 'BB14', 'BB15', 'BB16']],
    [t('Place of birth'), range(21, 30).map((k) => `BB${k}`)],
    [t('Men by age'), range(1, 19).map((k) => `BBM${pad2(k)}`)],
    [t('Women by age'), range(1, 19).map((k) => `BBW${pad2(k)}`)],
    [t('Time in the commune'), DURATION],
    [t('Residence a year ago'), PREV],
    [t('Households'), [...HH, 'HPI']],
  ];
  for (const [label, codes] of groups) {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const c of codes) { const o = el('option', null, attrLabel(c)); o.value = c; o.title = t('FSO code {code}', { code: c }); g.append(o); }
    raw.append(g);
  }
  raw.value = state.rawCol;
  raw.addEventListener('change', () => { state.rawCol = raw.value; state.isolate = null; refresh(); });
  document.querySelectorAll('[data-raw-mode]').forEach((b) => b.addEventListener('click', () => {
    state.rawMode = b.dataset.rawMode; state.isolate = null; syncControls(); refresh();
  }));

  const minpop = $('minpop');
  minpop.value = state.minPop;
  let raf = 0;
  const minPopChanged = () => { if (gated(activeMetric())) { state.isolate = null; refresh(); } else writeHash(); };
  minpop.addEventListener('input', () => {
    state.minPop = +minpop.value;
    syncControls();
    if (state.smooth) return; // the smooth surface is recoloured once, on release ('change')
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(minPopChanged);
  });
  minpop.addEventListener('change', () => { if (state.smooth) withBusy(minPopChanged); });

  const noloc = $('noloc');
  noloc.checked = state.excludeNoloc;
  noloc.addEventListener('change', () => {
    state.excludeNoloc = noloc.checked;
    ANALYSIS = null;
    refresh();
    renderDetail();
    updateViewStats();
    renderAnalysis();
  });
  $('noloc-hint').textContent =
    t('{n} residents with no exact location are placed at commune centres, creating false peaks.', { n: nf.format(META.noloc.residents) });

  // antennas
  $('ant-block').hidden = !A;
  if (A) {
    const show = $('ant-show');
    show.checked = state.ant.show;
    show.addEventListener('change', () => { state.ant.show = show.checked; syncControls(); updateTerrainAntennas(); render(); updateViewStats(); saveSettings(); });
    if (A.generated) $('ant-date').textContent = `${t('OFCOM data of {date}.', { date: fmtDate(A.generated.slice(0, 10)) })} `;
    const ops = $('ant-ops');
    A.operatorLabels.forEach((label, k) => {
      const lab = el('label', 'check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.ant.ops[k];
      cb.addEventListener('change', () => { state.ant.ops[k] = cb.checked; antennasChanged(); });
      const count = el('small');
      count.dataset.op = k;
      lab.append(cb, ` ${shortOp(k)} `, count);
      lab.title = opLabel(k);
      ops.append(lab);
    });
    for (const [id, prop] of [['ant-tech', 'tech'], ['ant-type', 'type']]) {
      const s = $(id);
      s.value = state.ant[prop];
      s.addEventListener('change', () => { state.ant[prop] = s.value; antennasChanged(); });
    }
    const color = $('ant-color');
    color.value = state.ant.color;
    color.addEventListener('change', () => { state.ant.color = color.value; renderAntLegend(); updateTerrainAntennas(); render(); saveSettings(); });
    const size = $('ant-size');
    size.checked = state.ant.sizeByPower;
    size.addEventListener('change', () => { state.ant.sizeByPower = size.checked; updateTerrainAntennas(); render(); saveSettings(); });
    $('open-analysis').addEventListener('click', openAnalysis);
    $('a-close').addEventListener('click', closeAnalysis);
  }

  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.view !== state.view) setView(b.dataset.view);
  }));
  const exag = $('exag');
  exag.value = state.exaggeration;
  let exagRaf = 0;
  exag.addEventListener('input', () => {
    state.exaggeration = +exag.value;
    syncControls();
    cancelAnimationFrame(exagRaf); // setTerrain rebuilds the terrain: at most once per frame
    exagRaf = requestAnimationFrame(() => {
      if (isTerrain() && map.getSource('spg-dem')) map.setTerrain({ source: 'spg-dem', exaggeration: state.exaggeration });
    });
    saveSettings();
  });
  const smooth = $('smooth');
  smooth.checked = state.smooth;
  smooth.addEventListener('change', () => {
    state.smooth = smooth.checked;
    state.isolate = null;
    if (!state.smooth) SMOOTH = SURF = null; // ~150 MB of rasters
    if (state.smooth && state.view === '3d') { setView('2d'); }
    syncControls(); renderLegend(); withBusy(paint); saveSettings();
  });
  const sigma = $('sigma');
  sigma.value = SIGMAS.indexOf(state.sigma);
  sigma.addEventListener('input', () => { state.sigma = SIGMAS[+sigma.value]; syncControls(); });
  sigma.addEventListener('change', () => { withBusy(paint); saveSettings(); });
  const height = $('height');
  height.value = state.heightScale;
  height.addEventListener('input', () => { state.heightScale = +height.value; syncControls(); render(); saveSettings(); });
  const opacity = $('opacity');
  opacity.value = state.opacity;
  opacity.addEventListener('input', () => { state.opacity = +opacity.value; syncControls(); render(); saveSettings(); });
  const dim = $('dim');
  dim.value = state.dim;
  dim.addEventListener('input', () => { state.dim = +dim.value; syncControls(); applyDim(); saveSettings(); });
  const basemap = $('basemap');
  basemap.value = state.basemap;
  basemap.addEventListener('change', () => setBasemap(basemap.value));

  if (narrow()) setCollapsed(true);
  $('collapse').addEventListener('click', () => setCollapsed(!$('panel').classList.contains('collapsed')));
  $('share').addEventListener('click', shareView);
  const langSel = $('lang');
  langSel.value = lang;
  langSel.addEventListener('change', () => setLang(langSel.value));
  $('save-image').addEventListener('click', saveImage);
  // "/" jumps to the search box, as on many sites.
  addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey || e.target.closest?.('input, select, textarea, [contenteditable]')) return;
    e.preventDefault();
    setCollapsed(false);
    $('search').focus();
  });

  // detail panel
  $('d-close').addEventListener('click', closeDetail);
  document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
    state.scope = b.dataset.scope;
    if (COMMUNE?.status === 'error') COMMUNE = null; // choosing it again retries a failed boundary load
    syncControls(); renderDetail(); render(); saveSettings();
  }));
  const radius = $('radius');
  radius.value = String(state.radiusKm);
  radius.addEventListener('change', () => { state.radiusKm = +radius.value; renderDetail(); render(); saveSettings(); });
  const kpis = document.querySelector('.kpis');
  const summariseView = () => { state.scope = 'view'; openDetail(); };
  kpis.addEventListener('click', summariseView);
  $('sum-view').addEventListener('click', summariseView);
  kpis.title = t('Summarise the current map view');
  kpis.style.cursor = 'pointer';

  document.querySelectorAll('.seg[role="radiogroup"]').forEach((g) => g.addEventListener('keydown', (e) => {
    const d = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[e.key];
    if (!d) return;
    const radios = [...g.querySelectorAll('[role="radio"]:not(:disabled)')], k = radios.indexOf(document.activeElement);
    if (k < 0) return;
    e.preventDefault();
    const next = radios[(k + d + radios.length) % radios.length];
    next.focus();
    next.click();
  }));
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!tip.hidden) { hideTip(); return; } // first Escape dismisses a tooltip
    if (!$('detail').hidden) closeDetail(); else if (!$('analysis').hidden) closeAnalysis();
  });
  syncControls();
}

// Run a slow step after the browser has painted a busy cursor.
function withBusy(fn) {
  document.body.style.cursor = 'progress';
  requestAnimationFrame(() => setTimeout(() => { try { fn(); } finally { document.body.style.cursor = ''; } }, 0));
}

function syncControls() {
  const m = metricDef();
  $('raw-opts').hidden = m.kind !== 'raw';
  const setSeg = (attr, v) => document.querySelectorAll(`[${attr}]`).forEach((b) =>
    b.setAttribute('aria-checked', String(b.getAttribute(attr) === v)));
  setSeg('data-raw-mode', state.rawMode);
  setSeg('data-view', state.view);
  setSeg('data-scope', state.scope);
  $('minpop-out').textContent = state.minPop;
  $('height-out').textContent = `${fmtNum(state.heightScale, 1)}×`;
  $('height').setAttribute('aria-valuetext', tp(state.heightScale, '{n} time', '{n} times', { n: fmtNum(state.heightScale, 1) }));
  $('height-row').hidden = state.view !== '3d' || state.smooth;
  $('exag-row').hidden = !isTerrain();
  $('exag-out').textContent = `${fmtFixed(state.exaggeration, 1)}×`;
  $('sigma-row').hidden = !state.smooth;
  $('sigma-out').textContent = fmtM(state.sigma);
  document.querySelector('[data-view="3d"]').disabled = state.smooth;
  $('radius').hidden = state.scope !== 'radius';
  if ($('ant-body')) $('ant-body').hidden = !state.ant.show;
  document.querySelector('[data-scope="cell"]').disabled = state.selected < 0;
  document.querySelector('[data-scope="radius"]').disabled = !center();
  document.querySelector('[data-scope="commune"]').disabled = !center();
  // Radio groups take one Tab stop (the checked option); arrow keys move within (see buildControls).
  document.querySelectorAll('.seg[role="radiogroup"]').forEach((g) => {
    const radios = [...g.querySelectorAll('[role="radio"]')];
    const on = radios.find((r) => r.getAttribute('aria-checked') === 'true' && !r.disabled) || radios.find((r) => !r.disabled);
    radios.forEach((r) => { r.tabIndex = r === on ? 0 : -1; });
  });
  $('sigma').setAttribute('aria-valuetext', fmtM(state.sigma));
  $('exag').setAttribute('aria-valuetext', t(isOne(state.exaggeration, 1) ? '{n} time' : '{n} times', { n: fmtFixed(state.exaggeration, 1) })); // "1.0 times"
  $('opacity').setAttribute('aria-valuetext', fmtPct(state.opacity));
  $('dim').setAttribute('aria-valuetext', fmtPct(state.dim));
}

function refresh() { // metric, attribute or minPop changed (the detail panel does not depend on them)
  classify();
  saveSettings();
}

// ---------------------------------------------------------------- view statistics
// Is a lon/lat point visible? Flat and north-up: the map's bounds. Rotated or tilted (columns, terrain):
// the quadrilateral under the screen corners, since the bounding box would also count land out of view.
function viewTest() {
  const b = map.getBounds(), w = b.getWest(), s = b.getSouth(), e = b.getEast(), n = b.getNorth();
  const inBox = (x, y) => x >= w && x <= e && y >= s && y <= n;
  if (!map.getPitch() && !map.getBearing()) return inBox;
  const { width, height } = map.getCanvas().getBoundingClientRect();
  // Tilted beyond about 71° (terrain allows 80°), the top of the screen is sky, where unproject() returns
  // points behind the camera and the quadrilateral turns inside out: start it 2° below the horizon.
  const half = height / 2, focal = half / Math.tan((map.getVerticalFieldOfView() * Math.PI) / 360);
  const top = Math.max(0, half - focal * Math.tan((Math.max(1, 88 - map.getPitch()) * Math.PI) / 180));
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = [[0, top], [width, top], [width, height], [0, height]]
    .map((pt) => map.unproject(pt)).map((ll) => [ll.lng, ll.lat]);
  const sg = Math.sign((x1 - x0) * (y2 - y0) - (y1 - y0) * (x2 - x0)); // corner order: clockwise or not
  // Plain arithmetic: this runs for every hectare on each map move.
  return (x, y) => x >= w && x <= e && y >= s && y <= n
    && sg * ((x1 - x0) * (y - y0) - (y1 - y0) * (x - x0)) >= 0 && sg * ((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) >= 0
    && sg * ((x3 - x2) * (y - y2) - (y3 - y2) * (x - x2)) >= 0 && sg * ((x0 - x3) * (y - y3) - (y0 - y3) * (x - x3)) >= 0;
}
function viewIndices() {
  const inView = viewTest(), out = [];
  for (let i = 0; i < N; i++) if (inView(CENTER[2 * i], CENTER[2 * i + 1])) out.push(i);
  return out;
}
function viewSites() {
  const inView = viewTest(), out = [];
  for (const i of SITES) if (inView(A.pos[2 * i], A.pos[2 * i + 1])) out.push(i);
  return out;
}
function updateViewStats() {
  if (!N) return;
  const pop = col('BBTOT');
  let sum = 0, ha = 0;
  for (const i of viewIndices()) { if (pop[i] > 0) { sum += pop[i]; ha++; } }
  $('kpi-view').textContent = nf.format(sum);
  $('kpi-ha').textContent = nf.format(ha);
  $('kpi-ant').textContent = A && state.ant.show ? nf.format(viewSites().length) : '–'; // none drawn when hidden
  if (!$('detail').hidden && state.scope === 'view') renderDetail();
}
let moveTimer = 0;
map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(updateViewStats, 60); });

// ---------------------------------------------------------------- detail panel
const SECTIONS = [
  { title: t('Nationality'), rows: [['BB11', t('Swiss')], ['BB13', t('EU/EFTA')], ['BB14', t('Other European')], ['BB15', t('Outside Europe')], ['BB16', t('Unknown'), true]] },
  { title: t('Place of birth'), rows: [['BB22', t('Commune of residence')], ['BB23', t('Same canton')], ['BB24', t('Other canton')], ['BB25', t('Unknown commune'), true],
    ['BB27', t('EU/EFTA')], ['BB28', t('Other European')], ['BB29', t('Outside Europe')], ['BB30', t('Unknown country'), true]] },
  { title: t('Time in the commune'), rows: [['BB45', t('Since birth')], ['BB44', t('More than 10 years')], ['BB43', t('6–10 years')], ['BB42', t('1–5 years')],
    ['BB41', t('Less than 1 year')], ['BB46', t('Unknown'), true]] },
  { title: t('Residence a year ago'), rows: [['BB51', t('Same commune')], ['BB52', t('Same canton')], ['BB53', t('Other canton')], ['BB54', t('Abroad')],
    ['BB55', t('Not yet born')], ['BB56', t('Unknown'), true]] },
  { title: t('Household size'), rows: HH.map((c, k) => [c, k === 5 ? t('6+ persons') : tp(k + 1, '{n} person', '{n} persons')]) },
];

function scopeIndices() {
  if (state.scope === 'view') return viewIndices();
  if (state.scope === 'commune') return communeNow()?.cells ?? [];
  if (state.scope === 'cell') return state.selected >= 0 ? [state.selected] : [];
  const [cE, cN] = center(), R = state.radiusKm * 1000, R2 = R * R, out = [];
  for (let j = 0; j < N; j++) {
    const dx = cellE(j) + 50 - cE, dy = cellN(j) + 50 - cN;
    if (dx * dx + dy * dy <= R2) out.push(j);
  }
  return out;
}
function scopeSites() {
  if (!A) return [];
  if (state.scope === 'view') return viewSites();
  if (state.scope === 'commune') { const cm = communeNow(); return cm ? SITES.filter((i) => cm.inA[i]) : []; }
  if (state.scope === 'radius') { const [cE, cN] = center(); return ANT.within(A, AIDX, cE, cN, state.radiusKm * 1000); }
  const i = state.selected;
  if (i < 0) return [];
  return ANT.within(A, AIDX, cellE(i) + 50, cellN(i) + 50, 75).filter((j) => cellAt(A.e[j], A.N[j]) === i);
}

function aggregate(indices) {
  const sums = {};
  const pop = col('BBTOT');
  let cells = 0;
  const codes = META.columns.filter((c) => c !== 'HPI');
  for (const c of codes) {
    const a = RAW[c];
    let s = 0;
    for (const i of indices) s += a[i];
    sums[c] = s;
  }
  if (state.excludeNoloc) { // as col(): max(0, raw − unlocated) = raw − min(raw, unlocated), on 1,941 hectares
    const inScope = new Uint8Array(N);
    for (const i of indices) inScope[i] = 1;
    for (let j = 0; j < M; j++) {
      const i = NOLOC_IDX[j];
      if (inScope[i]) for (const c of codes) sums[c] -= Math.min(RAW[c][i], NOLOC[c][j]);
    }
  }
  for (const i of indices) if (pop[i] > 0) cells++;
  return { sums, cells };
}

// Share the current view: the URL already carries it (see writeHash). Phones get the system share
// sheet; elsewhere the link is copied (plain http has no clipboard API, so a prompt shows it).
async function shareView() {
  writeHash();
  const url = location.href;
  try {
    if (navigator.share && !canHover) { await navigator.share({ title: document.title, url }); return; }
    if (navigator.clipboard && isSecureContext) { await navigator.clipboard.writeText(url); toast(t('Link to this view copied')); return; }
  } catch (e) {
    if (e.name === 'AbortError') return; // share sheet dismissed
  }
  try { prompt(t('Copy the link to this view:'), url); } catch { toast(t('Copy the link from the address bar')); } // no dialogs in some embeds
}
let toastTimer = 0;
function toast(msg) {
  const box = $('toast');
  box.textContent = msg;
  box.hidden = false;
  announce(msg);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, 1800);
}

// Files made in the page (an image of the map, the details as CSV) are handed over as downloads.
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
}
const today = () => { // the visitor's date (toISOString() gives the UTC one: yesterday until 01:00 or 02:00 in Switzerland)
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

// The map as a PNG, with a footer that names what it shows and credits the sources, as their terms
// ask. WebGL does not keep a frame once it is on screen, so the canvas is copied in the frame itself.
async function saveImage() {
  if (!CLASSES) return;
  const btn = $('save-image');
  btn.disabled = true;
  toast(t('Preparing the image…'));
  try {
    // wait for tiles still loading (at most 8 s), so the image is not missing parts of the basemap
    if (!map.loaded()) await Promise.race([new Promise((r) => map.once('idle', r)), new Promise((r) => setTimeout(r, 8000))]);
    const src = map.getCanvas();
    const shot = await new Promise((resolve) => {
      map.once('render', () => {
        const c = document.createElement('canvas');
        c.width = src.width; c.height = src.height;
        c.getContext('2d').drawImage(src, 0, 0);
        resolve(c);
      });
      map.triggerRepaint();
    });
    const out = imageWithFooter(shot, src.width / src.clientWidth);
    const blob = await new Promise((resolve, reject) => out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/png'));
    download(`swiss-atlas-${CLASSES.m.id.replace(/\W+/g, '-')}-${today()}.png`, blob);
    toast(t('Image saved'));
  } catch (e) {
    console.error(e);
    toast(t('Could not save the image'));
  } finally {
    btn.disabled = false;
  }
}
function imageWithFooter(shot, k) {
  const css = getComputedStyle(document.documentElement), tok = (n, d) => css.getPropertyValue(n).trim() || d;
  const family = tok('--font', 'system-ui, sans-serif'), muted = tok('--text-muted', '#6e6c66');
  const font = (px, weight = 400) => `${weight} ${px * k}px ${family}`;
  const W = shot.width, pad = 14 * k, line = 20 * k, sw = 11 * k;
  // the footer's contents: a title, legend entries (swatch, label) and the credits
  const { m, labels, ramp, naCount } = CLASSES;
  const legend = state.smooth ? [{ gradient: ramp, label: `${labels[0]} … ${labels.at(-1)}` }]
    : labels.map((label, i) => ({ color: `rgb(${ramp[i].join(',')})`, label }));
  if (naCount && !state.smooth) legend.push({ color: NA_COLOR[basemapDark() ? 'dark' : 'light'], label: naLabel() }); // as in the panel
  if (A && state.ant.show && SITES.length) {
    const mode = ANT.COLOR_MODES[state.ant.color], pal = ANT.PALETTE[basemapDark() ? 'dark' : 'light'];
    const counts = new Array(mode.cats.length).fill(0);
    for (const i of SITES) counts[mode.of(A, i)]++;
    mode.cats.forEach((label, i) => {
      if (counts[i]) legend.push({ color: pal[i], shape: ANT.SHAPES[i], label: state.ant.color === 'single' ? t('Antenna sites') : t(label) });
    });
  }
  const site = `Swiss atlas · ${location.host}${location.pathname}`.replace(/\/$/, '');
  let credits = ($('map').querySelector('.maplibregl-ctrl-attrib-inner')?.textContent || '').replace(/\s*\|\s*/g, ' · ');
  // Lay out twice: once to measure the footer, once to draw it.
  const out = document.createElement('canvas'), g = out.getContext('2d');
  g.font = font(15, 650);
  let title = m.label; // shortened with "…" to the width (long attribute names on a phone)
  while (title.length > 1 && g.measureText(title).width > W - 2 * pad) title = `${title.slice(0, -2).trimEnd()}…`;
  const titleW = g.measureText(title).width;
  g.font = font(12);
  const siteRight = titleW + 24 * k + g.measureText(site).width <= W - 2 * pad; // else it ends the credits
  if (!siteRight) credits += ` · ${site}`;
  const run = (draw) => {
    let y = pad + 15 * k;
    g.textBaseline = 'alphabetic';
    g.font = font(15, 650);
    if (draw) { g.fillStyle = tok('--text-primary', '#0b0b0b'); g.fillText(title, pad, y); }
    g.font = font(12);
    if (draw && siteRight) { g.fillStyle = muted; g.textAlign = 'right'; g.fillText(site, W - pad, y); g.textAlign = 'left'; }
    y += line;
    let x = pad;
    for (const it of legend) {
      const w = (it.gradient ? 90 * k : sw) + 6 * k + g.measureText(it.label).width;
      if (x > pad && x + w > W - pad) { x = pad; y += line; }
      if (draw) drawSwatch(g, it, x, y - sw, sw, k);
      if (draw) { g.fillStyle = tok('--text-secondary', '#52514e'); g.fillText(it.label, x + (it.gradient ? 90 * k : sw) + 6 * k, y); }
      x += w + 16 * k;
    }
    g.font = font(11);
    y += line * 1.1;
    let text = '';
    for (const word of credits.split(' ')) { // wrap the credits
      const next = text ? `${text} ${word}` : word;
      if (text && g.measureText(next).width > W - 2 * pad) { if (draw) { g.fillStyle = muted; g.fillText(text, pad, y); } y += 15 * k; text = word; } else text = next;
    }
    if (draw && text) { g.fillStyle = muted; g.fillText(text, pad, y); }
    return y + pad;
  };
  out.width = W;
  g.font = font(12);
  const footer = Math.ceil(run(false));
  out.height = shot.height + footer; // resizing resets the context
  g.drawImage(shot, 0, 0);
  g.fillStyle = tok('--surface-1', '#fcfcfb');
  g.fillRect(0, shot.height, W, footer);
  g.translate(0, shot.height);
  run(true);
  return out;
}
function drawSwatch(g, it, x, y, s, k) {
  if (it.gradient) {
    const grad = g.createLinearGradient(x, 0, x + 90 * k, 0);
    it.gradient.forEach((c, i) => grad.addColorStop(i / (it.gradient.length - 1), `rgb(${c.join(',')})`));
    g.fillStyle = grad;
    g.fillRect(x, y, 90 * k, s);
    return;
  }
  g.fillStyle = it.color;
  g.beginPath();
  const c = s / 2;
  if (it.shape === 'circle') g.arc(x + c, y + c, c, 0, 2 * Math.PI);
  else if (it.shape === 'triangle') { g.moveTo(x + c, y); g.lineTo(x + s, y + s); g.lineTo(x, y + s); }
  else if (it.shape === 'diamond') { g.moveTo(x + c, y); g.lineTo(x + s, y + c); g.lineTo(x + c, y + s); g.lineTo(x, y + c); }
  else g.rect(x, y, s, s);
  g.fill();
}

// The details as CSV: one row per attribute of the hectare, radius or view. The source column carries
// the attribution the FSO and OFCOM terms ask for; the byte-order mark makes Excel read UTF-8.
function detailCsv() {
  const { sums } = aggregate(scopeIndices());
  const c = center(), i = state.selected, ai = state.antenna, scope = state.scope;
  const place = ai >= 0 ? t('antenna site {name} (E {e}, N {n})', { name: A.name[ai], e: Math.round(A.e[ai]), n: Math.round(A.N[ai]) })
    : c ? `E ${Math.round(c[0])}, N ${Math.round(c[1])}` : '';
  let area;
  if (scope === 'view') {
    const { lng, lat } = map.getCenter();
    area = t('Map view around {lat} N {lon} E, zoom {zoom}', { lat: lat.toFixed(4), lon: lng.toFixed(4), zoom: map.getZoom().toFixed(1) });
  } else if (scope === 'radius') area = t('Within {dist} of {place} (LV95)', { dist: fmtKm(state.radiusKm), place });
  else if (scope === 'commune') {
    const cm = communeNow();
    area = cm ? t('Commune {name}, FSO no. {bfs}, as of 1 January {year}', { name: cm.name, bfs: cm.bfs, year: cm.year }) : t('Commune (not loaded)');
  } else if (ai >= 0) area = t('Hectare of {place} (LV95)', { place });
  else {
    const name = $('d-title').textContent;
    area = t('Hectare E {e}, N {n} (LV95 south-west corner)', { e: cellE(i), n: cellN(i) })
      + (name && name !== t('Hectare') && !name.endsWith('…') ? `, ${name}` : '');
  }
  if (state.excludeNoloc) area += t(', residents without exact location excluded');
  const source = t(META.source);
  const rows = [[t('area'), t('code'), t('attribute'), t('value'), t('source')]];
  for (const code of META.columns) if (code in sums) rows.push([area, code, attrLabel(code), Math.round(sums[code]), source]);
  if (A) {
    const f = state.ant, filtered = f.ops.some((v, k) => !v && opCounts()[k]) || f.tech || f.type;
    rows.push([area, 'SITES', t(filtered ? 'Mobile antenna sites (current filters)' : 'Mobile antenna sites'), scopeSites().length, t('OFCOM')]);
  }
  rows.push([area, 'NOTE', t('The FSO publishes counts of 1–3 as 3, so the parts of a total can add up to slightly more or less.'), '', source]);
  const cell = (v) => (/[",\r\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v));
  return `\ufeff${rows.map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
function setCollapsed(collapsed) {
  $('panel').classList.toggle('collapsed', collapsed);
  $('collapse').setAttribute('aria-expanded', String(!collapsed));
  $('collapse').title = collapsed ? t('Expand panel') : t('Collapse panel');
}
// The part of the map that no panel covers, in map-container pixels (sheet: an open side panel).
function freeArea(sheet) {
  const box = map.getContainer().getBoundingClientRect(), panel = $('panel').getBoundingClientRect();
  const side = sheet && !$(sheet).hidden ? $(sheet).getBoundingClientRect() : null;
  if (narrow()) return { left: 0, right: box.width, top: panel.bottom - box.top, bottom: (side ? side.top : box.bottom) - box.top };
  const open = !$('panel').classList.contains('collapsed');
  return { left: open ? panel.right - box.left : 0, right: (side ? side.left : box.right) - box.left, top: 0, bottom: box.height };
}
// Opening the detail/analysis panel: fold the controls away when the two panels would leave little map
// (phones, where the sheet covers the lower half, and tablets or small windows), then, unless the caller
// moves the map itself, pan so that the selection sits in the free area, away from the panel edges.
function makeRoomFor(sheet, pan = true) {
  const side = $(sheet).getBoundingClientRect();
  if (narrow() || side.left - $('panel').getBoundingClientRect().right < 320) setCollapsed(true);
  const c = center();
  if (!c || !pan) return;
  const p = map.project(lv95ToWgs(c[0], c[1])), f = freeArea(sheet), m = 48;
  if (p.x < f.left + m || p.x > f.right - m || p.y < f.top + m || p.y > f.bottom - m) {
    map.panBy([p.x - (f.left + f.right) / 2, p.y - (f.top + f.bottom) / 2], { duration: 400 });
  }
}
// Focus: a panel opened from a control (search, buttons) takes focus and gives it back on close;
// one opened by clicking the map leaves focus alone.
let returnFocus = null;
function takeFocus(id) {
  const a = document.activeElement;
  if (a && a !== document.body && a !== map.getCanvas() && !$(id).contains(a)) {
    returnFocus = a;
    $(id).focus({ preventScroll: true });
  }
}
function giveBackFocus(id) {
  if (!$(id).contains(document.activeElement)) return;
  const back = returnFocus?.isConnected && returnFocus.getClientRects().length ? returnFocus : map.getCanvas();
  queueMicrotask(() => back.focus({ preventScroll: true }));
}
const syncSide = () => document.body.classList.toggle('side-open', !$('detail').hidden || !$('analysis').hidden);
function openDetail(pan = true) {
  $('analysis').hidden = true;
  $('detail').hidden = false;
  syncSide();
  syncControls();
  renderDetail();
  render();
  makeRoomFor('detail', pan);
  takeFocus('detail');
  writeHash();
}
function closeDetail() {
  giveBackFocus('detail');
  $('detail').hidden = true;
  syncSide();
  state.selected = -1;
  state.antenna = -1;
  lookupCtl?.abort();
  syncControls();
  render();
  writeHash();
}

let lookupCtl = null;
const communeCache = new Map();
async function lookupCommune(E, Nn, target, stillValid, fallback = '') {
  const key = `${Math.floor(E / 100)}:${Math.floor(Nn / 100)}`;
  const show = (txt) => { if (stillValid()) target.textContent = txt; };
  if (communeCache.has(key)) { show(communeCache.get(key)); return; }
  const known = boundaryOf(E, Nn); // a commune boundary already loaded
  if (known) { show(known.name); return; }
  lookupCtl?.abort();
  lookupCtl = new AbortController();
  try {
    const hit = await identifyCommune(E, Nn, false, lookupCtl.signal);
    const name = hit ? communeName(hit.attributes) : t('Commune unknown');
    communeCache.set(key, name);
    show(name);
  } catch (e) {
    if (e.name !== 'AbortError') show(fallback);
  }
}

// ---------------------------------------------------------------- communes
// swissBOUNDARIES3D as on 1 January after the data's reference date (STATPOP 2024: 31 Dec 2024, so
// 2025): the communes the FSO counted in. Without a year the API answers with every year since 1850.
async function identifyCommune(E, Nn, geometry, signal) {
  const now = new Date().getFullYear();
  for (const year of new Set([META.year + 1, now, now - 1])) { // later years, should that one be missing
    const url = geoUrl('https://api3.geo.admin.ch/rest/services/api/MapServer/identify?' + new URLSearchParams({
      geometry: `${E},${Nn}`, geometryType: 'esriGeometryPoint', sr: '2056', tolerance: '0', timeInstant: String(year),
      returnGeometry: String(geometry), geometryFormat: 'geojson', layers: 'all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill', lang,
    }));
    const res = await fetch(url, { signal });
    if (!res.ok) throw new Error(`commune lookup: HTTP ${res.status}`);
    const hit = (await res.json()).results?.[0];
    if (hit) return { ...hit, attributes: hit.attributes || hit.properties };
  }
  return null;
}
// A commune's boundary by its FSO number (search results carry it), for the same years as above.
async function communeById(bfs, signal) {
  const now = new Date().getFullYear();
  for (const year of new Set([META.year + 1, now, now - 1])) {
    const url = geoUrl(`https://api3.geo.admin.ch/rest/services/api/MapServer/ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill/${bfs}-${year}?`
      + new URLSearchParams({ geometryFormat: 'geojson', sr: '2056', lang }));
    const res = await fetch(url, { signal });
    if (res.status === 404) continue; // no boundary for that year
    if (!res.ok) throw new Error(`commune ${bfs}: HTTP ${res.status}`);
    const f = (await res.json()).feature;
    if (f?.geometry) return { ...f, attributes: f.properties };
  }
  return null;
}
const communeName = (a) => (a.gemname.includes(`(${a.kanton})`) ? a.gemname : `${a.gemname} (${a.kanton})`);

// The commune scope: hectares (and antenna sites) whose centre lies inside the selection's commune.
const boundaries = new Map(); // featureId -> boundary
let COMMUNE = null;           // { at, status: 'loading' | 'ok' | 'none' | 'error', ...boundary }
let communeCtl = null;
const pointKey = (E, Nn) => `${Math.floor(E / 100)}:${Math.floor(Nn / 100)}`;
function boundaryFrom(hit) {
  const g = hit.geometry, a = hit.attributes;
  const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates; // [[outer, ...holes], …], LV95
  const { inside } = areaTest(polys);
  const cells = [];
  for (let i = 0; i < N; i++) if (inside(cellE(i) + 50, cellN(i) + 50)) cells.push(i);
  const inA = new Uint8Array(A ? A.n : 0);
  for (let i = 0; i < inA.length; i++) inA[i] = inside(A.e[i], A.N[i]) ? 1 : 0;
  return {
    id: hit.featureId ?? hit.id, name: communeName(a), bfs: a.gde_nr, year: a.jahr, inside, cells, inA,
    ll: polys.map((p) => p.map((r) => r.map(([x, y]) => lv95ToWgs(x, y)))),
  };
}
function keepBoundary(b) {
  boundaries.set(b.id, b);
  if (boundaries.size > 20) boundaries.delete(boundaries.keys().next().value);
  return b;
}
// A commune picked in the search: its summary, anchored on the inhabited hectare nearest the searched
// point that lies inside it (the nearest hectare overall can belong to a neighbour, or to France).
async function openCommune(bfs, E, Nn) {
  const nearest = (cells) => {
    let best = -1, bestD = Infinity;
    for (const j of cells) {
      const d = (cellE(j) + 50 - E) ** 2 + (cellN(j) + 50 - Nn) ** 2;
      if (d < bestD) { bestD = d; best = j; }
    }
    return best;
  };
  const known = [...boundaries.values()].find((b) => b.bfs === bfs);
  const first = nearest(known?.cells.length ? known.cells : range(0, N - 1)); // the panel opens at once
  if (first < 0) return;
  state.scope = 'commune';
  // Known: that commune, even when the anchor lies outside it (a forest commune has no inhabited hectare).
  // Else loading, so that no lookup by point starts meanwhile.
  COMMUNE = known ? { ...known, at: pointKey(cellE(first) + 50, cellN(first) + 50), status: 'ok' }
    : { at: pointKey(cellE(first) + 50, cellN(first) + 50), status: 'loading' };
  selectCell(first, false);
  if (known) return;
  communeCtl?.abort();
  communeCtl = new AbortController();
  const at = COMMUNE.at;
  try {
    const hit = await communeById(bfs, communeCtl.signal);
    if (COMMUNE?.at !== at || state.selected !== first) return; // another selection meanwhile
    if (!hit) throw new Error(`commune ${bfs}: no boundary`);
    const b = keepBoundary(boundaryFrom(hit));
    const anchor = b.cells.length ? nearest(b.cells) : first;
    COMMUNE = anchor === first ? { ...b, at, status: 'ok' } : null; // else selectCell below finds it in boundaries
    if (anchor !== first) selectCell(anchor, false);
    else if (state.scope === 'commune') { renderDetail(); render(); }
  } catch (e) {
    if (e.name === 'AbortError') return;
    console.warn(e);
    if (COMMUNE?.at !== at) return;
    COMMUNE = null; // look the commune up by the point instead
    if (state.scope === 'commune') { renderDetail(); render(); }
  }
}
function boundaryOf(E, Nn) {
  for (const b of boundaries.values()) if (b.inside(E, Nn)) return b;
  return null;
}
// The loaded commune for the current selection, or null (see ensureCommune).
function communeNow() {
  const c = center();
  return c && COMMUNE?.status === 'ok' && COMMUNE.at === pointKey(c[0], c[1]) ? COMMUNE : null;
}
function ensureCommune() {
  const c = center();
  if (!c || !N) return;
  const at = pointKey(c[0], c[1]);
  if (COMMUNE?.at === at) return; // also after an error: retried only when the user picks the scope again
  const known = boundaryOf(c[0], c[1]);
  if (known) { COMMUNE = { ...known, at, status: 'ok' }; return; }
  COMMUNE = { at, status: 'loading' };
  communeCtl?.abort();
  communeCtl = new AbortController();
  const done = (next) => {
    if (COMMUNE?.at !== at) return;
    COMMUNE = next;
    if (state.scope !== 'commune') return; // left meanwhile: keep the panel (focus, scroll) as it is
    renderDetail();
    render();
    if (next.status === 'ok') announce(t('{name}: commune boundary loaded', { name: next.name }));
  };
  identifyCommune(c[0], c[1], true, communeCtl.signal).then((hit) => {
    if (!hit?.geometry) { done({ at, status: 'none' }); return; }
    done({ ...keepBoundary(boundaryFrom(hit)), at, status: 'ok' });
  }, (e) => {
    if (e.name === 'AbortError') return;
    console.warn(e);
    done({ at, status: 'error' });
  });
}

function renderDetail() {
  if ($('detail').hidden) return;
  const body = $('d-body');
  body.replaceChildren();
  $('d-sub').title = '';
  const scope = state.scope;
  const isCell = scope === 'cell';
  if (scope === 'commune') ensureCommune();
  const cm = scope === 'commune' ? communeNow() : null;
  const idx = scopeIndices();
  const { sums, cells } = aggregate(idx);
  const i = state.selected, ai = state.antenna;
  const c = center();

  if (ai >= 0) {
    $('d-title').textContent = A.name[ai];
    $('d-sub').textContent = `${opLabel(A.op[ai])} · `;
    const commune = el('span', null, '…');
    $('d-sub').append(commune);
    lookupCommune(A.e[ai], A.N[ai], commune, () => state.antenna === ai);
    body.append(antennaProps(ai));
    const h = el('h3', 'scope-h', scope === 'view' ? t('Current map view') : isCell ? t('This site’s hectare')
      : scope === 'commune' ? (cm ? t('Its commune: {name}', { name: cm.name }) : t('Its commune')) : t('Within {dist} of this site', { dist: fmtKm(state.radiusKm) }));
    body.append(h);
  } else if (scope === 'view') {
    $('d-title').textContent = t('Current map view');
    $('d-sub').textContent = inhabited(cells);
  } else if (scope === 'commune') {
    $('d-title').textContent = cm ? cm.name : COMMUNE?.status === 'loading' ? t('Loading commune…') : t('Commune');
    $('d-sub').textContent = cm ? inhabited(cells) : ''; // no density: the boundaries include lakes
  } else if (isCell) {
    $('d-title').textContent = t('Loading commune…');
    $('d-sub').textContent = t('E {e} · N {n} (LV95)', { e: fmtCoord(cellE(i)), n: fmtCoord(cellN(i)) });
    $('d-sub').title = t('Swiss LV95 coordinates of the hectare’s south-west corner');
    lookupCommune(cellE(i) + 50, cellN(i) + 50, $('d-title'), () => state.selected === i && state.antenna < 0 && state.scope === 'cell', t('Hectare'));
  } else {
    $('d-title').textContent = t('Within {dist}', { dist: fmtKm(state.radiusKm) });
    $('d-sub').textContent = density(cells, sums.BBTOT);
  }
  if (scope === 'commune' && !cm) {
    body.append(el('p', 'note', COMMUNE?.status === 'loading' ? t('Loading the commune boundary from geo.admin.ch…')
      : COMMUNE?.status === 'none' ? t('No commune here (a lake, or outside Switzerland).') : t('Could not load the commune boundary from geo.admin.ch.')));
    return;
  }
  if (ai >= 0 && scope === 'commune') body.append(el('p', 'note', inhabited(cells)));
  if (ai >= 0 && scope === 'radius') body.append(el('p', 'note', density(cells, sums.BBTOT)));

  const residents = sums.BBTOT;
  if (A) body.append(antennaSection(sums, isCell));
  if (!residents) {
    body.append(el('p', 'note', isCell || scope === 'view' ? t('No residents here.') : t('No residents in this area.')));
    return;
  }
  const agesSum = ALL_AGES.reduce((s, k) => s + sums[k], 0);
  const meanAge = ALL_AGES.reduce((s, k, j) => s + sums[k] * meanAgeWeights[j], 0) / agesSum;
  const hhSum = HH.reduce((s, k) => s + sums[k], 0);
  const hhSize = HH.reduce((s, k, j) => s + sums[k] * (j + 1), 0) / hhSum;
  const share = (a, b) => (b > 0 ? a / b : NaN);
  const shareM = { kind: 'share' };

  const tiles = el('div', 'tiles');
  const tile = (v, l, ch) => {
    const box = el('div', 'tile');
    box.append(el('span', 'v', v), el('span', 'l', l));
    if (ch) { // the same figure for Switzerland, for comparison
      const ref = el('span', 'ref');
      ref.title = t('Switzerland, from the same hectare data (where small counts are rounded up to 3)');
      const abbr = el('span', null, 'CH ');
      abbr.setAttribute('aria-hidden', 'true');
      ref.append(abbr, el('span', 'sr-only', t('Switzerland:') + ' '), ch);
      box.append(ref);
    }
    tiles.append(box);
  };
  const ch = national();
  tile(fmtCount(residents, isCell), t('residents'));
  tile(fmtCount(sums.HPTOT, isCell), t('households'));
  tile(Number.isFinite(hhSize) ? fmtFixed(hhSize, 2) : '–', t('household size'), fmtFixed(ch.hhSize, 2));
  tile(fmtValue(shareM, share(sums.BB12, sums.BB11 + sums.BB12), 0), t('foreign nationals'), fmtValue(shareM, ch.foreign, 0));
  tile(Number.isFinite(meanAge) ? fmtFixed(meanAge, 1) : '–', t('average age'), fmtFixed(ch.meanAge, 1));
  tile(fmtValue(shareM, share(age(14, 19).reduce((s, k) => s + sums[k], 0), agesSum), 0), t('aged 65+'), fmtValue(shareM, ch.old, 0));
  body.insertBefore(tiles, body.querySelector('.ant-sec'));

  if (isCell && NOLOC_OF.has(i)) {
    const j = NOLOC_OF.get(i);
    const placed = t('Commune centre: the FSO placed {n} residents with no exact location on this hectare.', { n: nf.format(NOLOC.BBTOT[j]) });
    body.append(el('div', 'badge', state.excludeNoloc ? `${placed} ${t('They are excluded above.')}` : placed));
  }
  if (isCell && residents < 20) {
    body.append(el('p', 'note', t('Few residents: counts of 1–3 are published as 3, so shares here are rough.')));
  }

  body.append(pyramid(sums, isCell));
  for (const sec of SECTIONS) body.append(barSection(sec, sums, isCell));

  const links = el('div', 'links');
  const csv = el('button', 'link-btn', t('Download as CSV'));
  csv.type = 'button';
  csv.addEventListener('click', () => download(`swiss-atlas-${scope === 'cell' ? 'hectare' : scope}-${today()}.csv`,
    new Blob([detailCsv()], { type: 'text/csv;charset=utf-8' })));
  links.append(csv);
  body.append(links);
  if (c && scope !== 'view') {
    const a = el('a', null, `${t('Open in map.geo.admin.ch')} `);
    const arrow = el('span', null, '↗');
    arrow.setAttribute('aria-hidden', 'true');
    a.append(arrow, el('span', 'sr-only', ` ${t('(opens in a new tab)')}`));
    a.href = `https://map.geo.admin.ch/#/map?lang=${lang}&center=${Math.round(c[0])},${Math.round(c[1])}&z=10&layers=ch.bakom.standorte-mobilfunkanlagen`;
    a.target = '_blank';
    a.rel = 'noopener';
    links.append(a);
  }
  if (cm) {
    body.append(el('p', 'note', t('Hectares whose centre lies in {name} as of 1 January {year} (swissBOUNDARIES3D).', { name: cm.name, year: cm.year })));
  }
  if (!isCell) {
    body.append(el('p', 'note', t('Sums of hectare values. Counts of 1–3 are published as 3, so totals run slightly high.')));
  }
}
const inhabited = (cells) => tp(cells, '{n} inhabited hectare', '{n} inhabited hectares');
const density = (cells, pop) => `${inhabited(cells)} · ${t('{n} residents/km²', { n: nf.format(Math.round(pop / (Math.PI * state.radiusKm ** 2))) })}`;

// Switzerland as a whole, from the same hectare data (so with the same rounding of small counts).
let NATIONAL = null;
function national() {
  if (NATIONAL) return NATIONAL;
  const tot = META.totals, sum = (keys, w = () => 1) => keys.reduce((s, k, j) => s + tot[k] * w(j), 0);
  const ages = sum(ALL_AGES);
  NATIONAL = {
    hhSize: sum(HH, (j) => j + 1) / sum(HH),
    foreign: tot.BB12 / (tot.BB11 + tot.BB12),
    meanAge: sum(ALL_AGES, (j) => meanAgeWeights[j]) / ages,
    old: sum(age(14, 19)) / ages,
  };
  return NATIONAL;
}

function antennaProps(i) {
  const dl = el('dl', 'props');
  const row = (k, v) => dl.append(el('dt', null, k), el('dd', null, v));
  row(t('Type'), typeLabel(i));
  row(t('Technology'), ANT.TECH_LABEL(A.tech[i]));
  row(t('Power class'), powerLabel(i));
  row(t('Adaptive antennas'), A.adaptive[i] ? t('Partly adaptive') : t('No'));
  row(t('Permit'), A.exempt[i] ? t('Exempt from precautionary limits (low power, location or short-term use)')
    : A.date[i] ? t('Site data sheet, {date}', { date: fmtDate(A.date[i]) }) : '–');
  row(t('Installation limit'), A.limit[i] != null ? `${fmtNum(A.limit[i], 1)} V/m` : '–');
  row(t('Coordinates (LV95)'), `E ${fmtCoord(A.e[i])} · N ${fmtCoord(A.N[i])}`);
  const pop = col('BBTOT');
  const within = (r) => {
    let s = 0;
    for (let j = 0; j < N; j++) {
      const dx = cellE(j) + 50 - A.e[i], dy = cellN(j) + 50 - A.N[i];
      if (dx * dx + dy * dy <= r * r) s += pop[j];
    }
    return s;
  };
  row(t('Residents nearby'), t('{a} within 500 m · {b} within 1 km', { a: nf.format(within(500)), b: nf.format(within(1000)) }));
  return dl;
}

function antennaSection(sums, isCell) {
  const wrap = el('div', 'sec ant-sec');
  const sites = scopeSites();
  const f = state.ant;
  const filtered = f.ops.some((v, k) => !v && opCounts()[k]) || f.tech || f.type;
  wrap.append(el('h3', null, t(filtered ? 'Antenna sites (current filters)' : 'Antenna sites')));
  if (isCell) {
    const i = state.selected, [j, d] = i >= 0 ? ANT.nearest(A, AIDX, cellE(i) + 50, cellN(i) + 50) : [-1, Infinity];
    const p = el('p', 'note');
    const nearest = j >= 0 && t('Nearest: {dist} — {name} ({type}, {tech}).', { dist: fmtM(d), name: A.name[j], type: typeLabel(j), tech: ANT.TECH_LABEL(A.tech[j]) });
    p.textContent = j < 0 ? t('No antenna site matches the filters.')
      : sites.length ? `${tp(sites.length, '{n} site in this hectare.', '{n} sites in this hectare.')} ${nearest}` : nearest;
    wrap.append(p);
    return wrap;
  }
  const byOp = new Array(A.operators.length).fill(0);
  for (const i of sites) byOp[A.op[i]]++;
  const p = el('p', 'note', tp(sites.length, '{n} site', '{n} sites')
    + (sites.length && sums.BBTOT ? ` · ${t('{n} residents per site', { n: nf.format(Math.round(sums.BBTOT / sites.length)) })}` : ''));
  wrap.append(p);
  const max = Math.max(...byOp, 1);
  A.operatorLabels.forEach((_, k) => {
    if (!byOp[k] && !f.ops[k]) return;
    const r = el('div', 'brow');
    const track = el('div', 'track'), fill = el('div', 'fill');
    fill.style.width = `${(byOp[k] / max) * 100}%`;
    track.append(fill);
    const val = el('div', 'bv', nf.format(byOp[k]));
    if (sites.length) { val.append(' '); val.append(el('small', null, fmtPct(byOp[k] / sites.length))); }
    r.title = opLabel(k);
    r.append(el('div', 'bl', shortOp(k)), track, val);
    wrap.append(r);
  });
  return wrap;
}

function barSection(sec, sums, isCell) {
  const wrap = el('div', 'sec');
  wrap.append(el('h3', null, sec.title));
  const rows = sec.rows.filter(([c, , optional]) => !optional || sums[c] > 0);
  const total = rows.reduce((s, [c]) => s + sums[c], 0);
  const max = Math.max(...rows.map(([c]) => sums[c]), 1);
  for (const [c, label] of rows) {
    const v = sums[c];
    const r = el('div', 'brow');
    r.title = attrLabel(c);
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = `${(v / max) * 100}%`;
    track.append(fill);
    const val = el('div', 'bv', fmtCount(v, isCell));
    if (!isCell && total > 0) { val.append(' '); val.append(el('small', null, fmtPct(v / total))); }
    r.append(el('div', 'bl', label), track, val);
    wrap.append(r);
  }
  return wrap;
}

function pyramid(sums, isCell) {
  const wrap = el('div', 'sec');
  wrap.append(el('h3', null, t('Age and sex')));
  const key = el('div', 'pyr-key');
  key.append(el('span', 'm', t('Men {n}', { n: fmtCount(sums.BBMTOT, isCell) })), el('span', 'w', t('Women {n}', { n: fmtCount(sums.BBWTOT, isCell) })));
  wrap.append(key);

  const W = 340, mid = 40, side = (W - mid) / 2, rowH = 10, gap = 2, bands = META.ageBands.length;
  const H = bands * (rowH + gap) + 14;
  const men = range(1, bands).map((k) => sums[`BBM${pad2(k)}`]);
  const women = range(1, bands).map((k) => sums[`BBW${pad2(k)}`]);
  const max = Math.max(...men, ...women, 1);
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('class', 'pyr');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', t('Population pyramid by 5-year age band'));
  const mk = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (text != null) n.textContent = text;
    svg.append(n);
    return n;
  };
  // Bar with rounded outer end only (anchored at the centre axis).
  const barPath = (x0, w, y, dir) => {
    if (w <= 0) return '';
    const r = Math.min(3, w, rowH / 2), x1 = x0 + dir * w;
    return dir > 0
      ? `M${x0},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + rowH - r}Q${x1},${y + rowH} ${x1 - r},${y + rowH}H${x0}Z`
      : `M${x0},${y}H${x1 + r}Q${x1},${y} ${x1},${y + r}V${y + rowH - r}Q${x1},${y + rowH} ${x1 + r},${y + rowH}H${x0}Z`;
  };
  for (let k = 0; k < bands; k++) {
    const y = (bands - 1 - k) * (rowH + gap);
    const wm = (men[k] / max) * (side - 2), ww = (women[k] / max) * (side - 2);
    mk('path', { class: 'm', d: barPath(side, wm, y, -1) });
    mk('path', { class: 'w', d: barPath(side + mid, ww, y, 1) });
    if (k % 2 === 0 || bands < 12) mk('text', { x: W / 2, y: y + rowH - 1, 'text-anchor': 'middle' }, META.ageBands[k]);
    const hit = mk('rect', { class: 'hit', x: 0, y: y - gap / 2, width: W, height: rowH + gap });
    hit.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, (box) => {
      box.append(el('div', 'tv', t('Age {band}', { band: META.ageBands[k] })));
      const row = (cls, label, v) => {
        const d = el('div', 'tl');
        const kk = el('span', 'tk');
        kk.style.background = `var(--series-${cls})`;
        d.append(kk, `${label} `, el('b', null, fmtCount(v, isCell)));
        return d;
      };
      box.append(row(1, t('Men'), men[k]), row(2, t('Women'), women[k]));
    }));
    hit.addEventListener('pointerleave', hideTip);
  }
  const yAxis = bands * (rowH + gap) + 10;
  mk('text', { x: 0, y: yAxis, 'text-anchor': 'start' }, fmtCount(max, false));
  mk('text', { x: side, y: yAxis, 'text-anchor': 'end' }, '0');
  mk('text', { x: side + mid, y: yAxis, 'text-anchor': 'start' }, '0');
  mk('text', { x: W, y: yAxis, 'text-anchor': 'end' }, fmtCount(max, false));
  wrap.append(svg);
  const more = el('details', 'pyr-table');
  more.append(el('summary', null, t('Age bands as a table')));
  const table = el('table', 'data');
  const head = el('tr');
  for (const h of [t('Age'), t('Men'), t('Women')]) { const th = el('th', null, h); th.scope = 'col'; head.append(th); }
  table.append(head);
  for (let k = bands - 1; k >= 0; k--) {
    const row = el('tr');
    const th = el('th', null, META.ageBands[k]);
    th.scope = 'row';
    row.append(th, el('td', null, fmtCount(men[k], isCell)), el('td', null, fmtCount(women[k], isCell)));
    table.append(row);
  }
  more.append(table);
  wrap.append(more);
  return wrap;
}

// ---------------------------------------------------------------- antennas vs population
const SCALES = [500, 1000, 2000, 5000, 10000];
let ANALYSIS = null; // cached statistics for the current filters

function computeAnalysis() {
  if (ANALYSIS) return ANALYSIS;
  const pop = col('BBTOT');
  const byScale = {};
  for (const s of SCALES) {
    const g = gridFor(s);
    const pairs = blockPairs(g, g.col('BBTOT'), A, SITES, META.e0, META.n0);
    byScale[s] = { pairs, ...correlate(pairs) };
  }
  let total = 0, uninhabited = 0;
  for (let i = 0; i < N; i++) total += pop[i];
  for (const i of SITES) if (cellAt(A.e[i], A.N[i]) < 0) uninhabited++;
  ensureDist();
  ANALYSIS = { byScale, curve: distanceCurve(DIST, pop), total, uninhabited };
  return ANALYSIS;
}

function openAnalysis() {
  $('detail').hidden = true;
  state.selected = -1;
  state.antenna = -1;
  $('analysis').hidden = false;
  syncSide();
  renderAnalysis();
  render();
  makeRoomFor('analysis');
  takeFocus('analysis');
  writeHash(); // the selection is gone
}
function closeAnalysis() {
  giveBackFocus('analysis');
  $('analysis').hidden = true;
  syncSide();
  state.hoverBlock = null;
  render();
}

function renderAnalysis() {
  if ($('analysis').hidden || !A) return;
  const body = $('a-body');
  body.replaceChildren();
  if (!SITES.length) { body.append(el('p', 'note', t('No antenna site matches the filters.'))); return; }
  const t0 = performance.now();
  const R = computeAnalysis();
  $('a-sub').textContent = `${tp(SITES.length, '{n} site (current filters)', '{n} sites (current filters)')} · ${t('{n} residents', { n: nf.format(R.total) })}`;
  const tip2 = (x, y, lines) => tipLines(x, y, lines);

  const tiles = el('div', 'tiles');
  const tile = (v, l) => { const box = el('div', 'tile'); box.append(el('span', 'v', v), el('span', 'l', l)); tiles.append(box); };
  tile(nf.format(Math.round(R.total / SITES.length)), t('residents per site'));
  tile(fmtM(R.curve.quantile(0.5)), t('50% of residents within'));
  tile(fmtM(R.curve.quantile(0.9)), t('90% of residents within'));
  tile(fmtPct(R.curve.shareWithin(500)), t('residents within 500 m'));
  tile(fmtPct(R.curve.shareWithin(1000)), t('residents within 1 km'));
  tile(fmtPct(R.uninhabited / SITES.length), t('sites on uninhabited hectares'));
  body.append(tiles);

  const s1 = el('div', 'sec');
  s1.append(el('h3', null, t('Residents by distance to the nearest site')));
  s1.append(cdfChart(R.curve, { tip: tip2, hideTip }));
  s1.append(el('p', 'note', t('Straight-line distance from each hectare’s centre. Distance is not signal coverage: terrain, power and antenna direction matter.')));
  body.append(s1);

  const s2 = el('div', 'sec');
  s2.append(el('h3', null, t('Correlation by grid size')));
  const table = el('table', 'corr');
  const thead = el('thead');
  const hr = el('tr');
  for (const [h, title] of [[t('Cell size')], [t('Cells')], ['Spearman ρ', t('Rank correlation: 0 = none, 1 = perfect')], [t('Pearson r (log)'), t('Correlation of log(1 + count)')]]) {
    const th = el('th', null, h);
    if (title) th.title = title;
    hr.append(th);
  }
  thead.append(hr);
  const tbody = el('tbody');
  for (const s of SCALES) {
    const r = R.byScale[s];
    const tr = el('tr', s === state.analysisScale ? 'sel' : null);
    tr.dataset.scale = s;
    const btn = el('button', 'row-pick', blockLabel(s));
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(s === state.analysisScale));
    const first = el('td');
    first.append(btn);
    tr.append(first, el('td', null, nf.format(r.n)), el('td', null, fmtFixed(r.rho, 2)), el('td', null, fmtFixed(r.r, 2)));
    const pick = () => {
      state.analysisScale = s; saveSettings(); renderAnalysis();
      $('a-body').querySelector(`tr[data-scale="${s}"] button`)?.focus(); // the table was rebuilt
    };
    tr.addEventListener('click', pick);
    tbody.append(tr);
  }
  const caption = el('caption', 'sr-only', t('Correlation by grid size; choose a size to plot it'));
  table.append(caption, thead, tbody);
  s2.append(table);
  s2.append(el('p', 'note', press('Residents vs sites per grid cell; cells with neither are left out. Larger cells correlate more strongly. Click a row to plot it.',
    'Residents vs sites per grid cell; cells with neither are left out. Larger cells correlate more strongly. Tap a row to plot it.')));
  body.append(s2);

  const s = state.analysisScale, sc = R.byScale[s];
  const s3 = el('div', 'sec');
  s3.append(el('h3', null, t('Residents vs sites per {size} cell', { size: blockLabel(s) })));
  const key = el('div', 'chart-key');
  key.append(el('span', 'pt', t('{size} cells ({n})', { size: blockLabel(s), n: nf.format(sc.n) })), el('span', 'ln', t('average sites')));
  s3.append(key);
  s3.append(scatterChart(sc.pairs, {
    tip: tip2, hideTip,
    onHover: (i) => { state.hoverBlock = i >= 0 ? { E: sc.pairs.E[i], N: sc.pairs.N[i], s } : null; render(); },
    onClick: (i) => {
      const cLon = lv95ToWgs(sc.pairs.E[i] + s / 2, sc.pairs.N[i] + s / 2);
      map.flyTo({ center: cLon, zoom: { 500: 14, 1000: 13, 2000: 12, 5000: 10.8, 10000: 9.8 }[s], duration: 1000 });
    },
  }));
  const ax = el('div', 'axis-note');
  ax.append(el('span', null, `↑ ${t('antenna sites')}`), el('span', null, `${t('residents')} →`));
  s3.append(ax);
  s3.append(el('p', 'note', t('Log scales (1 + x). Points are jittered vertically because site counts are whole numbers. The column at 0 holds cells with sites but no residents.')));
  body.append(s3);
  console.debug(`analysis rendered in ${Math.round(performance.now() - t0)} ms`);
}

// ---------------------------------------------------------------- search (geo.admin.ch)
const ORIGIN = { zipcode: t('Postcode'), gg25: t('Commune'), district: t('District'), kantone: t('Canton'), gazetteer: t('Place'), address: t('Address'), parcel: t('Parcel') };
function setupSearch() {
  const input = $('search'), list = $('search-results');
  let results = [], resultsFor = '', active = -1, timer = 0, ctl = null, pickFirst = false;
  const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant'); };
  const cancel = () => { clearTimeout(timer); ctl?.abort(); pickFirst = false; }; // drop pending searches
  const parser = new DOMParser(); // inert: unlike innerHTML, it never loads images or runs handlers
  const paintList = () => {
    list.replaceChildren();
    results.forEach((r, k) => {
      const li = el('li');
      li.id = `search-opt-${k}`;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(k === active));
      li.setAttribute('aria-label', `${r.label}, ${ORIGIN[r.origin] || r.origin}`);
      li.append(el('span', null, r.label), el('span', 'kind', ORIGIN[r.origin] || r.origin));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(k); });
      list.append(li);
    });
    list.hidden = !results.length;
    input.setAttribute('aria-expanded', String(!!results.length));
    if (active >= 0 && results.length) {
      input.setAttribute('aria-activedescendant', `search-opt-${active}`);
      list.children[active].scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };
  const choose = (k) => {
    const r = results[k];
    if (!r) return;
    cancel();
    input.value = r.label;
    close();
    if (narrow()) setCollapsed(true); // the expanded panel would hide the result
    const box = /BOX\(([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+)\)/.exec(r.box || '');
    let open = null;
    if (r.origin === 'gg25' && N && +r.id > 0) { // a commune: open its summary
      openCommune(+r.id, ...wgsToLv95(r.lon, r.lat));
      open = 'detail';
    }
    if (box && Math.abs(box[3] - box[1]) > 0.002) {
      const f = freeArea(open), { width, height } = map.getContainer().getBoundingClientRect();
      map.fitBounds([[+box[1], +box[2]], [+box[3], +box[4]]], {
        padding: { left: f.left + 30, right: width - f.right + 30, top: f.top + 30, bottom: height - f.bottom + 30 }, maxZoom: 15, duration: 1200,
      });
    } else { // an address: select its hectare, then fly so that it lands in the part the panels leave free
      const i = cellAt(...wgsToLv95(r.lon, r.lat));
      if (i >= 0) selectCell(i, false); // no extra pan: it would cut the flight short
      const f = freeArea(i >= 0 ? 'detail' : null), { width, height } = map.getContainer().getBoundingClientRect();
      map.flyTo({ center: [r.lon, r.lat], zoom: 15.5, offset: [(f.left + f.right - width) / 2, (f.top + f.bottom - height) / 2], duration: 1200 });
    }
  };
  const search = async (q) => {
    ctl?.abort();
    ctl = new AbortController();
    try {
      const url = geoUrl('https://api3.geo.admin.ch/rest/services/api/SearchServer?' + new URLSearchParams({
        searchText: q, type: 'locations', sr: '4326', limit: '8', lang,
        origins: 'zipcode,gg25,district,kantone,gazetteer,address',
      }));
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
      const json = await res.json();
      results = (json.results || []).map(({ attrs }) => ({
        label: parser.parseFromString(attrs.label, 'text/html').body.textContent.replace(/\s+/g, ' ').trim(), // has <b>/<i>, line breaks
        origin: attrs.origin, lat: attrs.lat, lon: attrs.lon, box: attrs.geom_st_box2d, id: attrs.featureId,
      }));
      resultsFor = q;
      active = results.length ? 0 : -1;
      if (pickFirst) { pickFirst = false; choose(0); return; }
      paintList();
      announce(results.length ? tp(results.length, '{n} result; use the up and down arrow keys', '{n} results; use the up and down arrow keys') : t('No places found'));
    } catch (e) {
      if (e.name !== 'AbortError') { results = []; resultsFor = q; pickFirst = false; paintList(); }
    }
  };
  input.addEventListener('input', () => {
    cancel();
    const q = input.value.trim();
    if (q.length < 2) { results = []; resultsFor = q; paintList(); return; }
    timer = setTimeout(() => search(q), 200);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); paintList(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); paintList(); e.preventDefault(); }
    else if (e.key === 'Enter') {
      const q = input.value.trim();
      if (q === resultsFor) choose(active < 0 ? 0 : active);
      else if (q.length >= 2) { cancel(); pickFirst = true; search(q); } // results are for an older query: wait
    } else if (e.key === 'Escape') { if (!list.hidden) e.stopPropagation(); cancel(); close(); }
  });
  input.addEventListener('blur', () => { cancel(); setTimeout(close, 100); });
}

// ---------------------------------------------------------------- boot
(async () => {
  $('panel').setAttribute('aria-busy', 'true');
  try {
    const antP = loadAntennas();
    await loadData();
    A = await antP;
  } catch (e) {
    const opened = e.message === 'file'; // opened as a file, not through a server
    const [before, after] = t(opened ? 'Open this page through the local server: run {cmd} from the repository root.'
      : 'Could not load the population data. Reload the page; if you run it locally, start {cmd} from the repository root.').split('{cmd}');
    showFatal(before, el('code', null, 'python3 serve.py'), after);
    console.error(e);
    return;
  }
  const refDate = fmtDate(META.referenceDate).replace(/ /g, '\u00a0'); // the date wraps as one
  $('subtitle').textContent = t('Population per hectare · {date}', { date: refDate });
  $('src-date').textContent = refDate;
  updateSites();
  console.debug(GEO_PROXY ? 'swisstopo requests go through the local caching proxy' : 'no caching proxy: swisstopo is requested directly');
  buildControls();
  setupSearch();
  if (styleReady) { state.beforeId = firstSymbolId(); applyDim(); }
  lastLevel = levelForZoom(map.getZoom());
  classify();
  renderAntLegend();
  const site = /^(\d+),(\d+)$/.exec(BOOT_HASH.site ?? ''); // a shared link with a selected antenna site
  const sel = /^(\d+),(\d+)$/.exec(BOOT_HASH.sel ?? ''); // ... or hectare
  const siteIdx = site && A ? A.e.findIndex((e, k) => e === +site[1] && A.N[k] === +site[2]) : -1;
  if (siteIdx >= 0) {
    const scope = state.scope;
    selectAntenna(siteIdx);
    if (state.scope !== scope) { state.scope = scope; syncControls(); renderDetail(); render(); }
  } else if (sel) {
    const i = cellAt(+sel[1] + 50, +sel[2] + 50), scope = state.scope;
    if (i >= 0) { selectCell(i); if (state.scope !== scope) { state.scope = scope; syncControls(); renderDetail(); render(); } }
  } else if (BOOT_HASH.sc === 'view') {
    openDetail(false);
  }
  writeHash();
  if (state.view === '3d' && map.getPitch() === 0) map.easeTo({ pitch: 55, duration: 0 });
  if (isTerrain()) { map.setMaxPitch(80); if (styleReady) installTerrain(); } // otherwise style.load installs it
  updateViewStats();
  $('loading').remove();
  $('panel').removeAttribute('aria-busy');
})();

async function loadAntennas() {
  try { return await ANT.loadAntennas(early('antennas', 'data/antennas.json')); } catch (e) { console.warn('No antenna data', e); return null; }
}
