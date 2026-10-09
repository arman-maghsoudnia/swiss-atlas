// web/antennas.js: filters, the bucket index, nearest-site and radius search (checked against brute force).

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  filterSites, buildIndex, nearest, within, TECH, TECH_LABEL, TYPE_GROUPS, COLOR_MODES, SHAPES,
} from '../web/antennas.js';
import { loadAntennaData, loadCells, makeSites, rng, SWISS_BBOX } from './_lib.mjs';

const ALL_OPS = [true, true, true, true, true];
const only = (...ops) => [0, 1, 2, 3, 4].map((k) => ops.includes(k));

function bruteNearest(A, sites, E, N) {
  let best = -1, bestD2 = Infinity;
  for (const i of sites) {
    const ex = A.e[i] - E, ny = A.N[i] - N, d2 = ex * ex + ny * ny;
    if (d2 < bestD2) { bestD2 = d2; best = i; }
  }
  return [best, Math.sqrt(bestD2), bestD2];
}

function bruteWithin(A, sites, E, N, r) {
  const out = [];
  for (const i of sites) {
    const ex = A.e[i] - E, ny = A.N[i] - N;
    if (ex * ex + ny * ny <= r * r) out.push(i);
  }
  return out.sort((a, b) => a - b);
}

/** nearest() must find a site at exactly the brute-force minimum distance (ties may pick either site). */
function assertNearest(A, sites, index, E, N) {
  const [j, d] = nearest(A, index, E, N);
  const [bj, bd, bd2] = bruteNearest(A, sites, E, N);
  if (bj < 0) {
    assert.deepEqual([j, d], [-1, Infinity]);
    return;
  }
  assert.equal(d, bd, `distance at ${E}/${N}`);
  assert.ok(sites.includes(j), `site ${j} is not in the filtered set`);
  const ex = A.e[j] - E, ny = A.N[j] - N;
  assert.equal(ex * ex + ny * ny, bd2, `returned site ${j} is not at the minimum distance`);
}

function randomQueries(seed, count, box = SWISS_BBOX) {
  const r = rng(seed);
  return Array.from({ length: count }, () => [
    Math.round(box.e0 + r() * (box.e1 - box.e0)), Math.round(box.n0 + r() * (box.n1 - box.n0)),
  ]);
}

const { json, A } = loadAntennaData();

// Filters spanning dense to empty: [label, filter, expected size range].
const FILTERS = [
  ['all sites', { ops: ALL_OPS, tech: '', type: '' }, [20000, 30000]],
  ['Salt 5G', { ops: only(1), tech: '5G', type: '' }, [1000, 10000]],
  ['tunnels', { ops: ALL_OPS, tech: '', type: 'tunnel' }, [100, 5000]],
  ['SBB small cells', { ops: only(3), tech: '', type: 'small' }, [0, 2000]],
  ['German border stations', { ops: only(4), tech: '', type: '' }, [1, 20]],
  ['German border stations, 5G', { ops: only(4), tech: '5G', type: '' }, [0, 0]],
  ['no operator', { ops: [false, false, false, false, false], tech: '', type: '' }, [0, 0]],
];

describe('filterSites', () => {
  for (const [label, f] of FILTERS) {
    test(`matches a brute-force filter: ${label}`, () => {
      const expected = [];
      for (let i = 0; i < A.n; i++) {
        if (!f.ops[A.op[i]]) continue;
        if (f.tech && !(A.tech[i] & TECH[f.tech])) continue;
        if (f.type && !TYPE_GROUPS[f.type].types.includes(A.type[i])) continue;
        expected.push(i);
      }
      const got = filterSites(A, f);
      assert.ok(got instanceof Int32Array);
      assert.deepEqual(Array.from(got), expected);
    });
  }

  test('filter sizes are what the fixtures assume', () => {
    for (const [label, f, [lo, hi]] of FILTERS) {
      const n = filterSites(A, f).length;
      assert.ok(n >= lo && n <= hi, `${label}: ${n} sites`);
    }
  });

  test('every site belongs to exactly one type group', () => {
    const groupOf = new Map();
    for (const [key, g] of Object.entries(TYPE_GROUPS)) {
      for (const t of g.types) {
        assert.ok(!groupOf.has(t), `type ${t} in two groups`);
        groupOf.set(t, key);
      }
    }
    for (let t = 0; t < json.types.length; t++) assert.ok(groupOf.has(t), `type ${json.types[t]} has no group`);
  });
});

