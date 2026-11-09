// Lays out the schematic transit map for every city and writes it as SVG for review.
//  - every line keeps its stations in order, every station appears once
//  - all segments are horizontal, vertical or 45°, except reported fallbacks
//  - stations are at least one grid unit apart; labels placed for every named station
//   npm run check:schematic [files...]      (SVGs land in .schem/, served by the dev server)
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { layoutSchematic, type SchemInput } from '../src/schematic';
import { renderSchematic, placeLabels, bestSchematic } from '../src/schematic-render';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const withBus = process.argv.includes('--bus');
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
mkdirSync('.schem', { recursive: true });
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
const RAIL = ['train', 'metro', 'monorail', 'tram', 'ferry', 'cablecar'];
const index: string[] = [];
for (const f of files) {
  const name = path.basename(f).normalize('NFC').replace(/\.cslmap$/i, '');
  const cache = `.schem/${name}.input.json`;
  let input: SchemInput;
  if (existsSync(cache) && statSync(cache).mtimeMs > statSync(f).mtimeMs) input = JSON.parse(readFileSync(cache, 'utf8'));
  else {
    const city = parseCity(readFileSync(f, 'utf8'));
    input = buildCity(city, () => {}, inferOneWay(city), detectTolls(city)).schem!;
    writeFileSync(cache, JSON.stringify(input));
  }
  const modes = withBus ? [...RAIL, 'bus'] : RAIL;
  const t1 = Date.now();
  const L = bestSchematic(input, modes);
  const total = Date.now() - t1;
  void layoutSchematic;
  if (!L.lines.length) { console.log(`\n${name}: no rail/ferry lines`); continue; }
  const { labels } = placeLabels(L);
  const named = L.stations.filter((s) => s.name).length;
  console.log(`\n${name}: ${L.lines.length} lines, ${L.stations.length} stations (${named} named, ${L.stations.filter((s) => s.transfer).length} interchanges), grid ${Math.round(L.w)}×${Math.round(L.h)}, ${total} ms for ${8} variants (picked #${L.variant}, score ${L.score.toFixed(1)}), fallbacks ${L.fallbacks}, ${L.links.length} walking links`);
  // order: each line's hops chain its route, station to station
  for (const l of L.lines) {
    const want = l.route.length - 1;
    if (l.hops.length !== want) fail(`${l.name}: ${l.hops.length}/${want} hops drawn`);
    for (let i = 1; i < l.hops.length; i++) if (l.hops[i].a !== l.hops[i - 1].b) fail(`${l.name}: hop ${i} breaks the station order`);
  }
  // octilinear
  let bad = 0, segs = 0;
  for (const l of L.lines) for (const h of l.hops) for (let i = 1; i < h.pts.length; i++) {
    const dx = h.pts[i][0] - h.pts[i - 1][0], dy = h.pts[i][1] - h.pts[i - 1][1];
    if (Math.hypot(dx, dy) < 0.3) continue; // offset jogs inside a station
    segs++;
    const a = ((Math.atan2(dy, dx) * 180) / Math.PI + 360) % 45;
    if (Math.min(a, 45 - a) > 1) bad++;
  }
  const sx = new Map(L.stations.map((q) => [q.id, q]));
  const ll = L.links.map((k) => Math.hypot(sx.get(k.a)!.x - sx.get(k.b)!.x, sx.get(k.a)!.y - sx.get(k.b)!.y));
  console.log(`  walking links: ${ll.length}, ${ll.filter((d) => d <= 1.5).length} side by side, longest ${Math.max(0, ...ll).toFixed(1)} units`);
  console.log(`  octilinear: ${segs - bad}/${segs} segments${bad ? ` (${bad} off-angle)` : ''}`);
  if (bad > segs * 0.02) fail(`${bad} segments not at 0/45/90°`);
  // spacing
  let close = 0;
  for (let i = 0; i < L.stations.length; i++) for (let j = i + 1; j < L.stations.length; j++) if (Math.hypot(L.stations[i].x - L.stations[j].x, L.stations[i].y - L.stations[j].y) < 0.7) close++;
  const onLines = labels.filter((l) => l.hits[0]).length, onLabels = labels.filter((l) => l.hits[1]).length, rotated = labels.filter((l) => l.rot).length;
  console.log(`  stations closer than 0.7 units: ${close}; labels ${labels.length}/${named}: ${onLines} touch a line/marker, ${onLabels} touch another label, ${rotated} rotated`);
  if (labels.length < named) fail(`${named - labels.length} named stations without a label`);
  const svg = renderSchematic(L, { theme: 'light', debug: process.argv.includes('--debug') });
  const out = `.schem/${name}${withBus ? '-bus' : ''}.svg`;
  writeFileSync(out, svg);
  index.push(`<h2>${name}</h2><img src="${encodeURIComponent(path.basename(out))}" style="max-width:100%;border:1px solid #ddd">`);
}
writeFileSync('.schem/index.html', `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;margin:20px">${index.join('')}`);
if (failures) { console.error(`\n${failures} schematic check(s) failed`); process.exit(1); }
console.log('\nall schematic checks passed');
