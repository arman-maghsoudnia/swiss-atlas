// Continuous surface from hectare data: rasterise in LV95, blur with a Gaussian (three box
// passes), and cut the coloured raster into small georeferenced tiles for deck.gl BitmapLayers.
//
// A rate is smoothed as blur(numerator) / blur(denominator) – a kernel-weighted rate – rather
// than blurring per-cell percentages, so a hectare with 3 residents does not weigh like one with 300.

import { lv95ToWgs } from './geo.js';

// Box sizes whose three passes approximate a Gaussian of the given sigma (in cells).
function boxRadii(sigma, n = 3) {
  const wIdeal = Math.sqrt((12 * sigma * sigma) / n + 1);
  let wl = Math.floor(wIdeal);
  if (wl % 2 === 0) wl--;
  const wu = wl + 2;
  const m = Math.round((12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4));
  return Array.from({ length: n }, (_, i) => ((i < m ? wl : wu) - 1) / 2);
}

function boxH(src, dst, W, H, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < H; y++) {
    const o = y * W;
    let acc = 0;
    for (let x = 0; x <= r && x < W; x++) acc += src[o + x];
    for (let x = 0; x < W; x++) {
      dst[o + x] = acc * inv;
      if (x + r + 1 < W) acc += src[o + x + r + 1];
      if (x - r >= 0) acc -= src[o + x - r];
    }
  }
}

function boxV(src, dst, W, H, r) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < W; x++) {
    let acc = 0;
    for (let y = 0; y <= r && y < H; y++) acc += src[y * W + x];
    for (let y = 0; y < H; y++) {
      dst[y * W + x] = acc * inv;
      if (y + r + 1 < H) acc += src[(y + r + 1) * W + x];
      if (y - r >= 0) acc -= src[(y - r) * W + x];
    }
  }
}

function gaussBlur(a, tmp, W, H, sigma) {
  if (sigma <= 0) return;
  for (const r of boxRadii(sigma)) {
    if (r < 1) continue;
    boxH(a, tmp, W, H, r);
    boxV(tmp, a, W, H, r);
  }
}

/**
 * @param points   {n, E: (i)=>LV95 E of point centre, N: (i)=>…} – hectares (or any points)
 * @param layers   {name: Float32Array(n)} values to accumulate and blur (e.g. num, den, support)
 * @param bbox     [minE, minN, maxE, maxN] in LV95 metres
 * @param sigmaM   kernel sigma in metres
 * @returns        {cell, x0, yTop, W, H, sigmaCells, [name]: Float32Array(W*H)}
 */
export function blurSurface(points, layers, bbox, sigmaM) {
  const cell = sigmaM <= 300 ? 100 : sigmaM <= 1000 ? 200 : 500;
  const sigmaCells = sigmaM / cell;
  const margin = Math.ceil(3 * sigmaCells) + 1;
  const x0 = Math.floor(bbox[0] / cell) * cell - margin * cell;
  const yTop = Math.ceil(bbox[3] / cell) * cell + margin * cell;
  const W = Math.ceil((bbox[2] - x0) / cell) + margin;
  const H = Math.ceil((yTop - bbox[1]) / cell) + margin;
  const out = { cell, x0, yTop, W, H, sigmaCells };
  const pix = new Int32Array(points.n);
  for (let i = 0; i < points.n; i++) {
    const px = Math.floor((points.E(i) - x0) / cell), py = Math.floor((yTop - points.N(i)) / cell);
    pix[i] = px >= 0 && px < W && py >= 0 && py < H ? py * W + px : -1;
  }
  const tmp = new Float32Array(W * H);
  for (const [name, vals] of Object.entries(layers)) {
    const r = new Float32Array(W * H);
    for (let i = 0; i < points.n; i++) if (pix[i] >= 0) r[pix[i]] += vals[i];
    gaussBlur(r, tmp, W, H, sigmaCells);
    out[name] = r;
  }
  return out;
}

