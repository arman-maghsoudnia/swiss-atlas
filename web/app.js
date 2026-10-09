/* Swiss population grid – hectare map of STATPOP data with OFCOM mobile antenna sites.
 * Data comes from web/data (built by scripts/); rendering is MapLibre + deck.gl (globals from index.html). */

import { lv95ToWgs, wgsToLv95, squareRing } from './geo.js';
import { blurSurface, makeColorScale, colorize, toTiles, pixelAt } from './smooth.js';
import * as ANT from './antennas.js';
import { blockPairs, correlate, distanceCurve, cdfChart, scatterChart } from './analysis.js';
import { terrainSource, registerTileProtocol, antennaImages } from './terrain.js';
import { detectProxy, geoUrl, transformRequest } from './remote.js';

const $ = (id) => document.getElementById(id);
const nf = new Intl.NumberFormat('de-CH');
const pad2 = (i) => String(i).padStart(2, '0');
const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const fmtCoord = (v) => nf.format(Math.round(v));
const fmtM = (m) => (!Number.isFinite(m) ? '–' : m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 0 : 1)} km` : `${Math.round(m)} m`);
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
          attribution: '<a href="https://www.swisstopo.admin.ch/en/home.html" target="_blank" rel="noopener">© swisstopo</a>',
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
  metric: 'pop', rawCol: 'BB12', rawMode: 'share', minPop: 10, excludeNoloc: false,
  view: '2d', heightScale: 3, opacity: 0.85, dim: 0.45, basemap: 'imagery', scope: 'cell', radiusKm: 2,
  smooth: false, sigma: 300, analysisScale: 1000, exaggeration: 1.5,
  ant: { show: true, ops: [true, true, true, false, false], tech: '', type: '', color: 'single', sizeByPower: true },
};
const saved = loadSettings();
const state = {
  ...DEFAULTS, ...saved, ant: { ...DEFAULTS.ant, ...(saved.ant || {}) },
  isolate: null, selected: -1, antenna: -1, hoverBlock: null, beforeId: undefined,
};
if (!BASEMAPS[state.basemap]) state.basemap = DEFAULTS.basemap;
if (!SIGMAS.includes(state.sigma)) state.sigma = DEFAULTS.sigma;
if (!ANT.COLOR_MODES[state.ant.color]) state.ant.color = 'single';
if (!['2d', '3d', 'terrain'].includes(state.view)) state.view = '2d';
if (!['cell', 'radius', 'view'].includes(state.scope)) state.scope = DEFAULTS.scope;
const isTerrain = () => state.view === 'terrain';
function loadSettings() {
  try { return JSON.parse(localStorage.getItem('spg-settings') || '{}'); } catch { return {}; }
}
function saveSettings() {
  const keep = ['metric', 'rawCol', 'rawMode', 'minPop', 'excludeNoloc', 'view', 'heightScale', 'opacity', 'dim', 'basemap',
    'scope', 'radiusKm', 'smooth', 'sigma', 'analysisScale', 'ant', 'exaggeration'];
  try { localStorage.setItem('spg-settings', JSON.stringify(Object.fromEntries(keep.map((k) => [k, state[k]])))); } catch { /* private mode */ }
}

// ---------------------------------------------------------------- data
let META, N, M, E_IDX, N_IDX, POS, CENTER, BBOX, BBOX_LL, NOLOC_IDX;
const RAW = {}, NOLOC = {}, NOLOC_OF = new Map(), CELL_OF = new Map(), ADJ = {};
let COLORS, ELEV, CLASS, CELL_DATA;

async function loadData() {
  if (location.protocol === 'file:') throw new Error('file');
  const metaRes = await fetch('data/meta.json', { cache: 'no-cache' });
  if (!metaRes.ok) throw new Error('missing');
  META = await metaRes.json();
  const res = await fetch('data/cells.bin.gz', { cache: 'no-cache' });
  if (!res.ok) throw new Error('missing');
  const total = +res.headers.get('content-length') || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.byteLength;
    if (total) $('loading-bar').style.width = `${Math.min(100, (got / total) * 90)}%`;
  }
  let blob = new Blob(chunks);
  const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
  if (head[0] === 0x1f && head[1] === 0x8b) { // not yet decoded by the server/browser
    $('loading-msg').textContent = 'Decompressing…';
    blob = await new Response(blob.stream().pipeThrough(new DecompressionStream('gzip'))).blob();
  }
  const buf = await blob.arrayBuffer();
  $('loading-bar').style.width = '100%';
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
    CELL_OF.set(E_IDX[i] * 65536 + N_IDX[i], i);
    BBOX[0] = Math.min(BBOX[0], E); BBOX[1] = Math.min(BBOX[1], Nn);
    BBOX[2] = Math.max(BBOX[2], E + 100); BBOX[3] = Math.max(BBOX[3], Nn + 100);
  }
  const corners = [[BBOX[0], BBOX[1]], [BBOX[0], BBOX[3]], [BBOX[2], BBOX[1]], [BBOX[2], BBOX[3]]].map(([e, n]) => lv95ToWgs(e, n));
  BBOX_LL = [Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])),
    Math.max(...corners.map((c) => c[0])), Math.max(...corners.map((c) => c[1]))];
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
  DIST = new Float32Array(N);
  NEAR = new Int32Array(N);
  for (let i = 0; i < N; i++) {
    const [j, d] = ANT.nearest(A, AIDX, cellE(i) + 50, cellN(i) + 50);
    NEAR[i] = j; DIST[i] = j >= 0 ? d : NaN;
  }
  antVersion++;
  ANALYSIS = null;
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
    const pop = col('BBTOT'), num = new Float32Array(N), den = new Float32Array(N);
    for (let i = 0; i < N; i++) if (pop[i] > 0 && DIST && Number.isFinite(DIST[i])) { num[i] = DIST[i] * pop[i]; den[i] = pop[i]; }
    return { num: g.sum(num), den: g.sum(den) };
  }
  if (src.type === 'none') return { num: new Float32Array(g.n).fill(NaN), den: new Float32Array(g.n).fill(1) };
  throw new Error(src.type);
}
function computeMetric(m, g) {
  const { num, den } = parts(m.src, g);
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
  { id: 'pop', group: 'Population', label: 'Residents per hectare', kind: 'count', breaks: [4, 10, 25, 50, 100, 250],
    desc: 'Permanent resident population on each 100 × 100 m cell.', src: count('BBTOT') },
  { id: 'hh', group: 'Population', label: 'Private households per hectare', kind: 'count', breaks: [4, 10, 20, 40, 80, 150],
    desc: 'Number of private households on each cell.', src: count('HPTOT') },
  { id: 'foreign', group: 'Nationality', label: 'Foreign nationals', kind: 'share',
    desc: 'Share of residents without Swiss citizenship (dual nationals count as Swiss).', src: ratio(['BB12'], ['BB11', 'BB12']) },
  { id: 'euefta', group: 'Nationality', label: 'EU/EFTA nationals', kind: 'share',
    desc: 'Share of residents with the nationality of an EU or EFTA state.', src: ratio(['BB13'], ['BB11', 'BB12']) },
  { id: 'noneu', group: 'Nationality', label: 'Non-European nationals', kind: 'share',
    desc: 'Share of residents with the nationality of a country outside Europe.', src: ratio(['BB15'], ['BB11', 'BB12']) },
  { id: 'abroad', group: 'Place of birth', label: 'Born abroad', kind: 'share',
    desc: 'Share of residents born outside Switzerland.', src: ratio(['BB26'], ['BB21', 'BB26']) },
  { id: 'native', group: 'Place of birth', label: 'Born in their commune of residence', kind: 'share',
    desc: 'Share of residents born in the commune they live in today.', src: ratio(['BB22'], ['BB21', 'BB26']) },
  { id: 'meanAge', group: 'Age & sex', label: 'Mean age', kind: 'value', unit: 'years', step: 1, decimals: 1,
    desc: 'Approximate mean age from 5-year age bands (band midpoints; 90+ counted as 92.5).',
    src: { type: 'mean', codes: ALL_AGES, weights: meanAgeWeights } },
  { id: 'young', group: 'Age & sex', label: 'Aged 0–19', kind: 'share', desc: 'Share of children and teenagers.', src: ratio(age(1, 4), ALL_AGES) },
  { id: 'working', group: 'Age & sex', label: 'Aged 20–64', kind: 'share', desc: 'Share of working-age residents.', src: ratio(age(5, 13), ALL_AGES) },
  { id: 'senior', group: 'Age & sex', label: 'Aged 65+', kind: 'share', desc: 'Share of residents aged 65 and over.', src: ratio(age(14, 19), ALL_AGES) },
  { id: 'old', group: 'Age & sex', label: 'Aged 80+', kind: 'share', desc: 'Share of residents aged 80 and over.', src: ratio(age(17, 19), ALL_AGES) },
  { id: 'women', group: 'Age & sex', label: 'Women', kind: 'diverging', breaks: [0.40, 0.45, 0.48, 0.52, 0.55, 0.60],
    desc: 'Share of women. Grey = balanced (48–52 %); blue = more men, red = more women.', src: ratio(['BBWTOT'], ['BBMTOT', 'BBWTOT']) },
  { id: 'newcomers', group: 'Mobility', label: 'In the commune for less than a year', kind: 'share',
    desc: 'Share of residents who have lived in their commune for under one year.', src: ratio(['BB41'], DURATION) },
  { id: 'longterm', group: 'Mobility', label: 'In the commune for 10+ years or since birth', kind: 'share',
    desc: 'Share of long-standing residents.', src: ratio(['BB44', 'BB45'], DURATION) },
  { id: 'fromAbroad', group: 'Mobility', label: 'Lived abroad a year ago', kind: 'share',
    desc: 'Share of residents whose place of residence one year earlier was abroad.', src: ratio(['BB54'], PREV) },
  { id: 'fromCanton', group: 'Mobility', label: 'Lived in another canton a year ago', kind: 'share',
    desc: 'Share of residents who moved in from another canton during the past year.', src: ratio(['BB53'], PREV) },
  { id: 'hhSize', group: 'Households', label: 'Average household size', kind: 'value', unit: 'persons', step: 0.1, decimals: 2,
    desc: 'Persons per private household (households of 6+ counted as 6, so a slight underestimate).',
    src: { type: 'mean', codes: HH, weights: [1, 2, 3, 4, 5, 6] } },
  { id: 'single', group: 'Households', label: 'Single-person households', kind: 'share',
    desc: 'Share of private households with one person.', src: ratio(['HP01'], HH) },
  { id: 'dist', group: 'Antennas', label: 'Distance to the nearest antenna site', kind: 'value', unit: 'm', step: 50, decimals: 0, noMinPop: true,
    desc: 'Straight-line distance from the hectare centre to the nearest antenna site passing the antenna filters. Zoomed out: population-weighted mean.',
    src: { type: 'dist' } },
  { id: 'raw', group: 'All attributes', label: 'Any published attribute…', kind: 'raw', desc: 'Pick any of the 77 published STATPOP attributes.' },
];
const METRIC = Object.fromEntries(METRICS.map((m) => [m.id, m]));

// Resolve the raw attribute pseudo-metric to a concrete definition.
function activeMetric() {
  const m = METRIC[state.metric] || METRIC.pop;
  if (m.kind !== 'raw') return m;
  const c = state.rawCol, label = META.labels[c];
  if (c === 'HPI') return { id: 'raw:HPI', label, kind: 'class', desc: label, src: count('HPI') };
  if (state.rawMode === 'count' || c === 'BBTOT' || c === 'HPTOT') { // a total as a share of itself is always 100 %
    return { id: `raw:${c}:count`, label: `${label} per hectare`, kind: 'count', desc: `${c} · ${label}`, src: count(c) };
  }
  const den = c.startsWith('HP') ? 'HPTOT' : 'BBTOT';
  return { id: `raw:${c}:share`, label: `${label} (${den === 'HPTOT' ? '% of households' : '% of residents'})`, kind: 'share',
    desc: `${c} ÷ ${den}`, src: ratio([c], [den]) };
}

// ---------------------------------------------------------------- classification
const valueCache = new Map();
const metricKey = (m) => `${m.id}|${state.excludeNoloc}|${m.src.type === 'dist' ? antVersion : ''}`;
function metricValues(m, g) {
  if (m.kind === 'class' && g.s !== 100) return new Float32Array(g.n).fill(NaN); // classes cannot be aggregated
  const key = `${metricKey(m)}|${g.s}`;
  if (!valueCache.has(key)) valueCache.set(key, computeMetric(m, g));
  return valueCache.get(key);
}
const isRate = (m) => (m.kind === 'share' || m.kind === 'value' || m.kind === 'diverging') && !m.noMinPop;

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

function fmtValue(m, v, digits) {
  if (Number.isNaN(v)) return '–';
  if (m.kind === 'share' || m.kind === 'diverging') {
    const pc = v * 100;
    const d = digits ?? (pc < 1 && pc > 0 ? 1 : pc < 10 && pc % 1 ? 1 : 0);
    return `${pc.toFixed(d)} %`;
  }
  if (m.kind === 'value') return m.unit === 'm' ? fmtM(v) : `${v.toFixed(digits ?? m.decimals)} ${m.unit}`;
  return nf.format(v);
}
const fmtBreak = (m, b) => (m.kind === 'value' ? (m.unit === 'm' ? nf.format(b) : (+b.toFixed(2)).toString())
  : m.kind === 'count' ? nf.format(b) : `${+(b * 100).toFixed(1)}`);

function classLabels(m, breaks, zeroClass) {
  if (!breaks.length) return []; // nothing to classify: every hectare is shown as "no value"
  const unit = m.kind === 'share' || m.kind === 'diverging' ? ' %' : m.kind === 'value' ? ` ${m.unit}` : '';
  if (m.kind === 'class') return ['1 · all plausible', '2 · at least one implausible'];
  if (m.kind === 'count') {
    return [...breaks, Infinity].map((b, k) => (k === 0 ? `under ${nf.format(b)}`
      : b === Infinity ? `${nf.format(breaks[k - 1])} or more` : `${nf.format(breaks[k - 1])}–${nf.format(b)}`));
  }
  const labels = [];
  const start = zeroClass ? 1 : 0;
  if (zeroClass) labels.push(`0${unit}`);
  const bs = breaks.slice(start);
  labels.push(`${zeroClass ? 'above 0, ' : ''}under ${fmtBreak(m, bs[0])}${unit}`);
  for (let k = 1; k < bs.length; k++) labels.push(`${fmtBreak(m, bs[k - 1])}–${fmtBreak(m, bs[k])}${unit}`);
  labels.push(`${fmtBreak(m, bs[bs.length - 1])}${unit} or more`);
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
  const values = metricValues(m, g), pop = g.col('BBTOT'), rate = isRate(m);
  return { values, pop, rate, valid: (i) => pop[i] > 0 && !Number.isNaN(values[i]) && (!rate || pop[i] >= state.minPop) };
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
  const { values, pop, rate, valid } = validator(m, g);
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
  CLASSES = { m, breaks, labels, ramp, counts, naCount, rate };
  renderLegend();
  paint();
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
      getPosition: { value: g.pos, size: 2 },
      getFillColor: { value: COLORS, size: 4, normalized: true },
      getElevation: { value: ELEV, size: 1 },
    },
  };
  const res = $('res-note');
  if (isTerrain() && !state.smooth) {
    res.textContent = 'Terrain view: hectares are draped over swisstopo\'s relief; distant or zoomed-out areas use 200 m – 2 km blocks (rates over each block, counts as the mean per inhabited hectare).';
  } else if (state.smooth) {
    res.textContent = `Smooth heatmap: Gaussian kernel with σ = ${fmtM(state.sigma)}. Rates are kernel-weighted (smoothed numerator ÷ smoothed denominator); counts are the mean per inhabited hectare. Colours blend between the classes and fade where few hectares are inhabited.`;
    computeSmooth();
  } else {
    res.textContent = g.s === 100 ? 'Showing 100 m hectares.'
      : `Zoomed out: showing ${g.s >= 1000 ? `${g.s / 1000} km` : `${g.s} m`} blocks. Rates are computed over each block; counts are the mean per inhabited hectare. Zoom in for 100 m hectares.`;
  }
  refreshPopTiles();
  render();
}

// ---------------------------------------------------------------- smooth heatmap
let SMOOTH = null; // { key, surface, rgba, tiles, value(p), alpha(p) }
let smoothVersion = 0;
function computeSmooth() {
  const { m, breaks, ramp } = CLASSES;
  const key = [metricKey(m), state.sigma, state.minPop, basemapDark(), breaks.join(',')].join('|');
  if (SMOOTH?.key === key) return SMOOTH;
  if (m.kind === 'class') { SMOOTH = { key, tiles: [], value: () => NaN, alpha: () => 0 }; return SMOOTH; }
  const t0 = performance.now();
  const g = gridFor(100);
  const { num, den } = parts(m.src, g);
  const layers = { num, den, sup: inhabitedIndicator() };
  const rate = isRate(m);
  if (rate) layers.pop = Float32Array.from(col('BBTOT'));
  const pts = { n: N, E: (i) => cellE(i) + 50, N: (i) => cellN(i) + 50 };
  const s = blurSurface(pts, layers, BBOX, state.sigma);
  const perCell = (s.cell / 100) ** 2;                       // hectares per raster cell
  const kernelCells = 2 * Math.PI * s.sigmaCells ** 2;       // effective area of the Gaussian, in raster cells
  const clamp = m.kind === 'share' || m.kind === 'diverging';
  const value = (p) => (s.den[p] > 1e-9 ? (clamp ? Math.min(1, s.num[p] / s.den[p]) : s.num[p] / s.den[p]) : NaN);
  const alpha = (p) => {
    let a = Math.min(1, s.sup[p] / perCell / 0.12) ** 0.8;   // fade where few hectares are inhabited
    if (rate) a *= Math.min(1, (s.pop[p] * kernelCells) / Math.max(1, state.minPop));
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
const map = new maplibregl.Map({
  transformRequest,
  container: 'map',
  style: styleFor(state.basemap),
  center: [8.23, 46.82],
  zoom: 7.3,
  minZoom: 6,
  maxZoom: 18,
  maxPitch: 70,
  maxBounds: [[3.8, 44.9], [12.6, 48.7]],
  hash: 'map',
  attributionControl: false,
});
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: 'Population: <a href="https://www.bfs.admin.ch/bfs/en/home/statistics/catalogues-databases.assetdetail.36171301.html" target="_blank" rel="noopener">STATPOP2024, FSO GEOSTAT</a> · Antenna sites: <a href="https://www.geocat.ch/geonetwork/srv/ger/catalog.search#/metadata/6a972f46-ae47-4db9-b5a7-dcfd3598bd95" target="_blank" rel="noopener">OFCOM</a>',
}), 'bottom-right');
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'bottom-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

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
const antScale = () => Math.max(0.28, Math.min(1, 0.28 + (map.getZoom() - 7.5) * 0.18));

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

function render() {
  if (!COLORS) return;
  if (isTerrain()) { overlay.setProps({ layers: [] }); renderTerrainOverlays(); return; }
  const dark = basemapDark();
  const ink = dark ? [255, 255, 255, 255] : [11, 11, 11, 255];
  const layers = [];
  if (state.smooth && SMOOTH?.surface) {
    if (!SMOOTH.tiles.length && SMOOTH.rgba) SMOOTH.tiles = toTiles(SMOOTH.surface, SMOOTH.rgba); // built lazily after terrain mode
    for (const t of SMOOTH.tiles) {
      layers.push(new deck.BitmapLayer({
        id: `smooth-${t.id}`, beforeId: state.beforeId, image: t.image, bounds: t.bounds, opacity: state.opacity,
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
      elevationScale: state.heightScale,
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
  if (A && state.ant.show && !zoomRaf) zoomRaf = requestAnimationFrame(() => { zoomRaf = 0; render(); }); // marker size follows zoom
});

function setBasemap(key) {
  state.basemap = key;
  state.beforeId = undefined; // the old label layer is about to disappear
  render();
  styleReady = false;
  map.setStyle(styleFor(key), { diff: false }); // a diff fails with terrain set, and rebuilds anyway
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
const tipLines = (x, y, lines) => showTip(x, y, (t) => lines.forEach((l, k) => t.append(el('div', k ? 'tl' : 'tv', l))));
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
const fmtCount = (v, cell) => (cell && v === 3 ? '1–3' : nf.format(Math.round(v)));
const blockLabel = (s) => (s >= 1000 ? `${s / 1000} km` : `${s} m`);

function antennaSummary(i) {
  return [A.name[i], `${A.operatorLabels[A.op[i]]} · ${A.types[A.type[i]]}`, `${ANT.TECH_LABEL(A.tech[i])} · power ${A.powers[A.power[i]]}`];
}

// Tooltip for block/hectare i of grid g (shared by the flat deck.gl view and the terrain view).
function cellTip(g, i, x, y) {
  const { m, rate } = CLASSES;
  const raw = metricValues(m, g)[i];
  const v = m.kind === 'count' && Number.isNaN(raw) ? 0 : raw; // counts are NaN where the count is 0
  const pop = g.col('BBTOT')[i];
  const isHa = g.s === 100;
  const block = isHa ? '' : ` in this ${blockLabel(g.s)} block`;
  showTip(x, y, (t) => {
    const hidden = rate && pop < state.minPop;
    if (m.kind === 'count') {
      t.append(el('div', 'tv', isHa ? `${fmtCount(v, true)}` : `${v.toFixed(v < 10 ? 1 : 0)} per inhabited ha`));
      t.append(el('div', 'tl', m.label.replace(/ per hectare$/, '')));
    } else {
      t.append(el('div', 'tv', hidden ? 'Rate hidden' : fmtValue(m, v)));
      t.append(el('div', 'tl', m.label));
    }
    if (m.id !== 'pop' || !isHa) {
      t.append(el('div', 'tl', `${fmtCount(pop, isHa)} residents${block}${hidden ? ` (under ${state.minPop})` : ''}`));
    }
    if (isHa && NOLOC_OF.has(i)) t.append(el('div', 'tl', 'Commune-centre hectare'));
    if (!isHa && !isTerrain()) t.append(el('div', 'tl', 'Click to zoom in'));
  });
}
// Tooltip for the smoothed surface at (E, N); returns false where there is nothing to show.
function smoothTip(E, Nn, x, y) {
  const p = pixelAt(SMOOTH.surface, E, Nn);
  const { m } = CLASSES;
  if (p < 0 || SMOOTH.alpha(p) < 0.05 || Number.isNaN(SMOOTH.value(p))) return false;
  const v = SMOOTH.value(p);
  tipLines(x, y, [
    m.kind === 'count' ? `${v.toFixed(v < 10 ? 1 : 0)} per inhabited ha` : fmtValue(m, v),
    m.label.replace(/ per hectare$/, ''), `smoothed, σ = ${fmtM(state.sigma)}`]);
  return true;
}
// Grid block under an LV95 point for grid size s (the hectare index when s = 100), or -1.
function blockAt(s, E, Nn) {
  const keyOf = s === 100 ? CELL_OF : gridFor(s).keyOf;
  const b = keyOf.get(Math.floor((E - META.e0) / s) * 65536 + Math.floor((Nn - META.n0) / s));
  return b === undefined ? -1 : b;
}

function onHover(info) {
  if (isTerrain()) return; // MapLibre handles pointer events on the terrain (see terrain section)
  const canvas = map.getCanvas();
  if (info.layer?.id === 'ant' && info.index >= 0) {
    canvas.style.cursor = 'pointer';
    tipLines(info.x, info.y, [...antennaSummary(info.object), 'Click for details']);
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

function selectCell(i) {
  state.selected = i;
  state.antenna = -1;
  if (state.scope === 'view') state.scope = 'cell';
  openDetail();
}
function selectAntenna(i) {
  state.antenna = i;
  state.selected = cellAt(A.e[i], A.N[i]);
  if (state.scope !== 'radius') state.scope = 'radius';
  openDetail();
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
  const lat = (t) => (180 / Math.PI) * Math.atan(Math.sinh(Math.PI * (1 - (2 * t) / n)));
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
  note.textContent = 'Loading swisstopo terrain…';
  let spec;
  try {
    spec = await terrainSource();
  } catch (e) {
    console.error(e);
    note.textContent = 'Could not load the swisstopo terrain; showing the flat map.';
    setView('2d');
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
        'icon-size': ['interpolate', ['linear'], ['zoom'], 7.5, ['*', ['get', 'sz'], 0.28], 11.5, ['get', 'sz']],
        visibility: state.ant.show ? 'visible' : 'none',
      },
    }, before);
    map.addLayer({ id: 'spg-ant-sel', type: 'circle', source: 'spg-over', filter: ['==', ['get', 'kind'], 'antenna'],
      paint: { 'circle-radius': 10, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-width': 2.5, 'circle-stroke-color': dark ? '#ffffff' : '#0b0b0b' } }, before);
  }
  note.textContent = 'Right-drag (or Ctrl + drag) to tilt and turn. Relief: swissALTI3D via swisstopo.';
  renderTerrainOverlays();
}

function removeTerrain() {
  for (const id of TERRAIN_LAYERS) if (map.getLayer(id)) map.removeLayer(id);
  map.setTerrain(null);
  for (const id of TERRAIN_SOURCES) if (map.getSource(id)) map.removeSource(id);
  $('terrain-note').textContent = '';
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
    const t = (2 * Math.PI * k) / steps;
    return lv95ToWgs(cE + r * Math.cos(t), cN + r * Math.sin(t));
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
map.on('mousemove', (e) => {
  if (!isTerrain() || !CLASSES) return;
  const canvas = map.getCanvas();
  const ai = terrainAntennaAt(e.point);
  if (ai >= 0) { canvas.style.cursor = 'pointer'; tipLines(e.point.x, e.point.y, [...antennaSummary(ai), 'Click for details']); return; }
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
  const { m, labels, ramp, counts, naCount, rate } = CLASSES;
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
    b.title = state.smooth ? '' : state.isolate === k ? 'Show all classes' : 'Show only this class';
    b.setAttribute('aria-pressed', String(state.isolate === k));
    const sw = el('span', 'sw');
    sw.style.background = `rgb(${ramp[k].join(',')})`;
    b.append(sw, el('span', 'rng', label), el('span', 'cnt', `${nf.format(counts[k])} ha`));
    b.addEventListener('click', () => { state.isolate = state.isolate === k ? null : k; bumpColors(); renderLegend(); paint(); });
    box.append(b);
  });
  if (naCount && !state.smooth) {
    const b = el('div', 'legend-row static');
    const sw = el('span', 'sw');
    sw.style.background = NA_COLOR[basemapDark() ? 'dark' : 'light'];
    b.append(sw, el('span', 'rng', rate ? `Fewer than ${state.minPop} residents` : m.kind === 'count' ? 'None' : 'No value'), el('span', 'cnt', `${nf.format(naCount)} ha`));
    box.append(b);
  }
  const note = el('div', 'legend-note', state.smooth ? 'Hectare counts per class, before smoothing.'
    : m.breaks || m.kind === 'class' ? 'Click a class to isolate it.' : 'Classes are rounded quantiles of the hectares shown. Click a class to isolate it.');
  box.append(note);
  $('metric-desc').textContent = m.desc || '';
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
    row.append(shapeSvg(ANT.SHAPES[k], pal[k]), el('span', 'rng', state.ant.color === 'single' ? 'Antenna site' : label),
      el('span', 'cnt', `${nf.format(counts[k])} sites`));
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
    if (m.group !== group) { og = document.createElement('optgroup'); og.label = group = m.group; sel.append(og); }
    const o = el('option', null, m.label);
    o.value = m.id;
    og.append(o);
  }
  if (!METRIC[state.metric] || (state.metric === 'dist' && !A)) state.metric = 'pop';
  sel.value = state.metric;
  sel.addEventListener('change', () => { state.metric = sel.value; state.isolate = null; syncControls(); refresh(); });

  if (!META.columns.includes(state.rawCol)) state.rawCol = DEFAULTS.rawCol;
  if (!SCALES.includes(state.analysisScale)) state.analysisScale = DEFAULTS.analysisScale;
  const raw = $('raw-col');
  const groups = [
    ['Totals', ['BBTOT', 'BBMTOT', 'BBWTOT', 'HPTOT']],
    ['Nationality', ['BB11', 'BB12', 'BB13', 'BB14', 'BB15', 'BB16']],
    ['Place of birth', range(21, 30).map((k) => `BB${k}`)],
    ['Men by age', range(1, 19).map((k) => `BBM${pad2(k)}`)],
    ['Women by age', range(1, 19).map((k) => `BBW${pad2(k)}`)],
    ['Time in commune', DURATION],
    ['Residence a year ago', PREV],
    ['Households', [...HH, 'HPI']],
  ];
  for (const [label, codes] of groups) {
    const g = document.createElement('optgroup');
    g.label = label;
    for (const c of codes) { const o = el('option', null, `${META.labels[c]} · ${c}`); o.value = c; g.append(o); }
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
  minpop.addEventListener('input', () => {
    state.minPop = +minpop.value;
    syncControls();
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => { if (isRate(activeMetric())) { state.isolate = null; refresh(); } else saveSettings(); });
  });

  const noloc = $('noloc');
  noloc.checked = state.excludeNoloc;
  noloc.addEventListener('change', () => {
    state.excludeNoloc = noloc.checked;
    ANALYSIS = null;
    refresh();
    updateViewStats();
    renderAnalysis();
  });
  $('noloc-hint').textContent =
    `${nf.format(META.noloc.residents)} residents with no geocoded address are placed on ${nf.format(M)} commune-centre hectares, which creates artificial peaks.`;

  // antennas
  $('ant-block').hidden = !A;
  if (A) {
    const show = $('ant-show');
    show.checked = state.ant.show;
    show.addEventListener('change', () => { state.ant.show = show.checked; syncControls(); updateTerrainAntennas(); render(); saveSettings(); });
    const ops = $('ant-ops');
    A.operatorLabels.forEach((label, k) => {
      const lab = el('label', 'check');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !!state.ant.ops[k];
      cb.addEventListener('change', () => { state.ant.ops[k] = cb.checked; antennasChanged(); });
      const count = el('small');
      count.dataset.op = k;
      lab.append(cb, ` ${label.replace(' (railway GSM-R)', '').replace('German networks (border)', 'German (border)')} `, count);
      lab.title = label;
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
  exag.addEventListener('input', () => {
    state.exaggeration = +exag.value;
    syncControls();
    if (isTerrain() && map.getSource('spg-dem')) map.setTerrain({ source: 'spg-dem', exaggeration: state.exaggeration });
    saveSettings();
  });
  const smooth = $('smooth');
  smooth.checked = state.smooth;
  smooth.addEventListener('change', () => {
    state.smooth = smooth.checked;
    state.isolate = null;
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
  opacity.addEventListener('input', () => { state.opacity = +opacity.value; render(); saveSettings(); });
  const dim = $('dim');
  dim.value = state.dim;
  dim.addEventListener('input', () => { state.dim = +dim.value; applyDim(); saveSettings(); });
  const basemap = $('basemap');
  basemap.value = state.basemap;
  basemap.addEventListener('change', () => setBasemap(basemap.value));

  if (innerWidth < 720) { $('panel').classList.add('collapsed'); $('collapse').setAttribute('aria-expanded', 'false'); }
  $('collapse').addEventListener('click', () => {
    const p = $('panel');
    const collapsed = p.classList.toggle('collapsed');
    $('collapse').setAttribute('aria-expanded', String(!collapsed));
  });

  // detail panel
  $('d-close').addEventListener('click', closeDetail);
  document.querySelectorAll('[data-scope]').forEach((b) => b.addEventListener('click', () => {
    state.scope = b.dataset.scope; syncControls(); renderDetail(); render(); saveSettings();
  }));
  const radius = $('radius');
  radius.value = String(state.radiusKm);
  radius.addEventListener('change', () => { state.radiusKm = +radius.value; renderDetail(); render(); saveSettings(); });
  const kpis = document.querySelector('.kpis');
  kpis.addEventListener('click', () => { state.scope = 'view'; openDetail(); });
  kpis.title = 'Summarise the current map view';
  kpis.style.cursor = 'pointer';

  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
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
  const m = METRIC[state.metric];
  $('raw-opts').hidden = m.kind !== 'raw';
  const setSeg = (attr, v) => document.querySelectorAll(`[${attr}]`).forEach((b) =>
    b.setAttribute('aria-checked', String(b.getAttribute(attr) === v)));
  setSeg('data-raw-mode', state.rawMode);
  setSeg('data-view', state.view);
  setSeg('data-scope', state.scope);
  $('minpop-out').textContent = state.minPop;
  $('height-out').textContent = state.heightScale;
  $('height-row').hidden = state.view !== '3d' || state.smooth;
  $('exag-row').hidden = !isTerrain();
  $('exag-out').textContent = `${state.exaggeration.toFixed(1)}×`;
  $('sigma-row').hidden = !state.smooth;
  $('sigma-out').textContent = fmtM(state.sigma);
  document.querySelector('[data-view="3d"]').disabled = state.smooth;
  $('radius').hidden = state.scope !== 'radius';
  if ($('ant-body')) $('ant-body').hidden = !state.ant.show;
  document.querySelector('[data-scope="cell"]').disabled = state.selected < 0;
  document.querySelector('[data-scope="radius"]').disabled = !center();
}

function refresh() {
  classify();
  renderDetail();
  saveSettings();
}

// ---------------------------------------------------------------- view statistics
function viewBounds() {
  const b = map.getBounds();
  return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
}
function viewIndices() {
  const [w, s, e, n] = viewBounds();
  const out = [];
  for (let i = 0; i < N; i++) {
    const x = CENTER[2 * i], y = CENTER[2 * i + 1];
    if (x >= w && x <= e && y >= s && y <= n) out.push(i);
  }
  return out;
}
function viewSites() {
  const [w, s, e, n] = viewBounds();
  const out = [];
  for (const i of SITES) {
    const x = A.pos[2 * i], y = A.pos[2 * i + 1];
    if (x >= w && x <= e && y >= s && y <= n) out.push(i);
  }
  return out;
}
function updateViewStats() {
  if (!N) return;
  const pop = col('BBTOT');
  let sum = 0, ha = 0;
  for (const i of viewIndices()) { if (pop[i] > 0) { sum += pop[i]; ha++; } }
  $('kpi-view').textContent = nf.format(sum);
  $('kpi-ha').textContent = nf.format(ha);
  $('kpi-ant').textContent = A ? nf.format(viewSites().length) : '–';
  if (!$('detail').hidden && state.scope === 'view') renderDetail();
}
let moveTimer = 0;
map.on('moveend', () => { clearTimeout(moveTimer); moveTimer = setTimeout(updateViewStats, 60); });

// ---------------------------------------------------------------- detail panel
const SECTIONS = [
  { title: 'Nationality', rows: [['BB11', 'Swiss'], ['BB13', 'EU/EFTA'], ['BB14', 'Other European'], ['BB15', 'Outside Europe'], ['BB16', 'Unknown', true]] },
  { title: 'Place of birth', rows: [['BB22', 'This commune'], ['BB23', 'Same canton'], ['BB24', 'Other canton'], ['BB25', 'Switzerland, unknown', true],
    ['BB27', 'EU/EFTA'], ['BB28', 'Other European'], ['BB29', 'Outside Europe'], ['BB30', 'Abroad, unknown', true]] },
  { title: 'Time lived in the commune', rows: [['BB45', 'Since birth'], ['BB44', 'More than 10 years'], ['BB43', '6–10 years'], ['BB42', '1–5 years'],
    ['BB41', 'Less than 1 year'], ['BB46', 'Unknown', true]] },
  { title: 'Place of residence a year ago', rows: [['BB51', 'Same commune'], ['BB52', 'Same canton'], ['BB53', 'Other canton'], ['BB54', 'Abroad'],
    ['BB55', 'Not yet born'], ['BB56', 'Unknown', true]] },
  { title: 'Private households by size', rows: HH.map((c, k) => [c, k === 5 ? '6+ persons' : `${k + 1} person${k ? 's' : ''}`]) },
];

function scopeIndices() {
  if (state.scope === 'view') return viewIndices();
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
  if (state.scope === 'radius') { const [cE, cN] = center(); return ANT.within(A, AIDX, cE, cN, state.radiusKm * 1000); }
  const i = state.selected;
  if (i < 0) return [];
  return ANT.within(A, AIDX, cellE(i) + 50, cellN(i) + 50, 75).filter((j) => cellAt(A.e[j], A.N[j]) === i);
}

function aggregate(indices) {
  const sums = {};
  const pop = col('BBTOT');
  let cells = 0;
  for (const c of META.columns) {
    if (c === 'HPI') continue;
    const a = col(c);
    let s = 0;
    for (const i of indices) s += a[i];
    sums[c] = s;
  }
  for (const i of indices) if (pop[i] > 0) cells++;
  return { sums, cells };
}

function openDetail() {
  $('analysis').hidden = true;
  $('detail').hidden = false;
  syncControls();
  renderDetail();
  render();
}
function closeDetail() {
  $('detail').hidden = true;
  state.selected = -1;
  state.antenna = -1;
  lookupCtl?.abort();
  syncControls();
  render();
}

let lookupCtl = null;
const communeCache = new Map();
async function lookupCommune(E, Nn, target, stillValid) {
  const key = `${Math.floor(E / 100)}:${Math.floor(Nn / 100)}`;
  const show = (txt) => { if (stillValid()) target.textContent = txt; };
  if (communeCache.has(key)) { show(communeCache.get(key)); return; }
  lookupCtl?.abort();
  lookupCtl = new AbortController();
  try {
    const url = geoUrl('https://api3.geo.admin.ch/rest/services/api/MapServer/identify?' + new URLSearchParams({
      geometry: `${E},${Nn}`, geometryType: 'esriGeometryPoint', sr: '2056', tolerance: '0', returnGeometry: 'false',
      layers: 'all:ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill', lang: 'en',
    }));
    const res = await fetch(url, { signal: lookupCtl.signal });
    if (!res.ok) throw new Error(`commune lookup: HTTP ${res.status}`);
    const json = await res.json();
    const hit = (json.results || []).find((r) => r.attributes?.is_current_jahr) || json.results?.[0];
    const a = hit?.attributes;
    const name = a ? (a.gemname.includes(`(${a.kanton})`) ? a.gemname : `${a.gemname} (${a.kanton})`) : 'Outside Switzerland';
    communeCache.set(key, name);
    show(name);
  } catch (e) {
    if (e.name !== 'AbortError') show('');
  }
}

function renderDetail() {
  if ($('detail').hidden) return;
  const body = $('d-body');
  body.replaceChildren();
  const scope = state.scope;
  const isCell = scope === 'cell';
  const idx = scopeIndices();
  const { sums, cells } = aggregate(idx);
  const i = state.selected, ai = state.antenna;
  const c = center();

  if (ai >= 0) {
    $('d-title').textContent = A.name[ai];
    $('d-sub').textContent = `${A.operatorLabels[ai >= 0 ? A.op[ai] : 0]} · `;
    const commune = el('span', null, '…');
    $('d-sub').append(commune);
    lookupCommune(A.e[ai], A.N[ai], commune, () => state.antenna === ai);
    body.append(antennaProps(ai));
    const h = el('h3', 'scope-h', scope === 'view' ? 'Current map view' : isCell ? 'Hectare of this site' : `Within ${fmtKm(state.radiusKm)} of this site`);
    body.append(h);
  } else if (scope === 'view') {
    $('d-title').textContent = 'Current map view';
    $('d-sub').textContent = `${nf.format(cells)} inhabited hectares`;
  } else if (isCell) {
    $('d-title').textContent = 'Loading commune…';
    $('d-sub').textContent = `Hectare E ${fmtCoord(cellE(i))} · N ${fmtCoord(cellN(i))} (LV95, SW corner)`;
    lookupCommune(cellE(i) + 50, cellN(i) + 50, $('d-title'), () => state.selected === i && state.antenna < 0 && state.scope === 'cell');
  } else {
    const areaKm2 = Math.PI * state.radiusKm ** 2;
    $('d-title').textContent = `Within ${fmtKm(state.radiusKm)}`;
    $('d-sub').textContent = `of E ${fmtCoord(c[0])} · N ${fmtCoord(c[1])} · ${nf.format(cells)} inhabited hectares · ${nf.format(Math.round(sums.BBTOT / areaKm2))} residents/km²`;
  }
  if (ai >= 0 && scope === 'radius') {
    body.append(el('p', 'note', `${nf.format(cells)} inhabited hectares · ${nf.format(Math.round(sums.BBTOT / (Math.PI * state.radiusKm ** 2)))} residents/km²`));
  }

  const residents = sums.BBTOT;
  if (A) body.append(antennaSection(sums, isCell));
  if (!residents) {
    body.append(el('p', 'note', isCell || scope === 'view' ? 'No geocoded residents here.' : 'No geocoded residents in this area.'));
    return;
  }
  const agesSum = ALL_AGES.reduce((s, k) => s + sums[k], 0);
  const meanAge = ALL_AGES.reduce((s, k, j) => s + sums[k] * meanAgeWeights[j], 0) / agesSum;
  const hhSum = HH.reduce((s, k) => s + sums[k], 0);
  const hhSize = HH.reduce((s, k, j) => s + sums[k] * (j + 1), 0) / hhSum;
  const share = (a, b) => (b > 0 ? a / b : NaN);
  const shareM = { kind: 'share' };

  const tiles = el('div', 'tiles');
  const tile = (v, l) => { const t = el('div', 'tile'); t.append(el('span', 'v', v), el('span', 'l', l)); tiles.append(t); };
  tile(fmtCount(residents, isCell), 'residents');
  tile(fmtCount(sums.HPTOT, isCell), 'private households');
  tile(Number.isFinite(hhSize) ? hhSize.toFixed(2) : '–', 'persons / household');
  tile(fmtValue(shareM, share(sums.BB12, sums.BB11 + sums.BB12), 0), 'foreign nationals');
  tile(Number.isFinite(meanAge) ? meanAge.toFixed(1) : '–', 'mean age (approx.)');
  tile(fmtValue(shareM, share(age(14, 19).reduce((s, k) => s + sums[k], 0), agesSum), 0), 'aged 65+');
  body.insertBefore(tiles, body.querySelector('.ant-sec'));

  if (isCell && NOLOC_OF.has(i)) {
    const j = NOLOC_OF.get(i);
    body.append(el('div', 'badge',
      `Commune-centre hectare: ${nf.format(NOLOC.BBTOT[j])} of the published residents have no geocoded address and were placed here by the FSO${state.excludeNoloc ? ' (removed from the figures above)' : ''}.`));
  }
  if (isCell && residents < 20) {
    body.append(el('p', 'note', 'Small cell: every value from 1 to 3 is published as 3, so shares here are rough.'));
  }

  body.append(pyramid(sums, isCell));
  for (const sec of SECTIONS) body.append(barSection(sec, sums, isCell));

  if (c && scope !== 'view') {
    const links = el('div', 'links');
    const a = el('a', null, 'Open in map.geo.admin.ch ↗');
    a.href = `https://map.geo.admin.ch/#/map?lang=en&center=${Math.round(c[0])},${Math.round(c[1])}&z=10&layers=ch.bakom.standorte-mobilfunkanlagen`;
    a.target = '_blank';
    a.rel = 'noopener';
    links.append(a);
    body.append(links);
  }
  if (!isCell) {
    body.append(el('p', 'note', 'Sums of published hectare values. Because 1–3 is published as 3, totals slightly overstate the true population.'));
  }
}

