// web/smooth.js: colour scale, kernel smoothing, colouring and georeferenced tiles.

import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { blurSurface, makeColorScale, colorize, toTiles, pixelAt } from '../web/smooth.js';
import { lv95ToWgs } from '../web/geo.js';
import { rng } from './_lib.mjs';

// Ramps as app.js builds them (hexRgb of its SEQ / DIV palettes).
const hexRgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const SEQ = ['#cde2fb', '#9ec5f4', '#6da7ec', '#3987e5', '#256abf', '#184f95', '#0d366b'].map(hexRgb);
const DIV = ['#184f95', '#3987e5', '#9ec5f4', '#f0efec', '#f1aea8', '#d75853', '#892b2a'].map(hexRgb);
// A ramp whose channels are monotone, so the scale's output must be monotone in the value too.
const monoRamp = (n) => Array.from({ length: n }, (_, k) => [k * 30, 255 - k * 30, 100]);

const colorOf = (scale, v) => { const c = [NaN, NaN, NaN]; scale(v, c); return c; };

describe('makeColorScale', () => {
  // [label, breaks] for 0, 1, 2 and 6 breaks, plus the app's special cases.
  const CASES = [
    ['0 breaks (nothing to classify)', []],
    ['1 break (two classes, as the HPI class metric)', [2]],
    ['2 breaks', [10, 30]],
    ['6 breaks (residents per hectare)', [4, 10, 25, 50, 100, 250]],
    ['6 breaks (share of women, diverging)', [0.40, 0.45, 0.48, 0.52, 0.55, 0.60]],
    ['zero class (1e-9 first break)', [1e-9, 0.05, 0.1, 0.2]],
    ['1 break at the zero class only', [1e-9]],
    ['uneven gaps', [1, 2, 100, 101, 5000, 5001]],
  ];
  const probes = (breaks) => {
    const top = breaks.length ? breaks[breaks.length - 1] : 1;
    const v = [-1e9, -1, 0, 1e-12, 1e-9, top / 3, top, top * 1.5, top * 4, 1e12, Infinity, -Infinity];
    for (const b of breaks) v.push(b, b * 0.999, b * 1.001);
    for (let k = 0; k <= 400; k++) v.push((k / 400) * top * 2);
    return v;
  };

  for (const [label, breaks] of CASES) {
    test(`${label}: finite RGB for every value, ramp ends at both extremes`, () => {
      for (const ramp of [monoRamp(breaks.length + 1), SEQ.slice(0, breaks.length + 1), DIV.slice(0, breaks.length + 1)]) {
        const scale = makeColorScale(breaks, ramp);
        for (const v of probes(breaks)) {
          const c = colorOf(scale, v);
          for (const ch of c) assert.ok(Number.isFinite(ch) && ch >= 0 && ch <= 255, `v=${v} -> ${c}`);
        }
        assert.deepEqual(colorOf(scale, -1), ramp[0]);
        assert.deepEqual(colorOf(scale, 0), ramp[0]);
        assert.deepEqual(colorOf(scale, 1e12), ramp[ramp.length - 1]);
        assert.deepEqual(colorOf(scale, Infinity), ramp[ramp.length - 1]);
      }
    });

    test(`${label}: monotone between the ends`, () => {
      const ramp = monoRamp(breaks.length + 1);
      const scale = makeColorScale(breaks, ramp);
      const vs = probes(breaks).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      let prev = colorOf(scale, vs[0]);
      for (const v of vs.slice(1)) {
        const c = colorOf(scale, v);
        assert.ok(c[0] >= prev[0] - 1e-9 && c[1] <= prev[1] + 1e-9, `not monotone at v=${v}: ${prev} -> ${c}`);
        prev = c;
      }
    });
  }

  test('interior class centres get exactly their class colour', () => {
    const breaks = [4, 10, 25, 50, 100, 250], scale = makeColorScale(breaks, SEQ);
    for (let k = 1; k < breaks.length; k++) assert.deepEqual(colorOf(scale, (breaks[k - 1] + breaks[k]) / 2), SEQ[k]);
  });

  test('continuous: no jumps between neighbouring values', () => {
    const breaks = [4, 10, 25, 50, 100, 250], scale = makeColorScale(breaks, SEQ);
    let prev = colorOf(scale, 0);
    for (let v = 0.05; v <= 400; v += 0.05) {
      const c = colorOf(scale, v);
      assert.ok(Math.max(...c.map((x, i) => Math.abs(x - prev[i]))) < 2, `jump at ${v}`);
      prev = c;
    }
  });
});

