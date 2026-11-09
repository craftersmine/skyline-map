// City time-lapse: scan every older export of a city against its newest one and check the first-seen times.
// Every time must lie between the oldest scanned export and the open one, more things must exist at each later
// export than at earlier ones, and a city that grew must show growth (some roads newer than the oldest save).
//   npm run check:history [city name prefix]   (default: the city with the most saves)
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { cityKeys, scanExport, bornById, exportTime } from '../src/history';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
if (!existsSync(dir)) { console.log('no export folder; skipped'); process.exit(0); }
const all = readdirSync(dir).filter((f) => /-\d{8}-\d{6}\.cslmap$/i.test(f)).map((f) => f.normalize('NFC'));
const byCity = new Map<string, string[]>();
for (const f of all) { const c = f.replace(/-\d{8}-\d{6}\.cslmap$/i, ''); byCity.set(c, [...(byCity.get(c) ?? []), f]); }
const want = process.argv[2]?.normalize('NFC');
const [cityName, files] = [...byCity].filter(([c]) => !want || c.startsWith(want)).sort((a, b) => b[1].length - a[1].length)[0] ?? [];
if (!files || files.length < 2) { console.log('need at least two timestamped exports of one city; skipped'); process.exit(0); }
const real = (f: string) => readdirSync(dir).find((x) => x.normalize('NFC') === f)!;
files.sort((a, b) => statSync(path.join(dir, real(a))).mtimeMs - statSync(path.join(dir, real(b))).mtimeMs);

const newest = files[files.length - 1];
const city = parseCity(readFileSync(path.join(dir, real(newest)), 'utf8'));
const t1 = exportTime(city.generated);
const keys = cityKeys(city, t1);
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
const t0 = performance.now();
const times: number[] = [];
for (const f of files.slice(0, -1)) {
  const r = scanExport(readFileSync(path.join(dir, real(f)), 'utf8'), keys);
  if (r.name !== city.name) fail(`${f}: city "${r.name}" is not "${city.name}"`);
  if (Number.isFinite(r.time)) times.push(r.time);
}
const ms = (performance.now() - t0) / (files.length - 1);
const born = bornById(city, keys);
const lo = Math.min(...times, t1);
console.log(`${cityName}: ${files.length} exports, ${ms.toFixed(0)} ms per scanned export`);
for (const [kind, list] of Object.entries(born) as [string, [number, number][]][]) {
  const bad = list.filter(([, t]) => !(t >= lo && t <= t1)).length;
  if (bad) fail(`${kind}: ${bad} first-seen times outside the scanned range`);
  // counts at each export time never shrink (first-seen times only accumulate)
  const counts = [...times, t1].sort((a, b) => a - b).map((t) => list.filter(([, b]) => b <= t).length);
  for (let i = 1; i < counts.length; i++) if (counts[i] < counts[i - 1]) fail(`${kind}: count drops between exports`);
  const old = list.filter(([, t]) => t === lo).length;
  console.log(`  ${kind.padEnd(5)} ${list.length} now, ${old} already in the oldest export (${((100 * old) / Math.max(1, list.length)).toFixed(0)}%)`);
}
if (born.seg.every(([, t]) => t === lo)) fail('no road is newer than the oldest export: matching is broken or the city never changed');
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('history checks passed');