// Value -> colour, blending continuously between the class colours (anchored at class centres).
export function makeColorScale(breaks, ramp) {
  const n = ramp.length;
  const centres = [];
  for (let k = 0; k < n; k++) {
    if (n === 1) centres.push(0);
    else if (k === 0) centres.push(Math.max(0, breaks[0] - ((breaks[1] ?? 2 * breaks[0]) - breaks[0]) / 2)); // one break: class 0 is [0, b)
    else if (k === n - 1) centres.push(breaks[k - 1] + (breaks[k - 1] - (breaks[k - 2] ?? 0)) / 2);
    else centres.push((breaks[k - 1] + breaks[k]) / 2);
  }
  if (breaks[0] < 1e-6) centres[0] = 0; // "exactly 0" class
  return (v, out) => {
    let k = 0;
    while (k < n - 1 && v > centres[k + 1]) k++;
    if (k === n - 1 || v <= centres[0]) {
      const c = ramp[v <= centres[0] ? 0 : n - 1];
      out[0] = c[0]; out[1] = c[1]; out[2] = c[2];
      return;
    }
    const t = (v - centres[k]) / (centres[k + 1] - centres[k] || 1), a = ramp[k], b = ramp[k + 1];
    out[0] = a[0] + (b[0] - a[0]) * t;
    out[1] = a[1] + (b[1] - a[1]) * t;
    out[2] = a[2] + (b[2] - a[2]) * t;
  };
}

/** Colour a surface: value(p) and alpha(p) (0..1, NaN value = transparent). Returns RGBA bytes. */
export function colorize(surface, value, alpha, colorOf) {
  const { W, H } = surface;
  const rgba = new Uint8ClampedArray(W * H * 4), c = [0, 0, 0];
  for (let p = 0; p < W * H; p++) {
    const a = alpha(p);
    if (!(a > 0.01)) continue;
    const v = value(p);
    if (Number.isNaN(v)) continue;
    colorOf(v, c);
    const o = 4 * p;
    rgba[o] = c[0]; rgba[o + 1] = c[1]; rgba[o + 2] = c[2]; rgba[o + 3] = 255 * Math.min(1, a);
  }
  return rgba;
}

/** Cut the RGBA raster into tiles with lon/lat corner bounds (small tiles keep reprojection error tiny).
 * Tiles are about 25 km whatever the cell size: deck.gl draws each bitmap as two flat triangles in
 * Web Mercator, so 256 cells of 500 m (128 km) would be misplaced by up to ~0.7 km. */
export function toTiles(surface, rgba, tileSize = Math.max(32, Math.round(25600 / surface.cell))) {
  const { W, H, cell, x0, yTop } = surface;
  const tiles = [];
  for (let ty = 0; ty * tileSize < H; ty++) {
    for (let tx = 0; tx * tileSize < W; tx++) {
      const w = Math.min(tileSize, W - tx * tileSize), h = Math.min(tileSize, H - ty * tileSize);
      const img = new ImageData(w, h);
      let any = false;
      for (let y = 0; y < h; y++) {
        const src = ((ty * tileSize + y) * W + tx * tileSize) * 4;
        const row = rgba.subarray(src, src + w * 4);
        img.data.set(row, y * w * 4);
        if (!any) for (let k = 3; k < row.length; k += 4) if (row[k]) { any = true; break; }
      }
      if (!any) continue;
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      canvas.getContext('2d').putImageData(img, 0, 0);
      const left = x0 + tx * tileSize * cell, right = left + w * cell;
      const top = yTop - ty * tileSize * cell, bottom = top - h * cell;
      tiles.push({
        id: `${tx}-${ty}`,
        image: canvas,
        bounds: [lv95ToWgs(left, bottom), lv95ToWgs(left, top), lv95ToWgs(right, top), lv95ToWgs(right, bottom)],
      });
    }
  }
  return tiles;
}

/** Surface pixel index under an LV95 point, or -1. */
export function pixelAt(surface, E, N) {
  const px = Math.floor((E - surface.x0) / surface.cell), py = Math.floor((surface.yTop - N) / surface.cell);
  return px >= 0 && px < surface.W && py >= 0 && py < surface.H ? py * surface.W + px : -1;
}