describe('colorize', () => {
  test('alpha and NaN make pixels transparent; other pixels get the scale colour', () => {
    const surface = { W: 4, H: 1 };
    const values = [5, NaN, 50, 500], alphas = [1, 1, 0.005, 0.5];
    const scale = makeColorScale([10, 100], monoRamp(3));
    const rgba = colorize(surface, (p) => values[p], (p) => alphas[p], scale);
    assert.equal(rgba.length, 16);
    assert.deepEqual(Array.from(rgba.subarray(0, 4)), [...colorOf(scale, 5).map(Math.round), 255]);
    assert.deepEqual(Array.from(rgba.subarray(4, 12)), [0, 0, 0, 0, 0, 0, 0, 0]); // NaN, then alpha ≤ 0.01
    assert.deepEqual(Array.from(rgba.subarray(12, 15)), colorOf(scale, 500).map(Math.round));
    assert.ok(Math.abs(rgba[15] - 127.5) <= 0.5);
  });
});

// ---------------------------------------------------------------- blurSurface
const HA = 100;
/** Points as app.js passes them: hectare SW corners shifted to the centre (E + 50, N + 50). */
const hectares = (corners) => ({ n: corners.length, E: (i) => corners[i][0] + HA / 2, N: (i) => corners[i][1] + HA / 2 });
const bboxOf = (corners) => [
  Math.min(...corners.map((c) => c[0])), Math.min(...corners.map((c) => c[1])),
  Math.max(...corners.map((c) => c[0])) + HA, Math.max(...corners.map((c) => c[1])) + HA,
];
const pixelCentre = (s, p) => [s.x0 + ((p % s.W) + 0.5) * s.cell, s.yTop - (Math.floor(p / s.W) + 0.5) * s.cell];
function moments(s, a) {
  let m = 0, cx = 0, cy = 0;
  for (let p = 0; p < a.length; p++) {
    if (!a[p]) continue;
    const [x, y] = pixelCentre(s, p);
    m += a[p]; cx += a[p] * x; cy += a[p] * y;
  }
  cx /= m; cy /= m;
  let vx = 0, vy = 0;
  for (let p = 0; p < a.length; p++) {
    if (!a[p]) continue;
    const [x, y] = pixelCentre(s, p);
    vx += a[p] * (x - cx) ** 2; vy += a[p] * (y - cy) ** 2;
  }
  return { m, cx, cy, sx: Math.sqrt(vx / m), sy: Math.sqrt(vy / m) };
}
const SIGMAS = [100, 200, 300, 500, 1000, 2000, 5000];

