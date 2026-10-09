// web/i18n: every string of the interface has a German, French and Italian translation, with the
// same placeholders, and the language conventions the dictionaries promise hold.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { allKeys } from './_i18n.mjs';
import de from '../web/i18n/de.js';
import fr from '../web/i18n/fr.js';
import it from '../web/i18n/it.js';
import { t, tp, fmtFixed, fmtPct, lang } from '../web/i18n.js';

const DICTS = { de, fr, it };
const keys = await allKeys();
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('translations', () => {
  test('the interface has keys to translate (the extractor works)', () => {
    assert.ok(keys.length > 400, `${keys.length} keys`);
    for (const k of ['Colour by', 'Under {v}', '{n} sites', 'Residents, total', 'Outdoor > 6 W', 'Commune']) assert.ok(keys.includes(k), k);
  });

  for (const [code, dict] of Object.entries(DICTS)) {
    test(`${code}: every key is translated, nothing is left over`, () => {
      const missing = keys.filter((k) => !Object.hasOwn(dict, k));
      assert.deepEqual(missing, [], `missing in ${code}`);
      const unused = Object.keys(dict).filter((k) => !keys.includes(k));
      assert.deepEqual(unused, [], `unused in ${code}`);
    });

    test(`${code}: same placeholders, no empty or untrimmed text`, () => {
      for (const k of keys) {
        const v = dict[k];
        assert.deepEqual(placeholders(v), placeholders(k), `${code}: ${k}`);
        assert.ok(v.trim().length, `${code}: empty for ${k}`);
        assert.equal(/^\s/.test(v), /^\s/.test(k), `${code}: leading space in ${v}`);
        assert.equal(/\s$/.test(v), /\s$/.test(k), `${code}: trailing space in ${v}`);
      }
    });

    test(`${code}: typographic apostrophes and quotes`, () => {
      for (const k of keys) assert.ok(!/['"]/.test(dict[k]), `${code}: straight quote in ${dict[k]}`);
    });
  }

  test('de: Swiss spelling (ss, not ß)', () => {
    for (const k of keys) assert.ok(!de[k].includes('ß'), de[k]);
  });

  test('fr: a no-break space before ":", none before ";", "!" or "?"', () => {
    for (const k of keys) {
      const v = fr[k];
      for (const m of v.matchAll(/:/g)) assert.equal(v[m.index - 1], '\u00a0', `fr: ${v}`);
      assert.ok(!/\s[;!?]/.test(v), `fr: space before punctuation in ${v}`);
    }
  });

  test('fr and it use MN95 and their own abbreviations (OFS, UST; OFCOM, UFCOM)', () => {
    for (const k of keys.filter((x) => /LV95/.test(x))) {
      assert.match(fr[k], /MN95/); assert.match(it[k], /MN95/); assert.match(de[k], /LV95/);
    }
    assert.equal(fr['STATPOP2024, FSO GEOSTAT'], 'STATPOP2024, OFS GEOSTAT');
    assert.equal(it['STATPOP2024, FSO GEOSTAT'], 'STATPOP2024, UST GEOSTAT');
    assert.equal(de['STATPOP2024, FSO GEOSTAT'], 'STATPOP2024, BFS GEOSTAT');
    assert.deepEqual([de.OFCOM, fr.OFCOM, it.OFCOM], ['BAKOM', 'OFCOM', 'UFCOM']);
    assert.deepEqual([de.SBB, fr.SBB, it.SBB], ['SBB', 'CFF', 'FFS']);
  });

  test('English (the test runner\'s language) shows the keys, with placeholders filled', () => {
    assert.equal(lang, 'en');
    assert.equal(t('Colour by'), 'Colour by');
    assert.equal(t('Within {dist}', { dist: '2 km' }), 'Within 2 km');
    assert.equal(t('{a} and {b}', { a: 1 }), '1 and {b}', 'an unknown placeholder stays');
    assert.equal(tp(1, '{n} site', '{n} sites'), '1 site');
    assert.equal(tp(12345, '{n} site', '{n} sites'), '12’345 sites');
    assert.equal(fmtFixed(2.5, 2), '2.50');
    assert.equal(fmtPct(0.264, 1), '26.4%');
  });
});
