// OFCOM mobile antenna sites: loading, filtering, categories and nearest-site search.

import { lv95ToWgs } from './geo.js';

export const TECH = { '2G': 1, '3G': 2, '4G': 4, '5G': 8 };
export const TECH_LABEL = (mask) => ['2G', '3G', '4G', '5G'].filter((g) => mask & TECH[g]).join(', ') || '–';

// Type groups used for filtering / colouring (indices into data.types).
export const TYPE_GROUPS = {
  macro: { label: 'Outdoor > 6 W', types: [0] },
  small: { label: 'Small cells ≤ 6 W', types: [1, 2] },
  tunnel: { label: 'Tunnel', types: [3] },
  other: { label: 'Other', types: [4, 5] },
};

// Colour-by modes: each maps a site to a category 0..3 (3 = neutral "other").
// Categories 0–2 use the validated trio; 3 is grey. Shapes repeat the category as a second cue.
export const COLOR_MODES = {
  single: { label: 'One colour', cats: ['All sites'], of: () => 0 },
  operator: { label: 'Operator', cats: ['Swisscom', 'Salt', 'Sunrise', 'SBB & other'], of: (A, i) => Math.min(A.op[i], 3) },
  tech: { label: 'Technology', cats: ['5G', '4G (no 5G)', '2G/3G only'], of: (A, i) => (A.tech[i] & 8 ? 0 : A.tech[i] & 4 ? 1 : 2) },
  type: {
    label: 'Type', cats: ['Outdoor > 6 W', 'Small cell ≤ 6 W', 'Tunnel', 'Other'],
    of: (A, i) => (A.type[i] === 0 ? 0 : A.type[i] <= 2 ? 1 : A.type[i] === 3 ? 2 : 3),
  },
};
export const SHAPES = ['circle', 'square', 'triangle', 'diamond'];
export const PALETTE = {
  light: ['#eda100', '#e87ba4', '#008300', '#898781'],
  dark: ['#c98500', '#d55181', '#008300', '#898781'],
};

/** @param source a URL, or a fetch() promise already under way */
export async function loadAntennas(source) {
  const res = await (typeof source === 'string' ? fetch(source, { cache: 'no-cache' }) : source);
  if (!res.ok) return null;
  const j = await res.json();
  const n = j.count;
  const A = {
    n, operators: j.operators, operatorLabels: j.operatorLabels,
    // Display forms: "Outdoor > 6 W" (ERP is jargon), "Medium (≤ 5 kW)" rather than "medium (≤ 5,000 W)".
    types: j.types.map((t) => t.replace(/ ERP$/, '')),
    powers: j.powers.map((p) => (p[0].toUpperCase() + p.slice(1)).replace(/(\d+),000 W/, '$1 kW')),
    e: Int32Array.from(j.e), N: Int32Array.from(j.n), op: Uint8Array.from(j.op), type: Uint8Array.from(j.type),
    power: Uint8Array.from(j.power), tech: Uint8Array.from(j.tech), adaptive: Uint8Array.from(j.adaptive),
    exempt: Uint8Array.from(j.exempt), date: j.date, limit: j.limit, name: j.name,
    pos: new Float32Array(2 * n),
  };
  for (let i = 0; i < n; i++) {
    const [lon, lat] = lv95ToWgs(A.e[i], A.N[i]);
    A.pos[2 * i] = lon; A.pos[2 * i + 1] = lat;
  }
  return A;
}

/** Indices of sites passing the filters {ops: bool[5], tech: ''|'2G'…, type: ''|groupKey}. */
export function filterSites(A, f) {
  const types = f.type ? new Set(TYPE_GROUPS[f.type].types) : null;
  const techBit = f.tech ? TECH[f.tech] : 0;
  const out = [];
  for (let i = 0; i < A.n; i++) {
    if (!f.ops[A.op[i]]) continue;
    if (techBit && !(A.tech[i] & techBit)) continue;
    if (types && !types.has(A.type[i])) continue;
    out.push(i);
  }
  return Int32Array.from(out);
}

