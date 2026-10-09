// The interface in English (the source text in the code), German, French and Italian.
//
// Strings are looked up by their English text, so the code stays readable: t('Colour by') gives
// "Einfärben nach" in German. {name} marks a value filled in at run time: t('Within {dist}', { dist }).
// A missing translation falls back to English; tests/i18n.test.mjs checks that none is missing.
//
// The language comes from a link (#…&l=fr), else the visitor's last choice, else the browser's
// languages, else English. Switching reloads the page, which keeps the view (it is in the URL).
// index.html picks the same language early, to hide the English page text until it is translated.

export const LANGS = { en: 'English', de: 'Deutsch', fr: 'Français', it: 'Italiano' };
// Not Object.hasOwn: browsers too old for it must still reach app.js's "browser too old" message.
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function pick() {
  if (!globalThis.document) return 'en'; // tests in node: whatever the shell's locale
  const linked = /(?:^#|&)l=([a-z]{2})(?:&|$)/.exec(location.hash)?.[1];
  if (own(LANGS, linked ?? '')) return linked;
  let saved = null;
  try { saved = localStorage.getItem('spg-lang'); } catch { /* storage blocked */ }
  if (own(LANGS, saved ?? '')) return saved;
  for (const l of navigator.languages ?? []) {
    const code = l.slice(0, 2).toLowerCase();
    if (own(LANGS, code)) return code;
  }
  return 'en';
}
export const lang = pick();
export const locale = `${lang}-CH`; // Swiss number and date formats: 138’141 (de, it, en), 138 141,5 (fr)
// Only the dictionary in use is loaded (index.html preloads it); should it fail, the page stays in English.
let shown = lang; // the language the text is in: English when the dictionary could not be loaded
const strings = lang === 'en' ? {} : await import(`./i18n/${lang}.js`).then((m) => m.default, (e) => {
  console.error(e);
  shown = 'en';
  return {};
});

/** The text for an English key in the current language, with {name} placeholders filled from vars. */
export function t(key, vars) {
  let s = own(strings, key) ? strings[key] : key;
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (own(vars, k) ? vars[k] : m));
  return s;
}
// Singular or plural by the language's rules (French counts 0 as singular); {n} is the formatted count.
const plurals = new Intl.PluralRules(locale);
export const tp = (n, one, other, vars) => t(isOne(n) ? one : other, { n: fmtInt(n), ...vars });
const pluralsFixed = new Map();
/**
 * Whether n takes the singular: 1 in English, German and Italian; also 0 and 1.8 in French. With
 * decimals, as shown with that many digits: "1.00" is plural in English ("1.00 persons").
 */
export function isOne(n, decimals = 0) {
  let p = decimals ? pluralsFixed.get(decimals) : plurals;
  if (!p) pluralsFixed.set(decimals, (p = new Intl.PluralRules(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals })));
  return p.select(n) === 'one';
}

const intFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
export const fmtInt = (v) => intFmt.format(v);
const fixedFmts = new Map();
/** Like v.toFixed(d), in the language's notation (decimal comma in French, digit grouping). */
export function fmtFixed(v, d) {
  let f = fixedFmts.get(d);
  if (!f) fixedFmts.set(d, (f = new Intl.NumberFormat(locale, { minimumFractionDigits: d, maximumFractionDigits: d })));
  return f.format(v);
}
/** Up to d decimals, trailing zeros dropped (class breaks such as 12.5 or 4). */
export const fmtNum = (v, d = 2) => new Intl.NumberFormat(locale, { maximumFractionDigits: d }).format(v);
const pctFmts = new Map();
/** A share (0..1) as a percentage with d decimals: 26%, 1.5%, 26,4% in French. */
export function fmtPct(x, d = 0) {
  let f = pctFmts.get(d);
  if (!f) pctFmts.set(d, (f = new Intl.NumberFormat(locale, { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d })));
  return f.format(x);
}
const dateFmt = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
/** An ISO date (2024-12-31) as 31 Dec 2024, 31. Dez. 2024, 31 déc. 2024, 31 dic 2024 (an invalid one as is). */
export function fmtDate(iso) {
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? String(iso) : dateFmt.format(d);
}

// Pages of the data sources in the reader's language.
export const LINKS = {
  fso: {
    en: 'https://www.bfs.admin.ch/bfs/en/home/statistics/catalogues-databases.assetdetail.36171301.html',
    de: 'https://www.bfs.admin.ch/bfs/de/home/statistiken/kataloge-datenbanken.assetdetail.36171301.html',
    fr: 'https://www.bfs.admin.ch/bfs/fr/home/statistiques/catalogues-banques-donnees.assetdetail.36171301.html',
    it: 'https://www.bfs.admin.ch/bfs/it/home/statistiche/cataloghi-banche-dati.assetdetail.36171301.html',
  }[lang],
  ofcom: `https://www.geocat.ch/geonetwork/srv/${{ en: 'eng', de: 'ger', fr: 'fre', it: 'ita' }[lang]}/catalog.search#/metadata/6a972f46-ae47-4db9-b5a7-dcfd3598bd95`,
  swisstopo: `https://www.swisstopo.admin.ch/${lang}`,
};

/**
 * Translate the static page: [data-i18n] elements get their text translated (the English text is the
 * key), [data-i18n-attr="aria-label title …"] the named attributes; [data-href] links point to LINKS;
 * [data-date] holds an ISO date to show in the language's format.
 */
export function translatePage(root = document) {
  document.documentElement.lang = shown; // for screen readers and hyphenation
  for (const a of root.querySelectorAll('[data-href]')) a.href = LINKS[a.dataset.href];
  for (const e of root.querySelectorAll('[data-date]')) e.textContent = fmtDate(e.dataset.date);
  if (lang !== 'en') {
    for (const e of root.querySelectorAll('[data-i18n]')) e.textContent = t(e.textContent.trim().replace(/\s+/g, ' '));
    for (const e of root.querySelectorAll('[data-i18n-attr]')) {
      for (const name of e.dataset.i18nAttr.split(' ')) if (e.hasAttribute(name)) e.setAttribute(name, t(e.getAttribute(name)));
    }
  }
  document.documentElement.classList.remove('i18n-pending');
}

/** Switch language: remembered for the next visits; the page reloads in it, with the same view. */
export function setLang(code) {
  let stored = true;
  try { localStorage.setItem('spg-lang', code); } catch { stored = false; }
  const linked = /(?:^#|&)l=[a-z]{2}(?=&|$)/;
  let hash = location.hash;
  if (linked.test(hash)) hash = hash.replace(/((?:^#|&)l=)[a-z]{2}/, `$1${code}`);
  else if (!stored) hash = `${hash || '#'}${hash.length > 1 ? '&' : ''}l=${code}`; // no storage: the URL carries it
  history.replaceState(history.state, '', `${location.pathname}${location.search}${hash}`); // no hashchange event
  location.reload();
}
