// Every translatable string must have a Korean entry. Run: npm run check:i18n
// Keys come from t('…') / tn(n, '…', '…') calls, data-i18n* attributes in index.html,
// and quoted strings between `// i18n-keys` and `// end i18n-keys` markers.
import { readFileSync, readdirSync } from 'node:fs';
import { KO } from '../src/i18n-ko.ts';
import { demo } from '../src/i18n.ts';

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

const missing = [...keys].filter(([k]) => !(k in KO));
const unused = Object.keys(KO).filter((k) => !keys.has(k));
if (unused.length) console.log(`${unused.length} Korean entries no longer used:\n  ` + unused.join('\n  '));
if (missing.length) {
  console.error(`${missing.length} strings have no Korean translation:`);
  for (const [k, w] of missing) console.error(`  ${JSON.stringify(k)}  (${w})`);
  process.exit(1);
}
console.log(demo());
console.log(`i18n: ${keys.size} strings, all translated`);
