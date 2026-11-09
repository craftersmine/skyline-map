// City Discoveries: run the finder on the newest export of every city and print each record, then check
// basic sanity (finite values, geometry inside the map, a frame to fly to, no duplicate ids).
//   npm run check:discover [files...]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { discover } from '../src/discover';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  const built = buildCity(city, undefined, inferOneWay(city), detectTolls(city));
  const t0 = performance.now();
  const r = discover(city, built);
  const ms = performance.now() - t0;
  console.log(`\n${path.basename(f).normalize('NFC')}: ${r.items.length} discoveries in ${ms.toFixed(0)} ms`, JSON.stringify(r.summary));
  const ids = new Set<string>();
  for (const d of r.items) {
    const note = d.note.replace(/\{(\w+)\}/g, (_, k) => d.params[k] ?? `{${k}?}`);
    console.log(`  [${d.cat}] ${d.title}: ${d.value} ${d.unit} — ${d.subject}${d.place ? " (near " + d.place + ")" : ""} | ${note}`);
    if (ids.has(d.id)) fail(`duplicate id ${d.id}`); ids.add(d.id);
    if (/\{\w+\?\}/.test(note)) fail(`${d.id}: missing param in note`);
    if (!d.bbox.every(Number.isFinite) || d.bbox[0] > d.bbox[2] || d.bbox[1] > d.bbox[3]) fail(`${d.id}: bad bbox`);
    if (!/^[\d.,]+$/.test(d.value)) fail(`${d.id}: value "${d.value}" is not a number`);
    if (d.id !== 'water-share' && !d.geom.length) fail(`${d.id}: nothing to highlight`);
  }
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('\ndiscover checks passed');