function antennaProps(i) {
  const dl = el('dl', 'props');
  const row = (k, v) => dl.append(el('dt', null, k), el('dd', null, v));
  row('Type', A.types[A.type[i]]);
  row('Technology', ANT.TECH_LABEL(A.tech[i]));
  row('Power class', A.powers[A.power[i]]);
  row('Adaptive antennas', A.adaptive[i] ? 'Partially adaptive operation' : 'No');
  row('Permit', A.exempt[i] ? 'Exempt from NISV precautionary limits (low power, location or short operation)'
    : A.date[i] ? `Site data sheet ${A.date[i]}` : '–');
  row('Installation limit', A.limit[i] != null ? `${A.limit[i]} V/m` : '–');
  row('LV95', `E ${fmtCoord(A.e[i])} · N ${fmtCoord(A.N[i])}`);
  const pop = col('BBTOT');
  const within = (r) => {
    let s = 0;
    for (let j = 0; j < N; j++) {
      const dx = cellE(j) + 50 - A.e[i], dy = cellN(j) + 50 - A.N[i];
      if (dx * dx + dy * dy <= r * r) s += pop[j];
    }
    return s;
  };
  row('Residents nearby', `${nf.format(within(500))} within 500 m · ${nf.format(within(1000))} within 1 km`);
  return dl;
}

