// web/geo.js: swisstopo's approximate LV95 <-> WGS84 formulas.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { lv95ToWgs, wgsToLv95, squareRing, areaTest } from '../web/geo.js';
import { loadCells, SWISS_BBOX } from './_lib.mjs';

const RAD = Math.PI / 180, R_EARTH = 6371000;
const dms = (d, m, s) => d + m / 60 + s / 3600;
/** Ground distance in metres between two nearby lon/lat points. */
const metres = ([lon1, lat1], [lon2, lat2]) =>
  Math.hypot((lon1 - lon2) * RAD * R_EARTH * Math.cos(lat1 * RAD), (lat1 - lat2) * RAD * R_EARTH);

// Rigorous transformations from swisstopo's REFRAME service
// (https://geodesy.geo.admin.ch/reframe/lv95towgs84?easting=…&northing=…&format=json),
// spread over the country: the Bern origin, all four borders and the main cities.
const REFRAME = [
  [2600000, 1200000, 7.438632495274896, 46.951082876677035], // projection origin (Bern)
  [2700000, 1100000, 8.730497075536219, 46.04413033869967],
  [2485500, 1110000, 5.9570806272116865, 46.131741925841546], // western tip (Chancy, GE)
  [2486000, 1112000, 5.96306149862322, 46.1498147400393],
  [2500000, 1118000, 6.142954250133073, 46.20600709153606], // Geneva
  [2550000, 1150000, 6.787305984882277, 46.499437472808104],
  [2560000, 1130000, 6.919297493418631, 46.32020267905871],
  [2571000, 1105000, 7.063671395788983, 46.09588222322049],
  [2611000, 1267000, 7.5847593233837305, 47.553625541513966], // Basel
  [2612000, 1268000, 7.598071387259323, 47.56260182111956],
  [2620000, 1235000, 7.702898027208495, 47.26560265486215],
  [2680000, 1295000, 8.506438505092428, 47.800637999946524], // northern border
  [2683000, 1248000, 8.537690383974429, 47.37760732422481], // Zurich
  [2690000, 1283000, 8.637449289560406, 47.69143378833643],
  [2717000, 1096000, 8.949066595625837, 46.00542293589276], // Lugano
  [2720000, 1080000, 8.983717460184378, 45.86099844507374],
  [2722000, 1077000, 9.008688751123374, 45.83366070582713], // southern tip (Chiasso)
  [2746000, 1254000, 9.373614351971684, 47.420607030165876], // St. Gallen
  [2750000, 1250000, 9.425263056460189, 47.38374243719474],
  [2780000, 1180000, 9.794533635721983, 46.746869030560205],
  [2830000, 1168000, 10.442368328750552, 46.62362229112218],
  [2833000, 1180000, 10.487596637827854, 46.73044747333988], // eastern tip
];

describe('swisstopo published examples', () => {
  test('projection origin 2600000 / 1200000 is Bern (7.43863°E, 46.95108°N)', () => {
    const [lon, lat] = lv95ToWgs(2600000, 1200000);
    assert.ok(Math.abs(lon - 7.43863) < 1e-5, `lon ${lon}`);
    assert.ok(Math.abs(lat - 46.95108) < 1e-5, `lat ${lat}`);
  });

  // "Approximate formulas for the transformation between Swiss projection coordinates and WGS84",
  // swisstopo, worked examples (results of the approximate formulas, to 0.01").
  test('LV95 2700000 / 1100000 -> 8°43\'49.80" E, 46°02\'38.86" N', () => {
    const [lon, lat] = lv95ToWgs(2700000, 1100000);
    assert.ok(Math.abs(lon - dms(8, 43, 49.80)) * 3600 < 0.005, `lon ${lon}`);
    assert.ok(Math.abs(lat - dms(46, 2, 38.86)) * 3600 < 0.005, `lat ${lat}`);
  });

  test('46°02\'38.87" N, 8°43\'49.79" E -> LV95 2699999.76 / 1099999.97', () => {
    const [E, N] = wgsToLv95(dms(8, 43, 49.79), dms(46, 2, 38.87));
    assert.ok(Math.abs(E - 2699999.76) < 0.005, `E ${E}`);
    assert.ok(Math.abs(N - 1099999.97) < 0.005, `N ${N}`);
  });
});

describe('accuracy against swisstopo REFRAME', () => {
  test('LV95 -> WGS84 within 3 m everywhere, within 1 m in most of the country', () => {
    const errs = REFRAME.map(([E, N, lon, lat]) => metres(lv95ToWgs(E, N), [lon, lat]));
    for (const [k, err] of errs.entries()) assert.ok(err < 3, `${REFRAME[k].slice(0, 2)}: ${err.toFixed(2)} m`);
    // The approximate forward formula degrades towards the western border (2.8 m at Chancy).
    const within1m = errs.filter((e) => e < 1).length;
    assert.ok(within1m >= REFRAME.length - 4, `${within1m}/${REFRAME.length} points within 1 m`);
  });

  test('WGS84 -> LV95 within 0.5 m at every reference point', () => {
    for (const [E, N, lon, lat] of REFRAME) {
      const [e, n] = wgsToLv95(lon, lat);
      assert.ok(Math.hypot(e - E, n - N) < 0.5, `${E}/${N}: ${Math.hypot(e - E, n - N).toFixed(3)} m`);
    }
  });
});

