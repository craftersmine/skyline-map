// Every translatable string must have an entry in every language table, with the same {placeholders}.
// Also checks language picking and locale formatting. Run: npm run check:i18n
// Keys come from t('…') / tn(n, '…', '…') calls, data-i18n* attributes in index.html,
// and quoted strings between `// i18n-keys` and `// end i18n-keys` markers.
import { readFileSync, readdirSync } from 'node:fs';
import { demo, DICTS, setLang, locale, fmtFixed, t } from '../src/i18n.ts';
import { LANGS, pickLang, localeOf } from '../src/lang.ts';

const keys = new Map<string, string>();
const add = (k: string, where: string) => { if (k && !keys.has(k)) keys.set(k, where); };
const unq = (s: string) => s.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
const STR = String.raw`'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|\`(?:[^\`\\$]|\\.)*\``;
for (const f of readdirSync('src').filter((f) => f.endsWith('.ts') && !f.startsWith('i18n'))) {
  const src = readFileSync('src/' + f, 'utf8');
  for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*(${STR})`, 'g'))) add(unq(m[1]), f);
  for (const m of src.matchAll(new RegExp(String.raw`\brow\(\s*(${STR})`, 'g'))) add(unq(m[1]), f);
  for (const m of src.matchAll(new RegExp(String.raw`\btn\([^,]+,\s*(${STR})\s*,\s*(${STR})`, 'g'))) { add(unq(m[1]), f); add(unq(m[2]), f); }
  for (const m of src.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"$]+)"/g)) add(m[1], f);
  for (const m of src.matchAll(new RegExp(String.raw`\bbig\([^,]+,\s*(${STR})\s*,\s*(${STR})`, 'g'))) { add(unq(m[1]), f); add(unq(m[2]), f); }
  for (const b of src.matchAll(/\/\/ i18n-keys([\s\S]*?)\/\/ end i18n-keys/g)) for (const m of b[1].matchAll(new RegExp(STR, 'g'))) add(unq(m[0]), f + ' (key list)');
}
const html = readFileSync('index.html', 'utf8');
for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-aria)?="([^"]+)"/g)) add(m[1].replace(/&amp;/g, '&'), 'index.html');

const names = (s: string) => [...s.matchAll(/\{(\w+)(?:\|\w+)?\}/g)].map((m) => m[1]).sort().join(',');
let failed = false;
for (const { id, name } of LANGS) {
  if (id === 'en') continue;
  const dict = DICTS[id];
  const missing = [...keys].filter(([k]) => !(k in dict));
  const unused = Object.keys(dict).filter((k) => !keys.has(k));
  const badVars = Object.entries(dict).filter(([k, v]) => keys.has(k) && names(k) !== names(v));
  if (unused.length) console.log(`${name}: ${unused.length} entries no longer used:\n  ` + unused.join('\n  '));
  if (missing.length) {
    failed = true;
    console.error(`${name}: ${missing.length} strings have no translation:`);
    for (const [k, w] of missing) console.error(`  ${JSON.stringify(k)}  (${w})`);
  }
  if (badVars.length) {
    failed = true;
    console.error(`${name}: ${badVars.length} translations change the {placeholders}:`);
    for (const [k, v] of badVars) console.error(`  ${JSON.stringify(k)} → ${JSON.stringify(v)}`);
  }
}

// language picking: saved choice wins, then the browser's languages in order, then English
const eq = (got: unknown, want: unknown, what: string) => { if (got !== want) { failed = true; console.error(`${what}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); } };
eq(pickLang('ru', ['en-US']), 'ru', 'saved ru');
eq(pickLang('ko', []), 'ko', 'saved ko');
eq(pickLang(null, ['ru-RU', 'en']), 'ru', 'browser ru-RU');
eq(pickLang(null, ['fr-FR', 'ko-KR']), 'ko', 'second browser language');
eq(pickLang('xx', ['de']), 'en', 'unknown saved and browser');
eq(pickLang(null, []), 'en', 'nothing known');
// locale formatting per language; English and Korean keep their earlier output
for (const { id } of LANGS) { setLang(id, false); eq(locale(), localeOf(id), `locale ${id}`); }
const fmt: Record<string, [string, string]> = { en: ['2.50', '12,345'], ko: ['2.50', '12,345'], ru: ['2,50', '12 345'] };
for (const { id } of LANGS) {
  setLang(id, false);
  const [dec, big] = fmt[id] ?? fmt.en;
  eq(fmtFixed(2.5, 2), dec, `fmtFixed ${id}`);
  eq(t('{n}', { n: 12345 }), big, `number in t() ${id}`);
}
eq(fmtFixed(12345.6, 1).includes('12345'), true, 'fmtFixed has no thousands separator');
setLang('en', false);

if (failed) process.exit(1);
console.log(demo());
console.log(`i18n: ${keys.size} strings, translated in ${LANGS.filter((l) => l.id !== 'en').map((l) => l.name).join(', ')}`);