describe('buildIndex', () => {
  test('puts every filtered site in exactly one bucket, sized to the density', () => {
    for (const [label, f] of FILTERS) {
      const sites = filterSites(A, f);
      const idx = buildIndex(A, sites);
      assert.equal(idx.count, sites.length, label);
      assert.ok(idx.size >= 1000 && idx.size <= 50000 && idx.size % 1000 === 0, `${label}: size ${idx.size}`);
      const seen = [];
      for (const b of idx.buckets.values()) seen.push(...b);
      assert.deepEqual(seen.sort((a, b) => a - b), Array.from(sites).sort((a, b) => a - b), label);
    }
  });

  test('dense filters get small buckets, sparse ones large', () => {
    assert.equal(buildIndex(A, filterSites(A, FILTERS[0][1])).size, 1000);
    assert.equal(buildIndex(A, Int32Array.of(0)).size, 50000);
    assert.equal(buildIndex(A, new Int32Array(0)).size, 50000);
  });
});

describe('nearest() equals brute force', () => {
  const queries = randomQueries(1, 1500);
  for (const [label, f] of FILTERS) {
    test(`random points in Switzerland: ${label}`, () => {
      const sites = Array.from(filterSites(A, f));
      const idx = buildIndex(A, Int32Array.from(sites));
      for (const [E, N] of queries) assertNearest(A, sites, idx, E, N);
    });
  }

  test('random subsets of 1 to 20 real sites', () => {
    const r = rng(2);
    for (let k = 1; k <= 20; k++) {
      const sites = Array.from({ length: k }, () => Math.floor(r() * A.n));
      const idx = buildIndex(A, Int32Array.from(sites));
      for (const [E, N] of randomQueries(100 + k, 200)) assertNearest(A, sites, idx, E, N);
    }
  });

  test('hectare centres (as the app queries them)', () => {
    const { meta, n, E_IDX, N_IDX } = loadCells();
    const r = rng(3);
    const sample = Array.from({ length: 3000 }, () => Math.floor(r() * n));
    for (const [, f] of FILTERS) {
      const sites = Array.from(filterSites(A, f));
      const idx = buildIndex(A, Int32Array.from(sites));
      // Sparse filters are cheap to brute-force, so check every hectare for them.
      const cells = sites.length <= 20 ? { length: n, at: (k) => k } : { length: sample.length, at: (k) => sample[k] };
      for (let k = 0; k < cells.length; k++) {
        const i = cells.at(k);
        assertNearest(A, sites, idx, meta.e0 + E_IDX[i] * 100 + 50, meta.n0 + N_IDX[i] * 100 + 50);
      }
    }
  });

  test('synthetic clustered and gridded site sets', () => {
    const r = rng(4);
    const sets = {
      cluster: Array.from({ length: 300 }, () => [2600000 + Math.round(r() * 2000), 1200000 + Math.round(r() * 2000)]),
      grid: Array.from({ length: 400 }, (_, k) => [2500000 + (k % 20) * 10000, 1100000 + Math.floor(k / 20) * 10000]),
      twoFar: [[2486000, 1112000], [2833000, 1180000]],
      line: Array.from({ length: 50 }, (_, k) => [2550000 + k * 4000, 1150000]),
    };
    for (const [label, pts] of Object.entries(sets)) {
      const S = makeSites(pts);
      const sites = pts.map((_, i) => i);
      const idx = buildIndex(S, Int32Array.from(sites));
      for (const [E, N] of randomQueries(label.length, 500)) assertNearest(S, sites, idx, E, N);
      for (const [E, N] of pts.slice(0, 50)) assertNearest(S, sites, idx, E + 1, N - 1);
    }
  });
});