function antennaSection(sums, isCell) {
  const wrap = el('div', 'sec ant-sec');
  const sites = scopeSites();
  const f = state.ant;
  const filtered = f.ops.some((v, k) => !v && opCounts()[k]) || f.tech || f.type;
  wrap.append(el('h3', null, `Antenna sites${filtered ? ' (current filters)' : ''}`));
  if (isCell) {
    const i = state.selected, j = i >= 0 ? NEAR[i] : -1;
    const p = el('p', 'note');
    p.textContent = j >= 0
      ? `${sites.length ? `${sites.length} site${sites.length > 1 ? 's' : ''} in this hectare. ` : ''}Nearest: ${fmtM(DIST[i])} — ${A.name[j]} (${A.types[A.type[j]]}, ${ANT.TECH_LABEL(A.tech[j])}).`
      : 'No antenna site matches the filters.';
    wrap.append(p);
    return wrap;
  }
  const byOp = new Array(A.operators.length).fill(0);
  for (const i of sites) byOp[A.op[i]]++;
  const p = el('p', 'note', `${nf.format(sites.length)} sites${sites.length && sums.BBTOT ? ` · ${nf.format(Math.round(sums.BBTOT / sites.length))} residents per site` : ''}`);
  wrap.append(p);
  const max = Math.max(...byOp, 1);
  A.operatorLabels.forEach((label, k) => {
    if (!byOp[k] && !f.ops[k]) return;
    const r = el('div', 'brow');
    const track = el('div', 'track'), fill = el('div', 'fill');
    fill.style.width = `${(byOp[k] / max) * 100}%`;
    track.append(fill);
    const val = el('div', 'bv', nf.format(byOp[k]));
    if (sites.length) { val.append(' '); val.append(el('small', null, `${Math.round((byOp[k] / sites.length) * 100)}%`)); }
    r.append(el('div', 'bl', label), track, val);
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
    r.title = META.labels[c];
    const track = el('div', 'track');
    const fill = el('div', 'fill');
    fill.style.width = `${(v / max) * 100}%`;
    track.append(fill);
    const val = el('div', 'bv', fmtCount(v, isCell));
    if (!isCell && total > 0) { val.append(' '); val.append(el('small', null, `${Math.round((v / total) * 100)}%`)); }
    r.append(el('div', 'bl', label), track, val);
    wrap.append(r);
  }
  return wrap;
}

function pyramid(sums, isCell) {
  const wrap = el('div', 'sec');
  wrap.append(el('h3', null, 'Age and sex'));
  const key = el('div', 'pyr-key');
  key.append(el('span', 'm', `Men ${fmtCount(sums.BBMTOT, isCell)}`), el('span', 'w', `Women ${fmtCount(sums.BBWTOT, isCell)}`));
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
  svg.setAttribute('aria-label', 'Population pyramid by 5-year age band');
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
    hit.addEventListener('pointermove', (e) => showTip(e.clientX, e.clientY, (t) => {
      t.append(el('div', 'tv', `Age ${META.ageBands[k]}`));
      const row = (cls, label, v) => {
        const d = el('div', 'tl');
        const kk = el('span', 'tk');
        kk.style.background = `var(--series-${cls})`;
        d.append(kk, `${label} `, el('b', null, fmtCount(v, isCell)));
        return d;
      };
      t.append(row(1, 'Men', men[k]), row(2, 'Women', women[k]));
    }));
    hit.addEventListener('pointerleave', hideTip);
  }
  const yAxis = bands * (rowH + gap) + 10;
  mk('text', { x: 0, y: yAxis, 'text-anchor': 'start' }, fmtCount(max, false));
  mk('text', { x: side, y: yAxis, 'text-anchor': 'end' }, '0');
  mk('text', { x: side + mid, y: yAxis, 'text-anchor': 'start' }, '0');
  mk('text', { x: W, y: yAxis, 'text-anchor': 'end' }, fmtCount(max, false));
  wrap.append(svg);
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
  ANALYSIS = { byScale, curve: distanceCurve(DIST, pop), total, uninhabited };
  return ANALYSIS;
}