describe('blurSurface', () => {
  test('raster cell size follows sigma (100 / 200 / 500 m) and the grid is aligned to it', () => {
    for (const sigma of SIGMAS) {
      const s = blurSurface(hectares([[2600000, 1200000]]), { v: Float32Array.of(1) }, [2600000, 1200000, 2600100, 1200100], sigma);
      assert.equal(s.cell, sigma <= 300 ? 100 : sigma <= 1000 ? 200 : 500);
      assert.equal(s.sigmaCells, sigma / s.cell);
      assert.equal(s.x0 % s.cell, 0);
      assert.equal(s.yTop % s.cell, 0);
      assert.equal(s.v.length, s.W * s.H);
    }
  });

  test('leaves a margin of at least 3 sigma around the data bbox', () => {
    const corners = [[2485500, 1075500], [2833900, 1294800]];
    const bbox = bboxOf(corners);
    for (const sigma of SIGMAS) {
      const s = blurSurface(hectares(corners), { v: Float32Array.of(1, 1) }, bbox, sigma);
      assert.ok(bbox[0] - s.x0 >= 3 * sigma, `left, sigma ${sigma}`);
      assert.ok(s.x0 + s.W * s.cell - bbox[2] >= 3 * sigma, `right, sigma ${sigma}`);
      assert.ok(s.yTop - bbox[3] >= 3 * sigma, `top, sigma ${sigma}`);
      assert.ok(bbox[1] - (s.yTop - s.H * s.cell) >= 3 * sigma, `bottom, sigma ${sigma}`);
    }
  });

  test('conserves the total of every layer', () => {
    const r = rng(30);
    const corners = Array.from({ length: 2000 }, () => [2550000 + Math.floor(r() * 1500) * 100, 1150000 + Math.floor(r() * 1000) * 100]);
    const pop = Float32Array.from(corners, () => 3 + Math.floor(r() * 300));
    const one = new Float32Array(corners.length).fill(1);
    for (const sigma of SIGMAS) {
      const s = blurSurface(hectares(corners), { pop, one }, bboxOf(corners), sigma);
      const sum = (a) => a.reduce((x, y) => x + y, 0);
      assert.ok(Math.abs(sum(s.pop) / sum(pop) - 1) < 1e-4, `pop, sigma ${sigma}: ${sum(s.pop)} vs ${sum(pop)}`);
      assert.ok(Math.abs(sum(s.one) / corners.length - 1) < 1e-4, `one, sigma ${sigma}`);
    }
  });

  test('a single hectare stays centred on the hectare centre at 100 m cells (no half-cell offset)', () => {
    for (const [E, N] of [[2600000, 1200000], [2683400, 1247900], [2485600, 1110100]]) {
      for (const sigma of [100, 200, 300]) {
        const s = blurSurface(hectares([[E, N]]), { v: Float32Array.of(1000) }, [E, N, E + HA, N + HA], sigma);
        const { m, cx, cy } = moments(s, s.v);
        assert.ok(Math.abs(m - 1000) < 1e-2);
        assert.ok(Math.abs(cx - (E + 50)) < 1e-3 && Math.abs(cy - (N + 50)) < 1e-3, `sigma ${sigma}: centroid ${cx}, ${cy}`);
        // The peak is the hectare's own pixel, and the kernel is symmetric around it.
        const p = pixelAt(s, E + 50, N + 50);
        assert.deepEqual(pixelCentre(s, p), [E + 50, N + 50]);
        assert.equal(s.v[p], Math.max(...s.v));
        const px = p % s.W, py = Math.floor(p / s.W);
        for (let d = 1; d <= 4; d++) {
          assert.ok(Math.abs(s.v[p + d] - s.v[p - d]) < 1e-4, 'E/W symmetry');
          assert.ok(Math.abs(s.v[(py + d) * s.W + px] - s.v[(py - d) * s.W + px]) < 1e-4, 'N/S symmetry');
        }
      }
    }
  });

  test('coarser cells: an aligned block of hectares stays centred on the block', () => {
    for (const sigma of [500, 1000, 2000, 5000]) {
      const cell = sigma <= 1000 ? 200 : 500, k = cell / HA, E0 = 2600000, N0 = 1200000;
      const corners = [];
      for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) corners.push([E0 + i * HA, N0 + j * HA]);
      const s = blurSurface(hectares(corners), { v: new Float32Array(corners.length).fill(1) }, bboxOf(corners), sigma);
      const { cx, cy } = moments(s, s.v);
      assert.ok(Math.abs(cx - (E0 + cell / 2)) < 1e-3 && Math.abs(cy - (N0 + cell / 2)) < 1e-3, `sigma ${sigma}: ${cx}, ${cy}`);
    }
  });

  test('coarser cells: a single hectare lands in the raster cell that contains it', () => {
    for (const sigma of [500, 1000, 2000, 5000]) {
      for (const [E, N] of [[2600000, 1200000], [2600400, 1200400], [2683300, 1247700]]) {
        const s = blurSurface(hectares([[E, N]]), { v: Float32Array.of(1) }, [E, N, E + HA, N + HA], sigma);
        const { cx, cy } = moments(s, s.v);
        const [pcx, pcy] = pixelCentre(s, pixelAt(s, E + 50, N + 50));
        assert.ok(Math.abs(cx - pcx) < 1e-2 && Math.abs(cy - pcy) < 1e-2, `sigma ${sigma}`);
        assert.ok(Math.abs(cx - (E + 50)) < s.cell / 2 && Math.abs(cy - (N + 50)) < s.cell / 2);
      }
    }
  });

  test('effective kernel width is within 20 % of sigma', () => {
    // Three box passes approximate the Gaussian; at sigma = 100 m (1 cell) that is a single
    // 3 × 3 box (effective sigma ≈ 82 m), which is the worst case.
    for (const sigma of SIGMAS) {
      const s = blurSurface(hectares([[2600000, 1200000]]), { v: Float32Array.of(1) }, [2600000, 1200000, 2600100, 1200100], sigma);
      const { sx, sy } = moments(s, s.v);
      assert.ok(Math.abs(sx / sigma - 1) < 0.2 && Math.abs(sy / sigma - 1) < 0.2, `sigma ${sigma}: ${sx.toFixed(1)} / ${sy.toFixed(1)}`);
    }
  });

  test('a constant rate stays constant after smoothing numerator and denominator', () => {
    const r = rng(31);
    const corners = Array.from({ length: 500 }, () => [2600000 + Math.floor(r() * 200) * 100, 1200000 + Math.floor(r() * 200) * 100]);
    const den = Float32Array.from(corners, () => 3 + Math.floor(r() * 200));
    const num = den.map((d) => 0.25 * d);
    const s = blurSurface(hectares(corners), { num, den }, bboxOf(corners), 500);
    for (let p = 0; p < s.den.length; p++) {
      if (s.den[p] > 1e-3) assert.ok(Math.abs(s.num[p] / s.den[p] - 0.25) < 1e-4, `pixel ${p}`);
    }
  });

  test('sigma 0: plain rasterisation, one value per hectare pixel', () => {
    const corners = [[2600000, 1200000], [2600100, 1200000], [2600000, 1200300]];
    const s = blurSurface(hectares(corners), { v: Float32Array.of(1, 2, 3) }, bboxOf(corners), 0);
    for (const [i, [E, N]] of corners.entries()) assert.equal(s.v[pixelAt(s, E + 50, N + 50)], i + 1);
    assert.equal(s.v.reduce((a, b) => a + b, 0), 6);
  });

  test('points outside the raster are dropped, not wrapped into another row', () => {
    const corners = [[2600000, 1200000]];
    const pts = { n: 3, E: (i) => [2600050, 9e9, -9e9][i], N: (i) => [1200050, 1200050, 1200050][i] };
    const s = blurSurface(pts, { v: Float32Array.of(1, 5, 7) }, bboxOf(corners), 0);
    assert.equal(s.v.reduce((a, b) => a + b, 0), 1);
  });
});