describe('nearest() edge cases', () => {
  const dense = filterSites(A, FILTERS[0][1]);
  const denseIdx = buildIndex(A, dense);

  test('a query exactly on a site is at distance 0', () => {
    for (const i of [0, 1, 17, 4242, A.n - 1]) {
      const [j, d] = nearest(A, denseIdx, A.e[i], A.N[i]);
      assert.equal(d, 0);
      assert.deepEqual([A.e[j], A.N[j]], [A.e[i], A.N[i]]);
    }
  });

  test('queries far outside Switzerland still find the true nearest site', () => {
    const far = [[2000000, 900000], [3300000, 1600000], [2650000, 700000], [2486287 - 150000, 1111150]];
    const sparse = Array.from(filterSites(A, FILTERS[4][1]));
    const sparseIdx = buildIndex(A, Int32Array.from(sparse));
    for (const [E, N] of far) {
      assertNearest(A, Array.from(dense), denseIdx, E, N);
      assertNearest(A, sparse, sparseIdx, E, N);
    }
    assertNearest(A, sparse, sparseIdx, 0, 0);
  });

  test('an empty index returns [-1, Infinity] and nothing within any radius', () => {
    const idx = buildIndex(A, new Int32Array(0));
    assert.deepEqual(nearest(A, idx, 2600000, 1200000), [-1, Infinity]);
    assert.deepEqual(within(A, idx, 2600000, 1200000, 1e6), []);
  });

  test('a single site is found from anywhere', () => {
    const S = makeSites([[2700000, 1150000]]);
    const idx = buildIndex(S, Int32Array.of(0));
    for (const [E, N] of [[2700000, 1150000], [2486000, 1300000], [2840000, 1070000], [0, 0]]) {
      const [j, d] = nearest(S, idx, E, N);
      assert.equal(j, 0);
      assert.equal(d, Math.hypot(2700000 - E, 1150000 - N));
    }
  });

  test('equidistant sites: either one, at the shared distance', () => {
    const S = makeSites([[2600000, 1200000], [2602000, 1200000]]);
    const idx = buildIndex(S, Int32Array.of(0, 1));
    const [j, d] = nearest(S, idx, 2601000, 1200000);
    assert.ok(j === 0 || j === 1);
    assert.equal(d, 1000);
  });
});

describe('within() equals brute force', () => {
  for (const [label, f] of FILTERS) {
    test(label, () => {
      const sites = Array.from(filterSites(A, f));
      const idx = buildIndex(A, Int32Array.from(sites));
      const radii = [0, 75, 500, 1000, 5000, 20000];
      for (const [k, [E, N]] of randomQueries(5, 300).entries()) {
        const r = radii[k % radii.length];
        assert.deepEqual(within(A, idx, E, N, r).sort((a, b) => a - b), bruteWithin(A, sites, E, N, r), `${E}/${N} r=${r}`);
      }
    });
  }

  test('includes sites exactly on the circle and the site under the query point', () => {
    const S = makeSites([[2600000, 1200000], [2600300, 1200400], [2600301, 1200400]]);
    const idx = buildIndex(S, Int32Array.of(0, 1, 2));
    assert.deepEqual(within(S, idx, 2600000, 1200000, 0), [0]);
    assert.deepEqual(within(S, idx, 2600000, 1200000, 500).sort(), [0, 1]); // 300-400-500 triangle
  });
});

describe('categories', () => {
  test('TECH_LABEL lists the generations in a mask', () => {
    assert.equal(TECH_LABEL(0), '–');
    assert.equal(TECH_LABEL(TECH['2G']), '2G');
    assert.equal(TECH_LABEL(TECH['3G'] | TECH['4G'] | TECH['5G']), '3G, 4G, 5G');
    assert.equal(TECH_LABEL(15), '2G, 3G, 4G, 5G');
  });

  test('every colour mode maps every real site to one of its categories (and a shape)', () => {
    for (const [mode, cm] of Object.entries(COLOR_MODES)) {
      assert.ok(cm.cats.length <= SHAPES.length, mode);
      for (let i = 0; i < A.n; i++) {
        const c = cm.of(A, i);
        assert.ok(Number.isInteger(c) && c >= 0 && c < cm.cats.length, `${mode}: site ${i} -> ${c}`);
      }
    }
  });
});
