// Plausibility of transit travel times (src/transit-time.ts) on real exports.
//  - per mode: operating speed (moving) and commercial speed (incl. stops) vs real-world ranges
//  - buses: in-vehicle time vs a car between the same two stops
//  - door to door: transit vs driving for random trips
//   npm run check:transit [files...]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { inferOneWay } from '../src/oneway';
import { Router } from '../src/router';
import { modeParams } from '../src/transit-time';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
// real-world commercial speed ranges (km/h, incl. stops) for a whole line
const RANGE: Record<string, [number, number]> = { bus: [10, 55], // express highway buses reach ~50
  tram: [10, 30], metro: [22, 55], train: [30, 100], monorail: [18, 50], ferry: [8, 30], cablecar: [6, 22] };
// typical stop spacing (m) behind those ranges
const TYPICAL_SPACING: Record<string, number> = { bus: 400, tram: 500, metro: 1000, train: 2000, monorail: 800, ferry: 1500, cablecar: 800 };
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const pct = (a: number[], q: number) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN; };
let failures = 0;
const fail = (msg: string) => { failures++; console.error('  ✗ ' + msg); };

for (const f of files) {
  const city = parseCity(readFileSync(f, 'utf8'));
  const ow = inferOneWay(city);
  const r: any = new Router(city, buildCity(city, () => {}, ow).stopNames!, ow);
  console.log(`\n${path.basename(f)}`);
  const byMode = new Map<string, { op: number[]; com: number[]; spacing: number[] }>();
  const busRatio: number[] = [];
  for (const l of r.lines as any[]) {
    if (!RANGE[l.mode]) continue;
    const L = l.hops.reduce((a: number, h: any) => a + h.len, 0), T = l.hops.reduce((a: number, h: any) => a + h.time, 0);
    if (L < 300) continue;
    const m = byMode.get(l.mode) ?? { op: [], com: [], spacing: [] } as any; byMode.set(l.mode, m);
    m.spacing.push(L / l.hops.length);
    m.op.push((L / T) * 3.6);
    m.com.push((L / (T + modeParams(l.mode).dwell * l.hops.length)) * 3.6);
    if (l.mode === 'bus') l.hops.forEach((h: any, k: number) => {
      const a = city.nodes.get(l.stops[k]), b = city.nodes.get(l.stops[(k + 1) % l.stops.length]);
      if (!a || !b || h.len < 200) return;
      const d = r.driveRoute([a.x, a.z], [b.x, b.z], new Map());
      if (d && d.time > 20) busRatio.push(h.time / d.time);
    });
  }
  for (const [mode, m] of byMode) {
    // commercial speed scales with stop spacing; below a mode's typical spacing the floor drops in proportion
    const sp = median(m.spacing), [lo0, hi] = RANGE[mode], lo = Math.round(lo0 * Math.min(1, sp / TYPICAL_SPACING[mode])), com = median(m.com);
    console.log(`  ${mode.padEnd(8)} lines ${String(m.op.length).padStart(3)}  stop spacing ${String(Math.round(sp)).padStart(4)} m  operating ${median(m.op).toFixed(0).padStart(3)} km/h  commercial ${com.toFixed(0).padStart(3)} km/h (lines ${pct(m.com, 0).toFixed(0)}–${pct(m.com, 0.999).toFixed(0)}; plausible ${lo}–${hi})`);
    if (!(com >= lo && com <= hi)) fail(`${mode} commercial speed ${com.toFixed(0)} km/h outside ${lo}–${hi}`);
  }
  if (busRatio.length) {
    const md = median(busRatio);
    console.log(`  bus in-vehicle vs car, same stop pair: median ${md.toFixed(2)}× (p10 ${pct(busRatio, 0.1).toFixed(2)}, p90 ${pct(busRatio, 0.9).toFixed(2)}) over ${busRatio.length} hops`);
    if (!(md >= 1.1 && md <= 2.0)) fail(`bus vs car ratio ${md.toFixed(2)} outside 1.1–2.0`);
  }
  // door to door
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // trips transit actually serves: both ends within 400 m of a stop
  const stops = (r.lines as any[]).flatMap((l) => l.stops.map((id: number) => city.nodes.get(id)).filter(Boolean));
  const nearStop = (p: number[]) => stops.some((q: any) => Math.hypot(q.x - p[0], q.z - p[1]) < 400);
  const pts = [...city.nodes.values()].filter((n) => n.srv === 'Road').map((n) => [n.x, n.z]).filter(nearStop);
  const ratio: number[] = [], waitShare: number[] = [];
  for (let i = 0; i < 300 && pts.length; i++) {
    const a = pts[Math.floor(rnd() * pts.length)], b = pts[Math.floor(rnd() * pts.length)];
    if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 1500) continue;
    const t = r.route(a, b, 'transit')[0], d = r.route(a, b, 'drive')[0];
    if (!t || !d) continue;
    ratio.push(t.time / d.time);
    waitShare.push(t.legs.reduce((s: number, l: any) => s + (l.wait ?? 0), 0) / t.time);
  }
  if (ratio.length) {
    const md = median(ratio);
    console.log(`  door to door, served trips (both ends ≤400 m from a stop, ≥1.5 km, ${ratio.length} trips): transit/drive median ${md.toFixed(2)}× (p10 ${pct(ratio, 0.1).toFixed(2)}, p90 ${pct(ratio, 0.9).toFixed(2)}); estimated waiting = ${(median(waitShare) * 100).toFixed(0)}% of transit time`);
    const hi = (r.lines as any[]).length < 6 ? 5 : 3.5; // sparse networks (few lines) need more walking and transfers
    if (!(md >= 1.2 && md <= hi)) fail(`door-to-door ratio ${md.toFixed(2)} outside 1.2–${hi}`);
  }
}
if (failures) { console.error(`\n${failures} plausibility check(s) failed`); process.exit(1); }
console.log('\nall transit plausibility checks passed');