// ---------------------------------------------------------------- pixelAt / toTiles
describe('pixelAt and toTiles', () => {
  // toTiles draws each tile into a canvas: give Node the two DOM pieces it uses.
  const saved = {};
  before(() => {
    saved.ImageData = globalThis.ImageData; saved.document = globalThis.document;
    globalThis.ImageData = class { constructor(w, h) { this.width = w; this.height = h; this.data = new Uint8ClampedArray(w * h * 4); } };
    globalThis.document = {
      createElement: () => {
        const canvas = { width: 0, height: 0 };
        canvas.getContext = () => ({ putImageData: (img, x, y) => { canvas.img = img; canvas.at = [x, y]; } });
        return canvas;
      },
    };
  });
  after(() => { globalThis.ImageData = saved.ImageData; globalThis.document = saved.document; });

  const surf = { cell: 100, x0: 2600000, yTop: 1210000, W: 600, H: 300 };

  test('pixelAt: row-major from the top-left, -1 outside', () => {
    assert.equal(pixelAt(surf, surf.x0, surf.yTop), 0);
    assert.equal(pixelAt(surf, surf.x0 + 99.9, surf.yTop - 0.1), 0);
    assert.equal(pixelAt(surf, surf.x0 + 100, surf.yTop - 0.1), 1);
    assert.equal(pixelAt(surf, surf.x0 + 50, surf.yTop - 150), surf.W);
    assert.equal(pixelAt(surf, surf.x0 + surf.W * 100 - 1, surf.yTop - surf.H * 100 + 1), surf.W * surf.H - 1);
    for (const [E, N] of [[surf.x0 - 1, surf.yTop - 5], [surf.x0 + surf.W * 100, surf.yTop - 5],
      [surf.x0 + 5, surf.yTop + 1], [surf.x0 + 5, surf.yTop - surf.H * 100]]) {
      assert.equal(pixelAt(surf, E, N), -1, `${E}/${N}`);
    }
  });

  test('tiles cover exactly the pixels pixelAt maps into them', () => {
    const rgba = new Uint8ClampedArray(surf.W * surf.H * 4);
    const r = rng(40);
    for (let p = 0; p < surf.W * surf.H; p++) if (r() < 0.3) rgba.set([p % 251, (p >> 8) % 251, 7, 255], 4 * p);
    const tileSize = 128;
    const tiles = toTiles(surf, rgba, tileSize);
    assert.equal(tiles.length, Math.ceil(surf.W / tileSize) * Math.ceil(surf.H / tileSize));
    for (const t of tiles) {
      const [tx, ty] = t.id.split('-').map(Number);
      const w = t.image.width, h = t.image.height;
      assert.equal(w, Math.min(tileSize, surf.W - tx * tileSize));
      assert.equal(h, Math.min(tileSize, surf.H - ty * tileSize));
      const left = surf.x0 + tx * tileSize * surf.cell, top = surf.yTop - ty * tileSize * surf.cell;
      const right = left + w * surf.cell, bottom = top - h * surf.cell;
      // Corner order expected by deck.gl BitmapLayer: bottom-left, top-left, top-right, bottom-right.
      assert.deepEqual(t.bounds, [lv95ToWgs(left, bottom), lv95ToWgs(left, top), lv95ToWgs(right, top), lv95ToWgs(right, bottom)]);
      // The tile's first and last image pixels are the surface pixels under its corner cells.
      assert.equal(pixelAt(surf, left + 50, top - 50), ty * tileSize * surf.W + tx * tileSize);
      assert.equal(pixelAt(surf, right - 50, bottom + 50), (ty * tileSize + h - 1) * surf.W + tx * tileSize + w - 1);
      // Every image pixel carries the colour of the surface pixel pixelAt finds at its centre.
      for (let k = 0; k < 50; k++) {
        const x = Math.floor(r() * w), y = Math.floor(r() * h);
        const p = pixelAt(surf, left + (x + 0.5) * surf.cell, top - (y + 0.5) * surf.cell);
        assert.deepEqual(Array.from(t.image.img.data.subarray(4 * (y * w + x), 4 * (y * w + x) + 4)), Array.from(rgba.subarray(4 * p, 4 * p + 4)));
      }
    }
  });

  test('fully transparent tiles are skipped; default tiles are about 25 km', () => {
    const rgba = new Uint8ClampedArray(surf.W * surf.H * 4);
    const p = pixelAt(surf, 2630050, 1200050);
    rgba[4 * p + 3] = 255;
    const tiles = toTiles(surf, rgba);
    assert.equal(tiles.length, 1);
    assert.equal(tiles[0].id, '1-0'); // 256-pixel tiles at 100 m: x 300 is in the second column
    for (const cell of [100, 200, 500]) {
      const s = { ...surf, cell, W: 1000, H: 10 };
      const t = toTiles(s, new Uint8ClampedArray(4 * 1000 * 10).fill(255));
      assert.ok(Math.abs(t[0].image.width * cell - 25600) <= cell / 2 + 1, `cell ${cell}: ${t[0].image.width} px`);
    }
  });

  test('blurSurface deposits each point in the pixel pixelAt reports for it', () => {
    const r = rng(41);
    const corners = Array.from({ length: 300 }, () => [2500000 + Math.floor(r() * 3000) * 100, 1100000 + Math.floor(r() * 1500) * 100]);
    for (const sigma of [0]) {
      const s = blurSurface(hectares(corners), { id: Float32Array.from(corners, (_, i) => i + 1) }, bboxOf(corners), sigma);
      for (const [i, [E, N]] of corners.entries()) {
        const p = pixelAt(s, E + 50, N + 50);
        assert.ok(p >= 0);
        assert.ok(s.id[p] >= i + 1); // duplicates add up
      }
    }
  });
});