function openAnalysis() {
  $('detail').hidden = true;
  state.selected = -1;
  state.antenna = -1;
  $('analysis').hidden = false;
  renderAnalysis();
  render();
}
function closeAnalysis() {
  $('analysis').hidden = true;
  state.hoverBlock = null;
  render();
}

function renderAnalysis() {
  if ($('analysis').hidden || !A) return;
  const body = $('a-body');
  body.replaceChildren();
  if (!SITES.length) { body.append(el('p', 'note', 'No antenna site matches the filters.')); return; }
  const t0 = performance.now();
  const R = computeAnalysis();
  $('a-sub').textContent = `${nf.format(SITES.length)} sites (current filters) · ${nf.format(R.total)} residents`;
  const tip2 = (x, y, lines) => tipLines(x, y, lines);

  const tiles = el('div', 'tiles');
  const tile = (v, l) => { const t = el('div', 'tile'); t.append(el('span', 'v', v), el('span', 'l', l)); tiles.append(t); };
  tile(nf.format(Math.round(R.total / SITES.length)), 'residents per site');
  tile(fmtM(R.curve.quantile(0.5)), 'median distance, resident → site');
  tile(`${Math.round(R.curve.shareWithin(500) * 100)} %`, 'residents within 500 m');
  tile(fmtM(R.curve.quantile(0.9)), '90 % of residents within');
  tile(`${Math.round(R.curve.shareWithin(1000) * 100)} %`, 'residents within 1 km');
  tile(`${Math.round((R.uninhabited / SITES.length) * 100)} %`, 'sites on uninhabited hectares');
  body.append(tiles);

  const s1 = el('div', 'sec');
  s1.append(el('h3', null, 'Residents by distance to the nearest site'));
  s1.append(cdfChart(R.curve, { tip: tip2, hideTip }));
  s1.append(el('p', 'note', 'Share of residents whose hectare centre lies within a given straight-line distance of a site. Distance alone says nothing about signal coverage (terrain, power and antenna direction matter).'));
  body.append(s1);

  const s2 = el('div', 'sec');
  s2.append(el('h3', null, 'Correlation by grid size'));
  const table = el('table', 'corr');
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Grid cell', 'Cells', 'Spearman ρ', 'Pearson r (log)']) hr.append(el('th', null, h));
  thead.append(hr);
  const tbody = el('tbody');
  for (const s of SCALES) {
    const r = R.byScale[s];
    const tr = el('tr');
    tr.setAttribute('aria-selected', String(s === state.analysisScale));
    tr.tabIndex = 0;
    tr.append(el('td', null, blockLabel(s)), el('td', null, nf.format(r.n)), el('td', null, r.rho.toFixed(2)), el('td', null, r.r.toFixed(2)));
    const pick = () => { state.analysisScale = s; saveSettings(); renderAnalysis(); };
    tr.addEventListener('click', pick);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    tbody.append(tr);
  }
  table.append(thead, tbody);
  s2.append(table);
  s2.append(el('p', 'note', 'Residents vs number of sites per LV95 grid cell. Cells with neither residents nor sites (lakes, forest, mountains) are left out, so zero–zero cells do not inflate the result. Coarser cells correlate more strongly; click a row to plot it.'));
  body.append(s2);

  const s = state.analysisScale, sc = R.byScale[s];
  const s3 = el('div', 'sec');
  s3.append(el('h3', null, `Residents vs sites per ${blockLabel(s)} cell`));
  const key = el('div', 'chart-key');
  key.append(el('span', 'pt', `${blockLabel(s)} cells (${nf.format(sc.n)})`), el('span', 'ln', 'mean sites'));
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
  ax.append(el('span', null, '↑ antenna sites'), el('span', null, 'residents →'));
  s3.append(ax);
  s3.append(el('p', 'note', `Both axes are log(1 + x). Site counts are whole numbers, so points are jittered vertically. The column at 0 residents holds uninhabited cells that contain sites. Spearman ρ = ${sc.rho.toFixed(2)} at this grid size.`));
  body.append(s3);
  console.debug(`analysis rendered in ${Math.round(performance.now() - t0)} ms`);
}

