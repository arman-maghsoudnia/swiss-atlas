// The translation keys the interface uses, for tests/i18n.test.mjs: string literals passed to t(),
// tp() and press() in the browser modules, texts and attributes marked data-i18n in index.html, and
// the labels that come from the data (FSO attributes, antenna categories).

import fs from 'node:fs';
import { WEB, readJson } from './_lib.mjs';
import { COLOR_MODES, loadAntennas } from '../web/antennas.js';

// Which arguments of a call are keys: t(key, vars), tp(n, one, other, vars), press(click, tap).
const KEY_ARGS = { t: [0], tp: [1, 2], press: [0, 1] };

/** Split the argument list that starts after "(" at i; returns [args source text, end index]. */
function callArgs(src, i) {
  const args = [];
  let depth = 0, start = i;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (c === "'" || c === '"' || c === '`') { // skip a string literal
      for (k++; k < src.length && src[k] !== c; k++) if (src[k] === '\\') k++;
      continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) {
      if (depth === 0) { args.push(src.slice(start, k)); return [args, k]; }
      depth--;
    } else if (c === ',' && depth === 0) { args.push(src.slice(start, k)); start = k + 1; }
  }
  throw new Error(`unterminated call at ${i}`);
}
const literals = (code) => [...code.matchAll(/'((?:[^'\\]|\\.)*)'|"((?:[^"\\]|\\.)*)"/g)]
  .map((m) => (m[1] ?? m[2]).replace(/\\(.)/g, '$1'));

/** Keys used in a JavaScript source file, with the call they come from. */
export function codeKeys(file) {
  const src = fs.readFileSync(file, 'utf8').replace(/\/\/[^\n]*/g, (c) => c.replace(/['"`]/g, ' ')); // quotes in comments
  const keys = [];
  for (const m of src.matchAll(/(?<![\w.$])(t|tp|press)\(/g)) {
    const [args] = callArgs(src, m.index + m[0].length);
    for (const a of KEY_ARGS[m[1]]) {
      const arg = args[a] ?? '';
      if (arg.includes('`')) throw new Error(`${file}: template literal as a key: ${m[1]}(${arg})`);
      keys.push(...literals(arg)); // a literal, or the literals of a ternary
    }
  }
  return keys;
}

/** Keys in index.html: the text of [data-i18n] elements and the [data-i18n-attr] attributes. */
export function pageKeys(file = `${WEB}index.html`) {
  const html = fs.readFileSync(file, 'utf8');
  const keys = [];
  const decode = (s) => s.replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').replace(/&quot;/g, '"');
  for (const m of html.matchAll(/<(\w+)([^>]*)>/g)) {
    const [, tag, attrs] = m;
    if (/\sdata-i18n(\s|>|$)/.test(attrs + '>')) {
      const close = html.indexOf(`</${tag}>`, m.index);
      const text = html.slice(m.index + m[0].length, close);
      if (/</.test(text)) throw new Error(`data-i18n on an element with children: ${m[0]}`);
      keys.push(decode(text.trim().replace(/\s+/g, ' ')));
    }
    const named = /\sdata-i18n-attr="([^"]+)"/.exec(attrs)?.[1];
    for (const name of named?.split(' ') ?? []) {
      const v = new RegExp(`\\s${name}="([^"]*)"`).exec(attrs)?.[1];
      if (v === undefined) throw new Error(`${m[0]} has no ${name}`);
      keys.push(decode(v));
    }
  }
  return keys;
}

/** Labels that reach t() from the data: FSO attributes, antenna operators, types, power classes. */
export async function dataKeys() {
  const meta = readJson(`${WEB}data/meta.json`);
  const A = await loadAntennas(Promise.resolve(new Response(fs.readFileSync(`${WEB}data/antennas.json`))));
  return [
    ...Object.values(meta.labels), meta.source,
    ...A.operatorLabels, ...A.types, ...A.powers,
    ...Object.values(COLOR_MODES).flatMap((m) => m.cats),
    'SBB', 'German (border)', // short operator labels (app.js shortOp)
    'very low power', 'low power', 'medium power', 'high power', // app.js POWER_SHORT
    'years', 'persons', // metric units
  ];
}

export async function allKeys() {
  const keys = [...codeKeys(`${WEB}app.js`), ...codeKeys(`${WEB}analysis.js`), ...pageKeys(), ...await dataKeys()];
  return [...new Set(keys)];
}
