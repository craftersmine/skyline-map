// "How far can I get": reach times must agree with Directions. For random starts and targets in each city, the
// time to the target's nearest node (plus walking the last metres) should be close to the time of the best
// route Directions finds, for walking, cycling, driving and transit. Also times the search.
//   npm run check:reach [files...] [--n=30]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { Router, type Mode } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { reachGrid, REACH_CELL } from '../src/reach';
import { HALF, type XY } from '../src/geo';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = +(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 30);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
let failures = 0;

for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  const oneway = inferOneWay(city), tolls = detectTolls(city);
  const built = buildCity(city, undefined, oneway, tolls);
  const router = new Router(city, built.stopNames ?? new Map(), oneway, tolls);
  const pos = router.nodePositions();
  console.log(path.basename(f).normalize('NFC'));
  for (const mode of ['walk', 'bike', 'drive', 'transit'] as Mode[]) {
    const ratios: number[] = []; let ms = 0, far = 0;
    for (let k = 0; k < N; k++) {
      const a = pos[Math.floor(rnd() * pos.length)], b = pos[Math.floor(rnd() * pos.length)];
      const from: XY = [a[0] + 20, a[1] + 20], to: XY = [b[0] + 20, b[1] + 20];
      const t0 = performance.now();
      const times = router.reachTimes(from, mode, 3 * 3600);
      const grid = reachGrid(pos, times, 3600);
      ms += performance.now() - t0;
      // grid sanity: the start cell is reached almost at once
      // (only when a reached node is close: a start on rail track may be far from any path)
      const near = pos.some((q, i) => Number.isFinite(times[i]) && Math.hypot(q[0] - from[0], q[1] - from[1]) < 150);
      if (grid && near) {
        const i = Math.floor((from[0] + HALF) / REACH_CELL) - grid.x0, j = Math.floor((from[1] + HALF) / REACH_CELL) - grid.z0;
        const t = i >= 0 && j >= 0 && i < grid.w && j < grid.h ? grid.t[j * grid.w + i] : Infinity;
        if (mode !== 'drive' && t > 600) { failures++; console.error(`  ✗ ${mode}: start cell reached only after ${Math.round(t)} s`); }
      }
      const r = router.route(from, to, mode)[0];
      if (!r) continue;
      // reach to the target: best node near it plus the walk
      let best = Infinity;
      for (let i = 0; i < pos.length; i++) {
        const d = Math.hypot(pos[i][0] - to[0], pos[i][1] - to[1]);
        if (d < 120) best = Math.min(best, times[i] + d / 1.35);
      }
      if (!Number.isFinite(best) || r.time < 120) continue;
      const q = best / r.time;
      ratios.push(q); if (Math.abs(Math.log(q)) > Math.log(2)) far++;
    }
    ratios.sort((x, y) => x - y);
    const med = ratios[ratios.length >> 1] ?? NaN;
    console.log(`  ${mode.padEnd(8)} ${ratios.length} trips  reach/route median ${med.toFixed(2)}  range ${ratios[0]?.toFixed(2)}–${ratios.at(-1)?.toFixed(2)}  ${(ms / N).toFixed(0)} ms per search`);
    // reach may be a bit faster (it skips Directions' detour penalties) but never wildly off
    if (ratios.length >= 5 && !(med > 0.8 && med < 1.1)) { failures++; console.error(`  ✗ ${mode}: median ratio ${med.toFixed(2)} outside 0.8–1.1`); }
    // a few trips differ more: Directions may add a long walk to an ordinary road that the reach map, which
    // counts "drive near, then walk", doesn't
    if (far > Math.max(1, ratios.length * 0.1)) { failures++; console.error(`  ✗ ${mode}: ${far} of ${ratios.length} trips differ by more than 2×`); }
  }
}
if (failures) { console.error(`${failures} failure(s)`); process.exit(1); }
console.log('reach checks passed');
