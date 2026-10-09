// swisstopo approximate formulas (accuracy ~1 m), LV95 <-> WGS84.

export function lv95ToWgs(E, N) {
  const y = (E - 2600000) / 1e6, x = (N - 1200000) / 1e6;
  const lon = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y * y * y;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x * x * x;
  return [lon * 100 / 36, lat * 100 / 36];
}

export function wgsToLv95(lon, lat) {
  const p = (lat * 3600 - 169028.66) / 10000, l = (lon * 3600 - 26782.5) / 10000;
  const E = 2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l * l * l;
  const N = 1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p * p * p;
  return [E, N];
}

// LV95 square [E, N, E + size, N + size] as a closed lon/lat ring.
export function squareRing(E, N, size) {
  return [[E, N], [E + size, N], [E + size, N + size], [E, N + size], [E, N]].map(([e, n]) => lv95ToWgs(e, n));
}

/**
 * Point-in-area test for a (multi)polygon: polys = [[outer, ...holes], …], rings as [[x, y], …] in any
 * planar coordinates (LV95 here). Even-odd rule over all rings, so holes and enclaves are outside.
 * Returns inside(x, y), with a bounding-box shortcut, and the box [x0, y0, x1, y1].
 */
export function areaTest(polys) {
  const rings = polys.flat();
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
  const inside = (x, y) => {
    if (x < x0 || x > x1 || y < y0 || y > y1) return false;
    let c = false;
    for (const r of rings) {
      for (let k = 0, j = r.length - 1; k < r.length; j = k++) {
        const [xk, yk] = r[k], [xj, yj] = r[j];
        if ((yk > y) !== (yj > y) && x < ((xj - xk) * (y - yk)) / (yj - yk) + xk) c = !c;
      }
    }
    return c;
  };
  return { inside, box: [x0, y0, x1, y1] };
}