describe('round trip LV95 -> WGS84 -> LV95', () => {
  const roundTrip = (E, N) => {
    const [e, n] = wgsToLv95(...lv95ToWgs(E, N));
    return Math.hypot(e - E, n - N);
  };

  test('under 1 m within 40 km of the projection origin', () => {
    // The error grows fastest towards the north-west (1.2 m at 50 km, 2 m at 80 km).
    for (let E = 2560000; E <= 2640000; E += 1000) {
      for (let N = 1160000; N <= 1240000; N += 1000) {
        if (Math.hypot(E - 2600000, N - 1200000) > 40000) continue;
        assert.ok(roundTrip(E, N) < 1, `${E}/${N}: ${roundTrip(E, N).toFixed(3)} m`);
      }
    }
  });

  test('under 3 m at every inhabited hectare centre', () => {
    const { meta, n, E_IDX, N_IDX } = loadCells();
    let max = 0;
    for (let i = 0; i < n; i++) {
      max = Math.max(max, roundTrip(meta.e0 + E_IDX[i] * 100 + 50, meta.n0 + N_IDX[i] * 100 + 50));
    }
    assert.ok(max < 3, `max ${max.toFixed(3)} m`);
  });

});

describe('shape of the mapping', () => {
  test('outputs are finite and inside Switzerland\'s lon/lat box across the LV95 bbox', () => {
    for (let E = SWISS_BBOX.e0; E <= SWISS_BBOX.e1; E += 10000) {
      for (let N = SWISS_BBOX.n0; N <= SWISS_BBOX.n1; N += 10000) {
        const [lon, lat] = lv95ToWgs(E, N);
        assert.ok(Number.isFinite(lon) && Number.isFinite(lat), `${E}/${N}`);
        assert.ok(lon > 5.8 && lon < 10.7 && lat > 45.7 && lat < 47.9, `${E}/${N} -> ${lon}, ${lat}`);
      }
    }
  });

  test('longitude grows with E and latitude with N', () => {
    for (let N = SWISS_BBOX.n0; N <= SWISS_BBOX.n1; N += 20000) {
      let prev = -Infinity;
      for (let E = SWISS_BBOX.e0; E <= SWISS_BBOX.e1; E += 5000) {
        const [lon] = lv95ToWgs(E, N);
        assert.ok(lon > prev);
        prev = lon;
      }
    }
    for (let E = SWISS_BBOX.e0; E <= SWISS_BBOX.e1; E += 20000) {
      let prev = -Infinity;
      for (let N = SWISS_BBOX.n0; N <= SWISS_BBOX.n1; N += 5000) {
        const [, lat] = lv95ToWgs(E, N);
        assert.ok(lat > prev);
        prev = lat;
      }
    }
  });

  test('a hectare is about 100 m on each side', () => {
    const [sw, se, , nw] = squareRing(2683000, 1248000, 100);
    assert.ok(Math.abs(metres(sw, se) - 100) < 0.5, `${metres(sw, se)}`);
    assert.ok(Math.abs(metres(sw, nw) - 100) < 0.5, `${metres(sw, nw)}`);
  });
});

test('squareRing is a closed SW -> SE -> NE -> NW ring of lv95ToWgs corners', () => {
  const E = 2600000, N = 1200000, s = 500;
  const ring = squareRing(E, N, s);
  assert.equal(ring.length, 5);
  assert.deepEqual(ring[0], ring[4]);
  assert.deepEqual(ring, [[E, N], [E + s, N], [E + s, N + s], [E, N + s], [E, N]].map(([e, n]) => lv95ToWgs(e, n)));
  // Counter-clockwise in lon/lat (positive shoelace area), as GeoJSON exterior rings should be.
  let area = 0;
  for (let k = 0; k < 4; k++) area += ring[k][0] * ring[k + 1][1] - ring[k + 1][0] * ring[k][1];
  assert.ok(area > 0);
});

describe('areaTest (commune boundaries)', () => {
  const sq = (x, y, s) => [[x, y], [x + s, y], [x + s, y + s], [x, y + s], [x, y]];

  test('a square: inside, outside, and its bounding box', () => {
    const { inside, box } = areaTest([[sq(0, 0, 10)]]);
    assert.ok(inside(5, 5));
    assert.ok(!inside(-1, 5) && !inside(11, 5) && !inside(5, 11) && !inside(5, -0.1));
    assert.deepEqual(box, [0, 0, 10, 10]);
  });

  test('a hole (an enclave of another commune) is outside', () => {
    const { inside } = areaTest([[sq(0, 0, 10), sq(4, 4, 2)]]);
    assert.ok(inside(1, 1) && inside(8, 8));
    assert.ok(!inside(5, 5), 'in the hole');
  });

  test('a commune in two parts (MultiPolygon), with the box over both', () => {
    const { inside, box } = areaTest([[sq(0, 0, 10)], [sq(20, 0, 5)]]);
    assert.ok(inside(5, 5) && inside(22, 2));
    assert.ok(!inside(15, 5), 'between the parts');
    assert.deepEqual(box, [0, 0, 25, 10]);
  });

  test('a concave (U-shaped) outline', () => {
    const u = [[0, 0], [9, 0], [9, 9], [6, 9], [6, 3], [3, 3], [3, 9], [0, 9], [0, 0]];
    const { inside } = areaTest([[u]]);
    assert.ok(inside(1, 8) && inside(8, 8) && inside(4.5, 1));
    assert.ok(!inside(4.5, 6), 'in the notch');
  });

  test('hectare centres: a 1 km square holds exactly 100', () => {
    const { inside } = areaTest([[sq(2600000, 1200000, 1000)]]);
    let n = 0;
    for (let e = 2599000; e < 2602000; e += 100) for (let k = 1199000; k < 1202000; k += 100) if (inside(e + 50, k + 50)) n++;
    assert.equal(n, 100);
  });
});

