// Lane-based access rules (src/access.ts) against every network type in the exports.
// Prints the access table and fails if a known case is decided wrongly.
//   npm run check:access [files...]   (default: every export in CSLMAP_DIR)
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { laneAccess, type Access } from '../src/access';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
const files = process.argv.slice(2).length ? process.argv.slice(2) : existsSync(dir) ? readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).map((f) => path.join(dir, f)) : [];
if (!files.length) { console.log('no exports found; pass files as arguments'); process.exit(0); }

const table = new Map<string, { n: number; a: Access }>();
for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  for (const s of city.segs) {
    if (s.path) continue;
    const t = table.get(s.name);
    if (t) { t.n++; continue; }
    table.set(s.name, { n: 1, a: laneAccess(s, city.segTypes.get(s.name)) });
  }
}

// [type, walk, drive, bike-able (ride or push)]
const EXPECT: [string, boolean, boolean, boolean][] = [
  ['Basic Road', true, true, true], ['Highway', false, true, false], ['HighwayRamp', false, true, false], ['Two Lane Highway', false, true, false],
  ['Pedestrian Pavement', true, false, true], ['Pedestrian Gravel', true, false, true], ['Pedestrian Tunnel', true, false, true], ['Pedestrian Elevated', true, false, true],
  ['Small Busway', true, false, true], ['Bus Station Way', false, false, false], ['Bus Station Stop', true, false, true], ['CableCar Path', false, false, false],
  ['Zonable Promenade', true, false, true], ['Zonable Pedestrian Boardwalk Tiny', true, false, true],
  ['Medium Road Monorail', true, true, true], ['Small Road Monorail', true, true, true], ['1174471092.Damaged Road_Data', true, true, true],
  ['Metro Station Track Tunnel', false, false, false], ['Train Station Track', false, false, false], ['CableCar Stop', false, false, false],
  ['Airport Area Taxiway', false, false, false], ['DLC Small Airplane Stop', false, false, false], ['Ship Dock', false, false, false],
  ['1498212506.R69 Racetrack_Data', false, false, false], ['Medium Road Bicycle', true, true, true], ['Pedestrian Pavement Bicycle', false, false, true],
  ['Train Track', false, false, false], ['Gravel Road', true, true, true], ['Basic Road Tunnel', true, true, true],
];
let bad = 0, checked = 0;
for (const [name, w, d, b] of EXPECT) {
  const t = table.get(name);
  if (!t) continue;
  checked++;
  const got = [t.a.walk, t.a.drive, t.a.bike || t.a.bikeWalk];
  if (got[0] !== w || got[1] !== d || got[2] !== b) { bad++; console.error(`✗ ${name}: walk ${got[0]} drive ${got[1]} bike ${got[2]} — expected ${w}/${d}/${b}`); }
}
const yes = (v: boolean) => (v ? '✓' : '·');
console.log('type'.padEnd(46) + 'segs  walk drive bike  note');
for (const [name, { n, a }] of [...table].filter(([, t]) => t.a.walk || t.a.drive || t.a.bike || t.a.bikeWalk || t.a.reason).sort((x, y) => y[1].n - x[1].n))
  console.log(name.slice(0, 45).padEnd(46) + String(n).padStart(5) + `   ${yes(a.walk)}    ${yes(a.drive)}    ${a.bike ? '✓' : a.bikeWalk ? 'push' : '·'}   ${a.reason ?? ''}`);
console.log(`\nexpectations: ${checked - bad}/${checked} hold`);
if (bad) process.exit(1);
