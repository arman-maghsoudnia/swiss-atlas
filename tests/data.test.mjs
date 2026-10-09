// Invariants of the committed data in web/data that web/app.js and web/antennas.js rely on
// (layout written by scripts/build_data.py and scripts/build_antennas.py).

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, test } from 'node:test';
import { DATA, ROOT, loadAntennaData, loadCells, SWISS_BBOX } from './_lib.mjs';

const README = readFileSync(`${ROOT}README.md`, 'utf8');
/** Numbers the README quotes must match the data. A rephrased sentence is skipped, not failed. */
function checkReadme(t, claims) {
  let found = 0;
  for (const [re, actual] of claims) {
    const m = README.match(re);
    if (!m) continue;
    found++;
    assert.equal(Number(m[1].replace(/,/g, '')), actual, `README: "${m[0]}"`);
  }
  if (!found) t.skip('README no longer quotes these numbers');
}

describe('cells.bin.gz and meta.json', () => {
  const c = loadCells();
  const { meta, n, m } = c;

  test('meta.json has the fields app.js reads', () => {
    for (const k of ['source', 'year', 'referenceDate', 'n', 'e0', 'n0', 'cellSize', 'columns', 'labels', 'ageBands', 'max', 'totals', 'noloc', 'rawBytes']) {
      assert.ok(k in meta, `missing ${k}`);
    }
    for (const k of ['m', 'offset', 'gmde', 'residents']) assert.ok(k in meta.noloc, `missing noloc.${k}`);
    assert.equal(meta.cellSize, 100);
    assert.equal(meta.e0 % 100000, 0);
    assert.equal(meta.n0 % 100000, 0);
    assert.equal(meta.ageBands.length, 19);
    assert.deepEqual(Object.keys(meta.labels), meta.columns);
    assert.deepEqual(Object.keys(meta.totals).sort(), [...meta.columns].sort());
    assert.deepEqual(Object.keys(meta.max).sort(), [...meta.columns].sort());
    assert.equal(meta.noloc.gmde.length, m);
  });

  test('the app\'s fixed column lists exist (age bands, sexes, households, durations)', () => {
    const cols = new Set(meta.columns);
    const pad2 = (k) => String(k).padStart(2, '0');
    const need = ['BBTOT', 'BBMTOT', 'BBWTOT', 'HPTOT', 'HPI', 'BB11', 'BB12'];
    for (let k = 1; k <= 19; k++) need.push(`BBM${pad2(k)}`, `BBW${pad2(k)}`);
    for (let k = 1; k <= 6; k++) need.push(`HP${pad2(k)}`);
    for (let k = 41; k <= 46; k++) need.push(`BB${k}`);
    for (let k = 51; k <= 56; k++) need.push(`BB${k}`);
    for (const code of need) assert.ok(cols.has(code), code);
  });

  test('decompressed size matches the layout: 2 index columns + one uint16 column per attribute, then the noloc block', () => {
    assert.equal(c.rawBytes, meta.rawBytes);
    const columnsEnd = 2 * n * (2 + meta.columns.length);
    assert.ok(meta.noloc.offset >= columnsEnd && meta.noloc.offset - columnsEnd < 4, 'padding is at most 3 bytes');
    assert.equal(meta.noloc.offset % 4, 0, 'Uint32Array view needs a 4-byte aligned offset');
    assert.equal(meta.rawBytes, meta.noloc.offset + 4 * m + 2 * m * meta.columns.length);
  });

  test('STATPOP 2024 snapshot: 347,736 hectares, 9,123,704 residents, 53,619 non-geocoded', () => {
    assert.equal(n, 347736);
    assert.equal(meta.totals.BBTOT, 9123704);
    assert.equal(meta.noloc.residents, 53619);
    assert.equal(meta.columns.length, 77);
  });

  test('the README quotes the same totals', (t) => {
    checkReadme(t, [
      [/the grid sums to ([\d,]+) residents/, meta.totals.BBTOT],
      [/([\d,]+) people without a geocoded address/, meta.noloc.residents],
      [/any of the (\d+) published attributes/, meta.columns.length],
    ]);
  });

  test('totals and maxima in meta.json match the columns', () => {
    for (const code of meta.columns) {
      const a = c.col[code];
      let sum = 0, max = 0;
      for (let i = 0; i < n; i++) { sum += a[i]; if (a[i] > max) max = a[i]; }
      assert.equal(sum, meta.totals[code], `total ${code}`);
      assert.equal(max, meta.max[code], `max ${code}`);
    }
  });

  test('every hectare is inside Switzerland, unique, and inhabited', () => {
    const seen = new Set();
    const pop = c.col.BBTOT;
    for (let i = 0; i < n; i++) {
      const E = meta.e0 + c.E_IDX[i] * 100, N = meta.n0 + c.N_IDX[i] * 100;
      assert.ok(E >= SWISS_BBOX.e0 && E < SWISS_BBOX.e1 && N >= SWISS_BBOX.n0 && N < SWISS_BBOX.n1, `hectare ${i}: ${E}/${N}`);
      const key = c.E_IDX[i] * 65536 + c.N_IDX[i]; // CELL_OF key in app.js
      assert.ok(!seen.has(key), `duplicate hectare ${E}/${N}`);
      seen.add(key);
      assert.ok(pop[i] >= 3, `hectare ${i} has ${pop[i]} residents`);
    }
  });

  test('data protection: counts 1 and 2 are published as 3 (no 1s or 2s anywhere)', () => {
    for (const code of meta.columns) {
      if (code === 'HPI') continue; // a class (0, 1, 2), not a count
      const a = c.col[code];
      let bad = 0;
      for (let i = 0; i < n; i++) if (a[i] === 1 || a[i] === 2) bad++;
      assert.equal(bad, 0, `${code}: ${bad} hectares with 1 or 2`);
    }
    assert.ok(c.col.HPI.every((v) => v <= 2));
  });

  // Checked as asked: BBMTOT + BBWTOT == BBTOT does NOT hold for every hectare (104,382 of 347,736
  // differ), because each of the three is rounded up to 3 when it is 1–3. It holds exactly whenever
  // neither BBMTOT nor BBWTOT is a rounded 3, and otherwise the three are consistent intervals.
  test('men + women = residents, up to the 1–3 -> 3 rounding', () => {
    const t = c.col.BBTOT, men = c.col.BBMTOT, women = c.col.BBWTOT;
    const lo = (x) => (x === 3 ? 1 : x); // a published 3 is a true 1, 2 or 3
    let differ = 0;
    for (let i = 0; i < n; i++) {
      if (men[i] + women[i] !== t[i]) differ++;
      if (men[i] !== 3 && women[i] !== 3) assert.equal(men[i] + women[i], t[i], `hectare ${i}`);
      assert.ok(lo(men[i]) + lo(women[i]) <= t[i] && lo(t[i]) <= men[i] + women[i], `hectare ${i}: ${men[i]} + ${women[i]} vs ${t[i]}`);
    }
    assert.ok(differ > 0, 'every hectare adds up: the rounding note in the README may be out of date');
  });

  test('non-geocoded block: valid hectare indices, each once, never above the hectare\'s own values', () => {
    const idx = c.nolocIdx;
    assert.equal(new Set(idx).size, m);
    let residents = 0;
    for (let j = 0; j < m; j++) {
      assert.ok(idx[j] < n, `noloc ${j} -> ${idx[j]}`);
      for (const code of meta.columns) {
        if (code === 'HPI') continue;
        assert.ok(c.noloc[code][j] <= c.col[code][idx[j]], `${code} at noloc ${j}`);
      }
      residents += c.noloc.BBTOT[j];
    }
    assert.equal(residents, meta.noloc.residents);
    for (const g of meta.noloc.gmde) assert.ok(Number.isInteger(g) && g > 0, `GMDE ${g}`);
  });
});

