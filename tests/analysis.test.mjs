// web/analysis.js statistics: Pearson/Spearman, block pairs and the distance curve
// (the SVG/canvas charts need a DOM and are not tested here).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { pearson, spearman, correlate, blockPairs, distanceCurve } from '../web/analysis.js';
import { makeSites, rng } from './_lib.mjs';

const close = (a, b, eps = 1e-12, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} != ${b}`);

// Independent reference: average ranks for ties (fractional ranking), then Pearson on the ranks.
function refRanks(a) {
  return Array.from(a, (v) => {
    let less = 0, equal = 0;
    for (const w of a) { if (w < v) less++; else if (w === v) equal++; }
    return less + (equal + 1) / 2;
  });
}
function refPearson(x, y) {
  const n = x.length, mx = x.reduce((s, v) => s + v, 0) / n, my = y.reduce((s, v) => s + v, 0) / n;
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { c += (x[i] - mx) * (y[i] - my); vx += (x[i] - mx) ** 2; vy += (y[i] - my) ** 2; }
  return c / Math.sqrt(vx * vy);
}

describe('pearson', () => {
  test('Anscombe\'s quartet, set I: r = 0.81642', () => {
    const x = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5];
    const y = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68];
    close(pearson(x, y), 0.8164205163448399, 1e-12);
  });

  test('exact linear relations give +1 / -1, and r is invariant to affine maps', () => {
    const x = [1, 2, 3, 4, 5, 6];
    close(pearson(x, x.map((v) => 3 * v + 7)), 1);
    close(pearson(x, x.map((v) => -0.5 * v + 2)), -1);
    const y = [2, 1, 4, 3, 7, 5];
    close(pearson(x.map((v) => 10 * v - 3), y.map((v) => 0.1 * v + 100)), pearson(x, y), 1e-12);
  });

  test('typed arrays and plain arrays agree', () => {
    const r = rng(10), x = Array.from({ length: 200 }, r), y = x.map((v) => v + r());
    close(pearson(Float64Array.from(x), Float32Array.from(y, (v) => v)), pearson(x, Array.from(Float32Array.from(y))), 1e-12);
  });

  test('a constant series has no correlation (NaN, not a number pretending to be one)', () => {
    assert.ok(Number.isNaN(pearson([1, 2, 3], [5, 5, 5])));
  });
});

describe('spearman', () => {
  test('classic example without ties: rho = 1 - 6·Σd²/(n(n²-1)) = 0.8', () => {
    close(spearman([1, 2, 3, 4, 5], [2, 1, 4, 3, 5]), 0.8);
  });

  test('IQ vs hours of TV (Wikipedia worked example): rho = -29/165', () => {
    const iq = [106, 100, 86, 101, 99, 103, 97, 113, 112, 110];
    const tv = [7, 27, 2, 50, 28, 29, 20, 12, 6, 17];
    close(spearman(iq, tv), -29 / 165, 1e-12);
  });

  test('ties get average ranks: x = [1, 2, 2, 3] vs y = [1, 2, 3, 4] gives 3/sqrt(10)', () => {
    close(spearman([1, 2, 2, 3], [1, 2, 3, 4]), 3 / Math.sqrt(10), 1e-12);
  });

  test('matches a reference implementation on data with many ties', () => {
    const r = rng(11);
    for (let t = 0; t < 20; t++) {
      const n = 5 + Math.floor(r() * 200);
      const x = Array.from({ length: n }, () => Math.floor(r() * 6)); // like site counts: 0, 1, 2 …
      const y = x.map((v) => Math.round(v * 30 + r() * 100)); // like residents
      const want = refPearson(refRanks(x), refRanks(y));
      close(spearman(Float64Array.from(x), Float64Array.from(y)), want, 1e-12, `trial ${t}`);
    }
  });

  test('invariant to monotone transforms; reversing one series negates it', () => {
    const r = rng(12), x = Array.from({ length: 300 }, () => Math.floor(r() * 50)), y = x.map((v) => v + Math.floor(r() * 30));
    const rho = spearman(x, y);
    close(spearman(x.map((v) => Math.log1p(v)), y.map((v) => v ** 3)), rho, 1e-12);
    close(spearman(x, x.map((v) => -v)), -1, 1e-12);
  });

  test('does not reorder its inputs', () => {
    const x = Float64Array.of(3, 1, 2), y = Float64Array.of(1, 2, 3);
    spearman(x, y);
    assert.deepEqual(Array.from(x), [3, 1, 2]);
  });
});

describe('blockPairs and correlate', () => {
  const e0 = 2400000, n0 = 1000000, s = 1000;
  // Two inhabited blocks (the shape gridFor(s) builds in app.js: key = bx * 65536 + by).
  const grid = {
    s, n: 2, be: [200, 201], bn: [200, 200],
    keyOf: new Map([[200 * 65536 + 200, 0], [201 * 65536 + 200, 1]]),
  };
  const pop = Float32Array.of(120, 30);
  const S = makeSites([
    [2600010, 1200990], // block 0
    [2601500, 1200000], [2601999, 1200999], // block 1 (both edges inside)
    [2605000, 1199000], // uninhabited block (205, 199)
    [2610100, 1210100], [2610900, 1210900], // uninhabited block (210, 210)
  ]);

  test('counts every site once, in its own block, and adds blocks that only have sites', () => {
    const p = blockPairs(grid, pop, S, [0, 1, 2, 3, 4, 5], e0, n0);
    assert.equal(p.s, s);
    assert.equal(p.n, 4);
    assert.deepEqual(Array.from(p.pop), [120, 30, 0, 0]);
    assert.deepEqual(Array.from(p.sites), [1, 2, 1, 2]);
    assert.deepEqual(Array.from(p.E), [2600000, 2601000, 2605000, 2610000]);
    assert.deepEqual(Array.from(p.N), [1200000, 1200000, 1199000, 1210000]);
  });

  test('only the filtered sites count', () => {
    const p = blockPairs(grid, pop, S, [1, 3], e0, n0);
    assert.equal(p.n, 3);
    assert.deepEqual(Array.from(p.sites), [0, 1, 1]);
  });

  test('correlate: Spearman on raw values, Pearson on log10(1 + x)', () => {
    const pairs = { n: 5, pop: Float64Array.of(0, 10, 100, 1000, 50), sites: Float64Array.of(1, 0, 2, 5, 2) };
    const c = correlate(pairs);
    assert.equal(c.n, 5);
    close(c.rho, spearman(pairs.pop, pairs.sites));
    close(c.r, refPearson(Array.from(pairs.pop, (v) => Math.log10(1 + v)), Array.from(pairs.sites, (v) => Math.log10(1 + v))), 1e-12);
  });
});

describe('distanceCurve', () => {
  // Exact population-weighted quantile: the smallest d with share(dist <= d) >= q (Infinity if never).
  function exactQuantile(dist, pop, q) {
    const items = [];
    let total = 0;
    for (let i = 0; i < dist.length; i++) {
      if (pop[i] > 0) { total += pop[i]; items.push([Number.isFinite(dist[i]) ? dist[i] : Infinity, pop[i]]); }
    }
    items.sort((a, b) => a[0] - b[0]);
    let acc = 0;
    for (const [d, p] of items) {
      if (!Number.isFinite(d)) break;
      acc += p;
      if (acc / total >= q - 1e-12) return d;
    }
    return Infinity;
  }
  const exactShareBelow = (dist, pop, m) => {
    let inside = 0, total = 0;
    for (let i = 0; i < dist.length; i++) if (pop[i] > 0) { total += pop[i]; if (dist[i] < m) inside += pop[i]; }
    return total ? inside / total : 0;
  };

  function randomCase(seed, n, { infShare = 0, nanShare = 0, zeroPopShare = 0.1 } = {}) {
    const r = rng(seed);
    const dist = new Float32Array(n), pop = new Uint16Array(n);
    for (let i = 0; i < n; i++) {
      const u = r();
      dist[i] = u < infShare ? Infinity : u < infShare + nanShare ? NaN : Math.round((r() ** 2) * 6000 * 10) / 10;
      pop[i] = r() < zeroPopShare ? 0 : 3 + Math.floor(r() ** 3 * 400);
    }
    return { dist, pop };
  }

  const CASES = {
    'finite distances': randomCase(20, 5000),
    'some residents with no site (Infinity)': randomCase(21, 5000, { infShare: 0.2 }),
    'NaN distances (as the app stores "no site")': randomCase(22, 5000, { nanShare: 0.3 }),
    'a handful of hectares': randomCase(23, 7),
  };

  for (const [label, { dist, pop }] of Object.entries(CASES)) {
    test(`quantile is within one bin of the exact weighted quantile: ${label}`, () => {
      const c = distanceCurve(dist, pop);
      for (const q of [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
        const want = exactQuantile(dist, pop, q), got = c.quantile(q);
        if (want === Infinity) assert.equal(got, Infinity, `q=${q}`);
        else assert.ok(Math.abs(got - want) <= c.bin, `q=${q}: ${got} vs exact ${want}`);
      }
    });

    test(`shareWithin matches the exact share at bin multiples: ${label}`, () => {
      const c = distanceCurve(dist, pop);
      for (const m of [25, 100, 500, 1000, 2500, 5000, 1e6]) close(c.shareWithin(m), exactShareBelow(dist, pop, m), 1e-9, `m=${m}`);
      assert.equal(c.shareWithin(0), 0);
      assert.equal(c.shareWithin(-5), 0);
    });

    test(`cum is non-decreasing, within [0, 1] and ends at the share with a finite distance: ${label}`, () => {
      const c = distanceCurve(dist, pop);
      let prev = 0;
      for (const v of c.cum) { assert.ok(v >= prev && v <= 1 + 1e-12); prev = v; }
      close(c.cum[c.cum.length - 1], exactShareBelow(dist, pop, Infinity), 1e-9);
      let total = 0;
      for (let i = 0; i < pop.length; i++) if (pop[i] > 0) total += pop[i];
      assert.equal(c.total, total);
    });
  }

  test('a single hectare: quantiles interpolate inside its bin', () => {
    const c = distanceCurve([110], [10]);
    assert.equal(c.cum.length, 5);
    assert.deepEqual(Array.from(c.cum), [0, 0, 0, 0, 1]);
    assert.equal(c.quantile(0.5), 112.5); // bin [100, 125), halfway
    assert.equal(c.quantile(1), 125);
    assert.equal(c.shareWithin(100), 0);
    assert.equal(c.shareWithin(125), 1);
  });

  test('hectares without residents are ignored, also for the curve length', () => {
    const c = distanceCurve([10, 99999, 40], [5, 0, 5]);
    assert.equal(c.cum.length, 2);
    assert.equal(c.total, 10);
    assert.equal(c.quantile(0.5), 25);
  });

  test('no site passes the filters: everyone is infinitely far', () => {
    const c = distanceCurve([Infinity, NaN, Infinity], [10, 20, 30]);
    assert.equal(c.total, 60);
    assert.equal(c.quantile(0.5), Infinity);
    assert.equal(c.shareWithin(1000), 0);
  });

  test('empty input', () => {
    const c = distanceCurve(new Float32Array(0), new Uint16Array(0));
    assert.equal(c.total, 0);
    assert.equal(c.quantile(0.5), Infinity);
    assert.equal(c.shareWithin(500), 0);
    assert.ok(Array.from(c.cum).every((v) => v === 0));
  });

  test('custom bin width', () => {
    const c = distanceCurve([0, 100, 200, 300], [1, 1, 1, 1], 100);
    assert.equal(c.bin, 100);
    assert.deepEqual(Array.from(c.cum), [0.25, 0.5, 0.75, 1]);
    assert.equal(c.quantile(0.5), 200);
    assert.equal(c.shareWithin(200), 0.5);
  });
});