// ---------------------------------------------------------------- search (geo.admin.ch)
const ORIGIN = { zipcode: 'Postcode', gg25: 'Commune', district: 'District', kantone: 'Canton', gazetteer: 'Place', address: 'Address', parcel: 'Parcel' };
function setupSearch() {
  const input = $('search'), list = $('search-results');
  let results = [], resultsFor = '', active = -1, timer = 0, ctl = null, pickFirst = false;
  const close = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const cancel = () => { clearTimeout(timer); ctl?.abort(); pickFirst = false; }; // drop pending searches
  const parser = new DOMParser(); // inert: unlike innerHTML, it never loads images or runs handlers
  const paintList = () => {
    list.replaceChildren();
    results.forEach((r, k) => {
      const li = el('li');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(k === active));
      li.append(el('span', null, r.label), el('span', 'kind', ORIGIN[r.origin] || r.origin));
      li.addEventListener('mousedown', (e) => { e.preventDefault(); choose(k); });
      list.append(li);
    });
    list.hidden = !results.length;
    input.setAttribute('aria-expanded', String(!!results.length));
  };
  const choose = (k) => {
    const r = results[k];
    if (!r) return;
    cancel();
    input.value = r.label;
    close();
    const box = /BOX\(([-\d.]+) ([-\d.]+),([-\d.]+) ([-\d.]+)\)/.exec(r.box || '');
    if (box && Math.abs(box[3] - box[1]) > 0.002) {
      map.fitBounds([[+box[1], +box[2]], [+box[3], +box[4]]], { padding: 60, maxZoom: 15, duration: 1200 });
    } else {
      map.flyTo({ center: [r.lon, r.lat], zoom: 15.5, duration: 1200 });
      const i = cellAt(...wgsToLv95(r.lon, r.lat));
      if (i >= 0) selectCell(i);
    }
  };
  const search = async (q) => {
    ctl?.abort();
    ctl = new AbortController();
    try {
      const url = geoUrl('https://api3.geo.admin.ch/rest/services/api/SearchServer?' + new URLSearchParams({
        searchText: q, type: 'locations', sr: '4326', limit: '8', lang: 'en',
        origins: 'zipcode,gg25,district,kantone,gazetteer,address',
      }));
      const res = await fetch(url, { signal: ctl.signal });
      if (!res.ok) throw new Error(`search: HTTP ${res.status}`);
      const json = await res.json();
      results = (json.results || []).map(({ attrs }) => ({
        label: parser.parseFromString(attrs.label, 'text/html').body.textContent.replace(/\s+/g, ' ').trim(), // has <b>/<i>, line breaks
        origin: attrs.origin, lat: attrs.lat, lon: attrs.lon, box: attrs.geom_st_box2d,
      }));
      resultsFor = q;
      active = results.length ? 0 : -1;
      if (pickFirst) { pickFirst = false; choose(0); } else paintList();
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
    } else if (e.key === 'Escape') { cancel(); close(); }
  });
  input.addEventListener('blur', () => { cancel(); setTimeout(close, 100); });
}

