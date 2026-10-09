// Antennas vs population: correlation statistics and the two charts of the analysis panel.

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const nf = new Intl.NumberFormat('de-CH');

// ---------------------------------------------------------------- statistics
function ranks(a) {
  const idx = Array.from(a.keys()).sort((i, j) => a[i] - a[j]);
  const r = new Float64Array(a.length);
  for (let k = 0; k < idx.length;) {
    let m = k;
    while (m + 1 < idx.length && a[idx[m + 1]] === a[idx[k]]) m++;
    const avg = (k + m) / 2 + 1;
    for (let t = k; t <= m; t++) r[idx[t]] = avg;
    k = m + 1;
  }
  return r;
}

export function pearson(x, y) {
  const n = x.length;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx, dy = y[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  return cov / Math.sqrt(vx * vy);
}
export const spearman = (x, y) => pearson(ranks(x), ranks(y));
const log1p = (a) => Float64Array.from(a, (v) => Math.log10(1 + v));

/**
 * Residents and antenna sites per LV95 block of size s. Cells with neither are left out
 * (mountains, lakes, forest), which keeps zero–zero agreement from inflating the correlation.
 */
export function blockPairs(grid, pop, A, sites, e0, n0) {
  const s = grid.s, keyOf = grid.keyOf;
  const cnt = new Float64Array(grid.n);
  const extra = new Map(); // blocks with sites but no residents
  for (const i of sites) {
    const k = Math.floor((A.e[i] - e0) / s) * 65536 + Math.floor((A.N[i] - n0) / s);
    const b = keyOf.get(k);
    if (b !== undefined) cnt[b]++;
    else extra.set(k, (extra.get(k) || 0) + 1);
  }
  const n = grid.n + extra.size;
  const out = { s, n, pop: new Float64Array(n), sites: new Float64Array(n), E: new Int32Array(n), N: new Int32Array(n) };
  for (let b = 0; b < grid.n; b++) {
    out.pop[b] = pop[b]; out.sites[b] = cnt[b];
    out.E[b] = e0 + grid.be[b] * s; out.N[b] = n0 + grid.bn[b] * s;
  }
  let b = grid.n;
  for (const [k, c] of extra) {
    out.sites[b] = c;
    out.E[b] = e0 + Math.floor(k / 65536) * s; out.N[b] = n0 + (k % 65536) * s;
    b++;
  }
  return out;
}

export function correlate(pairs) {
  return { n: pairs.n, rho: spearman(pairs.pop, pairs.sites), r: pearson(log1p(pairs.pop), log1p(pairs.sites)) };
}

/** Population-weighted distribution of the distance to the nearest site (25 m bins, up to the largest distance). */
export function distanceCurve(dist, pop, bin = 25) {
  let maxD = 0;
  for (let i = 0; i < dist.length; i++) if (pop[i] > 0 && Number.isFinite(dist[i])) maxD = Math.max(maxD, dist[i]);
  const bins = new Float64Array(Math.floor(maxD / bin) + 1);
  let total = 0;
  for (let i = 0; i < dist.length; i++) {
    const p = pop[i];
    if (!(p > 0)) continue;
    total += p; // without any site (none passes the filters) a resident counts as infinitely far
    if (Number.isFinite(dist[i])) bins[Math.floor(dist[i] / bin)] += p;
  }
  const cum = new Float64Array(bins.length); // cum[k]: share of residents closer than (k + 1) bins
  let acc = 0;
  for (let k = 0; k < bins.length; k++) { acc += bins[k]; cum[k] = total ? acc / total : 0; }
  const shareWithin = (m) => (m <= 0 ? 0 : cum[Math.min(cum.length - 1, Math.ceil(m / bin) - 1)]);
  const quantile = (q) => { // interpolated within its bin
    const k = cum.findIndex((c) => c >= q);
    if (k < 0) return Infinity;
    const lo = k ? cum[k - 1] : 0;
    return (k + (cum[k] > lo ? (q - lo) / (cum[k] - lo) : 1)) * bin;
  };
  return { bin, cum, shareWithin, quantile, total };
}

// ---------------------------------------------------------------- charts
const NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs, text) {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
  if (text != null) n.textContent = text;
  return n;
}
const fmtM = (m) => (m >= 1000 ? `${+(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
const fmtCompact = (v) => (v >= 1000 ? `${+(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : `${v}`);

/** Cumulative share of residents by distance to the nearest site, with a hover crosshair. */
export function cdfChart(curve, { tip, hideTip, maxKm = 3 }) {
  const W = 352, H = 160, m = { l: 36, r: 10, t: 10, b: 24 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const x = (d) => m.l + (d / (maxKm * 1000)) * pw, y = (s) => m.t + (1 - s) * ph;
  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart', role: 'img',
    'aria-label': 'Share of residents living within a given distance of the nearest antenna site' });
  for (const s of [0, 0.25, 0.5, 0.75, 1]) {
    svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y(s), y2: y(s), class: s === 0 ? 'axis' : 'grid' }));
    svg.append(svgEl('text', { x: m.l - 6, y: y(s) + 3, 'text-anchor': 'end' }, `${s * 100}%`));
  }
  for (let km = 0; km <= maxKm; km += 0.5) {
    svg.append(svgEl('text', { x: x(km * 1000), y: H - 8, 'text-anchor': 'middle' }, km === 0 ? '0' : `${km} km`));
  }
  let d = '';
  const steps = Math.floor((maxKm * 1000) / curve.bin);
  for (let k = 0; k <= steps; k++) {
    const dist = k * curve.bin, s = k === 0 ? 0 : curve.cum[Math.min(k, curve.cum.length) - 1];
    d += `${k ? 'L' : 'M'}${x(dist).toFixed(1)},${y(s).toFixed(1)}`;
  }
  svg.append(svgEl('path', { d, class: 'line s1' }));
  const med = curve.quantile(0.5);
  if (med <= maxKm * 1000) {
    svg.append(svgEl('circle', { cx: x(med), cy: y(0.5), r: 4, class: 'dot s1' }));
    svg.append(svgEl('text', { x: x(med) + 7, y: y(0.5) + 12, class: 'lbl' }, `median ${fmtM(med)}`));
  }
  const cross = svgEl('line', { y1: m.t, y2: m.t + ph, class: 'cross', visibility: 'hidden' });
  svg.append(cross);
  const hit = svgEl('rect', { x: m.l, y: m.t, width: pw, height: ph, fill: 'transparent' });
  hit.addEventListener('pointermove', (e) => {
    const r = svg.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const dist = Math.max(0, Math.min(maxKm * 1000, ((px - m.l) / pw) * maxKm * 1000));
    const snapped = Math.round(dist / curve.bin) * curve.bin;
    cross.setAttribute('x1', x(snapped)); cross.setAttribute('x2', x(snapped));
    cross.setAttribute('visibility', 'visible');
    tip(e.clientX, e.clientY, [`${Math.round(curve.shareWithin(snapped) * 100)} %`, `of residents live within ${fmtM(snapped)} of a site`]);
  });
  hit.addEventListener('pointerleave', () => { cross.setAttribute('visibility', 'hidden'); hideTip(); });
  svg.append(hit);
  return svg;
}