// Square buckets sized to the site density (about one site per bucket, 1–50 km), so a sparse filter
// such as the 20 border stations needs a few rings instead of hundreds.
const SWISS_AREA = 41285e6; // m²
const bkey = (bx, by) => bx * 100000 + by; // LV95 / bucket size stays far below 100000

export function buildIndex(A, sites) {
  const size = Math.min(50000, Math.max(1000, Math.round(Math.sqrt(SWISS_AREA / Math.max(1, sites.length)) / 1000) * 1000));
  const buckets = new Map();
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const i of sites) {
    const bx = Math.floor(A.e[i] / size), by = Math.floor(A.N[i] / size), k = bkey(bx, by);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = []));
    b.push(i);
    x0 = Math.min(x0, bx); x1 = Math.max(x1, bx); y0 = Math.min(y0, by); y1 = Math.max(y1, by);
  }
  return { buckets, count: sites.length, size, x0, x1, y0, y1 };
}

/** Nearest indexed site to (E, N): returns [index, distance m] or [-1, Infinity]. */
export function nearest(A, index, E, N) {
  if (!index.count) return [-1, Infinity];
  const { buckets, size } = index;
  const bx = Math.floor(E / size), by = Math.floor(N / size);
  // Rings (in buckets) around the query's bucket, until every occupied bucket has been covered.
  const lastRing = Math.max(bx - index.x0, index.x1 - bx, by - index.y0, index.y1 - by);
  let best = -1, bestD2 = Infinity;
  const scan = (x, y) => {
    const b = buckets.get(bkey(x, y));
    if (!b) return;
    for (const i of b) {
      const ex = A.e[i] - E, ny = A.N[i] - N, d2 = ex * ex + ny * ny;
      if (d2 < bestD2) { bestD2 = d2; best = i; }
    }
  };
  scan(bx, by);
  for (let r = 1; r <= lastRing; r++) {
    // Everything in ring r is at least (r - 1) buckets away.
    if (best >= 0 && (r - 1) * size > Math.sqrt(bestD2)) break;
    for (let d = -r; d <= r; d++) { scan(bx + d, by - r); scan(bx + d, by + r); }
    for (let d = 1 - r; d < r; d++) { scan(bx - r, by + d); scan(bx + r, by + d); }
  }
  return [best, Math.sqrt(bestD2)];
}

/** Sites within radius r (m) of (E, N). */
export function within(A, index, E, N, r) {
  const out = [];
  if (!index.count) return out;
  const { size } = index;
  const b0x = Math.floor((E - r) / size), b1x = Math.floor((E + r) / size);
  const b0y = Math.floor((N - r) / size), b1y = Math.floor((N + r) / size);
  for (let bx = b0x; bx <= b1x; bx++) {
    for (let by = b0y; by <= b1y; by++) {
      const b = index.buckets.get(bkey(bx, by));
      if (!b) continue;
      for (const i of b) {
        const ex = A.e[i] - E, ny = A.N[i] - N;
        if (ex * ex + ny * ny <= r * r) out.push(i);
      }
    }
  }
  return out;
}

/** Shape atlas for the IconLayer (white masks, recoloured per site). */
export function shapeAtlas() {
  const S = 64, canvas = document.createElement('canvas');
  canvas.width = S * SHAPES.length; canvas.height = S;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fff';
  const c = S / 2;
  SHAPES.forEach((shape, k) => {
    const x = k * S;
    g.beginPath();
    if (shape === 'circle') g.arc(x + c, c, 26, 0, 2 * Math.PI);
    if (shape === 'square') g.rect(x + 9, 9, S - 18, S - 18);
    if (shape === 'triangle') { g.moveTo(x + c, 3); g.lineTo(x + S - 3, S - 8); g.lineTo(x + 3, S - 8); g.closePath(); }
    if (shape === 'diamond') { g.moveTo(x + c, 2); g.lineTo(x + S - 2, c); g.lineTo(x + c, S - 2); g.lineTo(x + 2, c); g.closePath(); }
    g.fill();
  });
  const mapping = Object.fromEntries(SHAPES.map((s, k) => [s, { x: k * S, y: 0, width: S, height: S, mask: true }]));
  return { canvas, mapping };
}
