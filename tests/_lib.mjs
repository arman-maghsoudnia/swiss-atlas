// Shared helpers for the Node test suite (not a test file itself: the name matches none of
// node --test's default patterns).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const ROOT = fileURLToPath(new URL('..', import.meta.url));
export const WEB = `${ROOT}web/`;
export const DATA = `${WEB}data/`;

/** Small deterministic PRNG (mulberry32): same sequence on every run and platform. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

let cells = null;
/** web/data/meta.json + cells.bin.gz decoded with the same layout as parse() in web/app.js. */
export function loadCells() {
  if (cells) return cells;
  const meta = readJson(`${DATA}meta.json`);
  const gz = readFileSync(`${DATA}cells.bin.gz`);
  const raw = gunzipSync(gz);
  const buf = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const n = meta.n, m = meta.noloc.m;
  const col = {}, noloc = {};
  meta.columns.forEach((c, k) => { col[c] = new Uint16Array(buf, (2 + k) * 2 * n, n); });
  const off = meta.noloc.offset;
  const nolocIdx = new Uint32Array(buf, off, m);
  meta.columns.forEach((c, k) => { noloc[c] = new Uint16Array(buf, off + 4 * m + k * 2 * m, m); });
  cells = {
    meta, gzBytes: gz.length, rawBytes: buf.byteLength, buf, n, m,
    E_IDX: new Uint16Array(buf, 0, n), N_IDX: new Uint16Array(buf, 2 * n, n), col, nolocIdx, noloc,
  };
  return cells;
}

let antennas = null;
/** web/data/antennas.json as raw JSON plus the typed-array site table built by loadAntennas(). */
export function loadAntennaData() {
  if (antennas) return antennas;
  const j = readJson(`${DATA}antennas.json`);
  const A = {
    n: j.count, operators: j.operators, types: j.types, powers: j.powers,
    e: Int32Array.from(j.e), N: Int32Array.from(j.n), op: Uint8Array.from(j.op), type: Uint8Array.from(j.type),
    power: Uint8Array.from(j.power), tech: Uint8Array.from(j.tech),
  };
  antennas = { json: j, A };
  return antennas;
}

/** Synthetic site table in the shape antennas.js expects. */
export function makeSites(points, extra = {}) {
  const n = points.length;
  return {
    n,
    e: Int32Array.from(points, (p) => p[0]),
    N: Int32Array.from(points, (p) => p[1]),
    op: Uint8Array.from(points, (p, i) => (extra.op ? extra.op[i] : 0)),
    type: Uint8Array.from(points, (p, i) => (extra.type ? extra.type[i] : 0)),
    tech: Uint8Array.from(points, (p, i) => (extra.tech ? extra.tech[i] : 15)),
  };
}

// Switzerland in LV95 (generous bounding box around the national border).
export const SWISS_BBOX = { e0: 2480000, e1: 2840000, n0: 1070000, n1: 1300000 };