// ---------------------------------------------------------------- boot
(async () => {
  try {
    const antP = loadAntennas();
    await loadData();
    A = await antP;
  } catch (e) {
    const box = $('loading');
    box.classList.add('error');
    const msg = $('loading-msg');
    msg.textContent = '';
    msg.append(e.message === 'file'
      ? 'Open this page through the local server: run '
      : 'Could not load the hectare data. Build it and start the server with ');
    msg.append(el('code', null, 'python3 serve.py'), ' from the repository root.');
    console.error(e);
    return;
  }
  $('subtitle').textContent =
    `Permanent residents per hectare · 31 Dec ${META.year} · ${nf.format(N)} inhabited hectares`;
  $('loading-msg').textContent = 'Matching antenna sites to hectares…';
  await new Promise((r) => setTimeout(r, 0));
  const t0 = performance.now();
  updateSites();
  console.debug(`nearest-site search for ${nf.format(N)} hectares in ${Math.round(performance.now() - t0)} ms`);
  console.debug(GEO_PROXY ? 'swisstopo requests go through the local caching proxy' : 'no caching proxy: swisstopo is requested directly');
  buildControls();
  setupSearch();
  if (styleReady) { state.beforeId = firstSymbolId(); applyDim(); }
  lastLevel = levelForZoom(map.getZoom());
  classify();
  renderAntLegend();
  if (state.view === '3d' && map.getPitch() === 0) map.easeTo({ pitch: 55, duration: 0 });
  if (isTerrain()) { map.setMaxPitch(80); if (styleReady) installTerrain(); } // otherwise style.load installs it
  updateViewStats();
  $('loading').remove();
})();

async function loadAntennas() {
  try { return await ANT.loadAntennas('data/antennas.json'); } catch (e) { console.warn('No antenna data', e); return null; }
}
