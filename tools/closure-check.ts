// Network criticality: close real pieces of every city (its longest bridge, busiest interchange, a stretch of
// railway, random streets) and check the before/after trips make sense: a closure never makes a trip faster,
// a trip that's still possible stays possible only by routes avoiding the closure, verdicts follow the numbers.
//   npm run check:closure [files...]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { Router } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { discover } from '../src/discover';
import { createClosures, segInfoFrom, type ClosurePick } from '../src/closure';
import { fromLngLat } from '../src/geo';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
let failures = 0, seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const fail = (m: string) => { failures++; console.error('    ✗ ' + m); };
const m = (s: number | null) => (s === null ? '—' : (s / 60).toFixed(1) + 'm');
for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  const oneway = inferOneWay(city), tolls = detectTolls(city);
  const built = buildCity(city, undefined, oneway, tolls);
  const router = new Router(city, built.stopNames ?? new Map(), oneway, tolls);
  const info = segInfoFrom(built);
  const cl = createClosures(city, router, info, built.stopNames ?? new Map());
  const disc = discover(city, built);
  console.log('\n' + path.basename(f).normalize('NFC'));
  const picks: [string, ClosurePick][] = [];
  // the city's longest bridge and road tunnel: pick a segment under their highlighted line
  for (const id of ['bridge', 'viaduct', 'tunnel-road', 'tunnel-rail']) {
    const d = disc.items.find((x) => x.id === id); if (!d) continue;
    const c = (d.geom[0].geometry.coordinates as [number, number][]); const q = fromLngLat(...c[c.length >> 1]);
    let best = -1, bd = 30;
    for (const s of city.segs) { if (!info.has(s.id) || !info.get(s.id)!.brunnel) continue; for (const p of s.pts) { const dd = Math.hypot(p.x - q[0], p.z - q[1]); if (dd < bd) { bd = dd; best = s.id; } } }
    if (best >= 0) picks.push([id, { kind: info.get(best)!.group, seg: best }]);
  }
  const st = built.sources.places.features.filter((x) => x.properties.kind === 'station' && x.properties.name).sort((a, b) => Number(b.properties.nlines) - Number(a.properties.nlines))[0];
  if (st) picks.push(['station ' + st.properties.name, { kind: 'station', name: String(st.properties.name), at: fromLngLat(...((st.geometry as any).coordinates as [number, number])) }]);
  const rails = [...info].filter(([, i]) => i.group === 'rail' && i.brunnel === '' && i.cls === 'rail');
  if (rails.length) picks.push(['rail', { kind: 'rail', seg: rails[Math.floor(rnd() * rails.length)][0] }]);
  const roads = [...info].filter(([id, i]) => i.group === 'road' && router.edgeAccess(id)?.drive);
  for (let k = 0; k < 4; k++) picks.push(['road', { kind: 'road', seg: roads[Math.floor(rnd() * roads.length)][0] }]);
  const named = roads.filter(([, i]) => i.name);
  if (named.length) picks.push(['whole road', { kind: 'road', seg: named[Math.floor(rnd() * named.length)][0], scope: 'road' }]);
  for (const [label, p] of picks) {
    const t0 = performance.now();
    const r = cl.analyze(p);
    const ms = performance.now() - t0;
    if (!r) { console.log(`  ${label}: nothing to close`); continue; }
    console.log(`  ${label}: ${r.what} "${r.title}" ${Math.round(r.len)} m, ${r.parts} part(s) → ${r.verdict}  [${ms.toFixed(0)} ms]`);
    for (const t of r.trips) {
      console.log(`     ${t.mode.padEnd(7)} ${(t.dir || `${t.line?.name}: ${t.from} → ${t.to}`).slice(0, 60).padEnd(60)} ${m(t.before)} → ${m(t.after)}${t.how ? ' ' + t.how : ''}`);
      if (t.before !== null && t.after !== null && t.after < t.before - 1) fail(`${label}: closing made a trip faster (${m(t.before)} → ${m(t.after)})`);
    }
    if (r.skipped.length) console.log(`     skips: ${r.skipped.map((x) => x.name).join(', ')}`);
    if (r.nearest) console.log(`     nearest open stop: ${r.nearest.before?.label} ${m(r.nearest.before?.time ?? null)} → ${r.nearest.after?.label} ${m(r.nearest.after?.time ?? null)}`);
    if (r.stranded.drive || r.stranded.walk) console.log(`     cut off: ${Math.round(r.stranded.drive)} m by car, ${Math.round(r.stranded.walk)} m on foot`);
    if (r.verdict !== 'cut' && r.trips.some((t) => t.before !== null && t.after === null)) fail(`${label}: a trip became impossible but verdict is ${r.verdict}`);
    if (!r.closed.length && !r.stops.length) fail(`${label}: empty closure`);
    if (ms > 8000) fail(`${label}: too slow (${ms.toFixed(0)} ms)`);
    // reach before/after: never better after
    const rr = cl.reach(p, fromLngLat(...r.pin), r.mode === 'transit' ? 'transit' : 'drive', 1800);
    if (rr) { let better = 0; for (let i = 0; i < rr.before.length; i++) if (rr.after[i] < rr.before[i] - 30) better++; if (better) /* start snapping can shift a few seconds */ fail(`${label}: ${better} nodes reached faster after closing`); }
  }
}
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log('\nclosure checks passed');