/**
 * Scatter of residents vs antenna sites per block (log(1 + x) axes). Site counts are integers,
 * so points get a small, deterministic vertical jitter to show how many cells share a count.
 */
export function scatterChart(pairs, { tip, hideTip, onHover, onClick }) {
  const W = 352, H = 250, m = { l: 34, r: 10, t: 8, b: 26 };
  const pw = W - m.l - m.r, ph = H - m.t - m.b;
  const dpr = devicePixelRatio || 1;
  const wrap = document.createElement('div');
  wrap.className = 'scatter';
  const canvas = document.createElement('canvas');
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Scatter plot of residents against antenna sites per ${pairs.s >= 1000 ? `${pairs.s / 1000} km` : `${pairs.s} m`} cell`);
  const over = document.createElement('canvas');
  over.width = W * dpr; over.height = H * dpr;
  over.className = 'over';
  wrap.append(canvas, over);

  const L = (v) => Math.log10(1 + v);
  let maxX = 0, maxY = 0;
  for (let i = 0; i < pairs.n; i++) { maxX = Math.max(maxX, pairs.pop[i]); maxY = Math.max(maxY, pairs.sites[i]); }
  // y starts slightly below 0 so the jittered band of cells without any site stays inside the plot.
  const X1 = Math.max(1, Math.ceil(L(maxX) * 2) / 2), Y0 = L(-0.3), Y1 = Math.max(0.5, L(maxY) * 1.05);
  const sx = (v) => m.l + (L(v) / X1) * pw, sy = (v) => m.t + (1 - (L(Math.max(-0.3, v)) - Y0) / (Y1 - Y0)) * ph;
  const jitter = (i) => (((Math.sin(i * 12.9898) * 43758.5453) % 1 + 1) % 1 - 0.5) * 0.55;

  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.font = '10px system-ui, -apple-system, "Segoe UI", sans-serif';
  const muted = css('--text-muted'), grid = css('--grid'), axis = css('--axis');
  // axes & grid
  g.strokeStyle = grid; g.fillStyle = muted; g.lineWidth = 1;
  g.textAlign = 'center';
  for (const v of [0, 10, 100, 1000, 10000, 100000, 1000000]) {
    if (L(v) > X1) break;
    const px = Math.round(sx(v)) + 0.5;
    g.beginPath(); g.moveTo(px, m.t); g.lineTo(px, m.t + ph); g.stroke();
    g.fillText(fmtCompact(v), px, H - 10);
  }
  g.textAlign = 'right';
  for (const v of [0, 1, 2, 5, 10, 20, 50, 100, 200, 500]) {
    if (L(v) > Y1) break;
    const py = Math.round(sy(v)) + 0.5;
    g.beginPath(); g.moveTo(m.l, py); g.lineTo(W - m.r, py); g.stroke();
    g.fillText(String(v), m.l - 5, py + 3);
  }
  g.strokeStyle = axis;
  g.beginPath(); g.moveTo(m.l, m.t + ph + 0.5); g.lineTo(W - m.r, m.t + ph + 0.5); g.stroke();

  // points
  const px = new Float32Array(pairs.n), py = new Float32Array(pairs.n);
  g.fillStyle = css('--series-1');
  g.globalAlpha = pairs.n > 20000 ? 0.18 : pairs.n > 5000 ? 0.28 : 0.45;
  for (let i = 0; i < pairs.n; i++) {
    px[i] = sx(pairs.pop[i]); py[i] = sy(pairs.sites[i] + jitter(i));
    g.fillRect(px[i] - 1.25, py[i] - 1.25, 2.5, 2.5);
  }
  g.globalAlpha = 1;

  // mean sites per residents bin (0.25 decades), bins with at least 10 cells. Uninhabited cells
  // are only in the data when they hold a site, so they are left out of the mean.
  const bins = new Map();
  for (let i = 0; i < pairs.n; i++) {
    if (!(pairs.pop[i] > 0)) continue;
    const k = Math.floor(L(pairs.pop[i]) * 4);
    const b = bins.get(k) || { n: 0, s: 0 };
    b.n++; b.s += pairs.sites[i];
    bins.set(k, b);
  }
  const line = [...bins.entries()].filter(([, b]) => b.n >= 10).sort((a, b) => a[0] - b[0]);
  g.strokeStyle = css('--surface-1'); g.lineWidth = 4; g.lineJoin = 'round';
  const path = () => {
    g.beginPath();
    line.forEach(([k, b], j) => {
      const x = m.l + (((k + 0.5) / 4) / X1) * pw, y = sy(b.s / b.n);
      if (j) g.lineTo(x, y); else g.moveTo(x, y);
    });
    g.stroke();
  };
  path();
  g.strokeStyle = css('--series-2'); g.lineWidth = 2;
  path();

  // hover: nearest point within 12 px (bucketed by 12 px cells)
  const cellPx = 12, grid2 = new Map();
  for (let i = 0; i < pairs.n; i++) {
    const k = Math.floor(px[i] / cellPx) * 1000 + Math.floor(py[i] / cellPx);
    let b = grid2.get(k);
    if (!b) grid2.set(k, (b = []));
    b.push(i);
  }
  const og = over.getContext('2d');
  og.scale(dpr, dpr);
  const pick = (e) => {
    const r = over.getBoundingClientRect();
    const x = ((e.clientX - r.left) / r.width) * W, y = ((e.clientY - r.top) / r.height) * H;
    let best = -1, bd = 144;
    const cx = Math.floor(x / cellPx), cy = Math.floor(y / cellPx);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      for (const i of grid2.get((cx + dx) * 1000 + cy + dy) || []) {
        const d = (px[i] - x) ** 2 + (py[i] - y) ** 2;
        if (d < bd) { bd = d; best = i; }
      }
    }
    return best;
  };
  let current = -1;
  over.addEventListener('pointermove', (e) => {
    const i = pick(e);
    og.clearRect(0, 0, W, H);
    if (i < 0) { if (current >= 0) { current = -1; hideTip(); onHover(-1); } over.style.cursor = ''; return; }
    over.style.cursor = 'pointer';
    og.strokeStyle = css('--text-primary'); og.lineWidth = 2;
    og.beginPath(); og.arc(px[i], py[i], 5, 0, 2 * Math.PI); og.stroke();
    tip(e.clientX, e.clientY, [`${nf.format(pairs.sites[i])} site${pairs.sites[i] === 1 ? '' : 's'}`,
      `${nf.format(Math.round(pairs.pop[i]))} residents`, 'Click to show on the map']);
    if (i !== current) { current = i; onHover(i); }
  });
  over.addEventListener('pointerleave', () => { og.clearRect(0, 0, W, H); current = -1; hideTip(); onHover(-1); });
  over.addEventListener('click', (e) => { const i = pick(e); if (i >= 0) onClick(i); });
  return wrap;
}