describe('antennas.json', () => {
  const { json: j, A } = loadAntennaData();
  const COLS = ['e', 'n', 'op', 'type', 'power', 'tech', 'adaptive', 'date', 'exempt', 'limit', 'name'];

  test('every column array has `count` entries', () => {
    assert.ok(Number.isInteger(j.count) && j.count > 0);
    for (const k of COLS) {
      assert.ok(Array.isArray(j[k]), k);
      assert.equal(j[k].length, j.count, k);
    }
  });

  test('lookup tables match what antennas.js indexes', () => {
    assert.equal(j.operators.length, 5); // filter ops: bool[5]
    assert.equal(j.operatorLabels.length, 5);
    assert.equal(j.types.length, 6); // TYPE_GROUPS cover 0..5
    assert.equal(j.powers.length, 4);
  });

  test('coordinates are integers within Switzerland\'s LV95 bbox (and inside the hectare grid\'s origin)', () => {
    const { meta } = loadCells();
    for (let i = 0; i < j.count; i++) {
      const e = j.e[i], n = j.n[i];
      assert.ok(Number.isInteger(e) && Number.isInteger(n), `site ${i}`);
      assert.ok(e >= SWISS_BBOX.e0 && e <= SWISS_BBOX.e1 && n >= SWISS_BBOX.n0 && n <= SWISS_BBOX.n1, `site ${i} (${j.name[i]}): ${e}/${n}`);
      // blockPairs() keys blocks by floor((E - e0) / s) * 65536 + …, which needs E >= e0 and N >= n0.
      assert.ok(e >= meta.e0 && n >= meta.n0);
    }
  });

  test('categorical columns hold valid codes', () => {
    for (let i = 0; i < j.count; i++) {
      assert.ok(Number.isInteger(j.op[i]) && j.op[i] >= 0 && j.op[i] < j.operators.length, `op ${i}`);
      assert.ok(Number.isInteger(j.type[i]) && j.type[i] >= 0 && j.type[i] < j.types.length, `type ${i}`);
      assert.ok(Number.isInteger(j.power[i]) && j.power[i] >= 0 && j.power[i] < j.powers.length, `power ${i}`);
      assert.ok(Number.isInteger(j.tech[i]) && j.tech[i] >= 0 && j.tech[i] <= 15, `tech ${i}`);
      assert.ok(j.adaptive[i] === 0 || j.adaptive[i] === 1, `adaptive ${i}`);
      assert.ok(j.exempt[i] === 0 || j.exempt[i] === 1, `exempt ${i}`);
      assert.ok(j.date[i] === '' || /^\d{4}-\d{2}-\d{2}$/.test(j.date[i]), `date ${i}: ${j.date[i]}`);
      assert.ok(j.limit[i] === null || (typeof j.limit[i] === 'number' && j.limit[i] > 0), `limit ${i}`);
      assert.ok(typeof j.name[i] === 'string' && j.name[i].length > 0, `name ${i}`);
    }
  });

  test('operator names start with the operator (German networks aside)', () => {
    for (let i = 0; i < j.count; i++) {
      const op = j.operators[j.op[i]];
      if (op !== 'Foreign') assert.ok(j.name[i].startsWith(`${op} `), `${j.name[i]} is ${op}`);
    }
  });

  test('German-network stations are 2G only, and the README quotes the same counts', (t) => {
    const foreign = j.operators.indexOf('Foreign');
    const german = [];
    for (let i = 0; i < j.count; i++) if (j.op[i] === foreign) german.push(i);
    for (const i of german) assert.equal(j.tech[i], 1, `${j.name[i]} is not 2G only`);
    checkReadme(t, [
      [/snapshot in `web\/data\/` has ([\d,]+) sites/, A.n],
      [/(\d+) German-network 2G stations/, german.length],
    ]);
  });
});

test('cells.bin.gz is a gzip stream (app.js sniffs the 1f 8b magic bytes)', () => {
  const head = readFileSync(`${DATA}cells.bin.gz`).subarray(0, 2);
  assert.deepEqual(Array.from(head), [0x1f, 0x8b]);
});
