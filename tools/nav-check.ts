// Navigation simulation: for random driving trips, the drive plan follows the route exactly.
//  - every maneuver sits on the line, in order, within a few metres of its step's point
//  - the profile is continuous: distance only grows with time, speed stays under each road's own speed
//  - stateAt and timeAt agree, and the plan's time is the route's time
//   npm run check:nav [files...] [--n=60]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { Router } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { fromLngLat } from '../src/geo';
import { buildPlan, stateAt, timeAt, pointAt, spanAt } from '../src/nav';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = +(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 60);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
let failures = 0;
const fail = (m: string) => { failures++; if (failures < 40) console.error('  ✗ ' + m); };
let seed = 11;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

for (const f of files) {
  const name = path.basename(f).normalize('NFC');
  const city = parseCity(readFileSync(f, 'utf8'));
  const ow = inferOneWay(city), tl = detectTolls(city);
  const built = buildCity(city, () => {}, ow, tl);
  const router = new Router(city, built.stopNames ?? new Map(), ow, tl);
  const nodes = [...city.nodes.values()].filter((n) => !n.ug && n.srv === 'Road');
  const ks: number[] = [];
  let trips = 0, mans = 0, maxOff = 0, named = 0, len = 0, limited = 0, brunnels = 0;
  for (let i = 0; i < N * 3 && trips < N; i++) {
    const a = nodes[Math.floor(rnd() * nodes.length)], b = nodes[Math.floor(rnd() * nodes.length)];
    if (Math.hypot(a.x - b.x, a.z - b.z) < 800) continue;
    const r = router.route([a.x, a.z], [b.x, b.z], 'drive', {})[0];
    if (!r) continue;
    const p = buildPlan(r);
    if (!p) { fail(`${name} trip ${i}: no plan for a drive route`); continue; }
    trips++; ks.push(p.k); len += p.total;
    const tag = `${name} trip ${i}`;
    if (!r.legs[0].spans?.length) fail(`${tag}: driving leg has no spans`);
    // spans cover the line in order
    for (let k = 1; k < p.spans.length; k++) if (p.spans[k].s0 < p.spans[k - 1].s0 - 1e-6) fail(`${tag}: spans out of order`);
    for (const sp of p.spans) { if (sp.name) named += sp.s1 - sp.s0; if (sp.limit) limited += sp.s1 - sp.s0; if (sp.brunnel) brunnels++; }
    // maneuvers: in order, on the line near their step point
    let prev = -1;
    const steps = r.legs[0].steps.filter((s, k) => k > 0 && s.maneuver !== 'depart');
    if (p.maneuvers.length !== steps.length + (steps.at(-1)?.maneuver === 'arrive' ? 0 : 1)) fail(`${tag}: ${p.maneuvers.length} maneuvers for ${steps.length} steps`);
    p.maneuvers.forEach((m, k) => {
      if (m.at < prev - 1e-6) fail(`${tag}: maneuver ${k} (${m.man}) at ${m.at.toFixed(1)} before ${prev.toFixed(1)}`);
      prev = m.at;
      const st = steps[k];
      if (!st || st.maneuver === 'arrive') return;
      const q = fromLngLat(st.at[0], st.at[1]), on = pointAt(p, m.at).xy, d = Math.hypot(q[0] - on[0], q[1] - on[1]);
      maxOff = Math.max(maxOff, d); mans++;
      if (d > 3) fail(`${tag}: maneuver ${k} (${m.man}) placed ${d.toFixed(1)} m from its step point`);
    });
    if (p.maneuvers.at(-1)!.man !== 'arrive' || Math.abs(p.maneuvers.at(-1)!.at - p.total) > 1e-6) fail(`${tag}: last maneuver isn't the arrival at the end`);
    // profile: monotone, under road speed, consistent inverse
    let lastS = -1;
    for (let t = 0; t <= p.physTime + 0.5; t += 0.25) {
      const { s, v } = stateAt(p, t);
      if (s < lastS - 1e-6) { fail(`${tag}: went backwards at t=${t}`); break; }
      lastS = s;
      // speeds are set per 4 m sample: at a road change the faster road's speed may carry one sample either side
      const sp = spanAt(p, s), cap = Math.max(0, ...p.spans.filter((x) => x.s1 >= s - p.ds && x.s0 <= s + p.ds).map((x) => x.v));
      if (sp && v > cap * 1.001 + 0.05) { fail(`${tag}: ${(v * 3.6).toFixed(0)} km/h over the road's ${(cap * 3.6).toFixed(0)} at ${s.toFixed(0)} m`); break; }
      if (v < -1e-6 || !Number.isFinite(v)) { fail(`${tag}: bad speed ${v}`); break; }
    }
    if (Math.abs(lastS - p.total) > 1e-6) fail(`${tag}: profile ends at ${lastS} of ${p.total}`);
    for (let s = 0; s < p.total; s += p.total / 37) { const back = stateAt(p, timeAt(p, s)).s; if (Math.abs(back - s) > 0.05) { fail(`${tag}: timeAt/stateAt disagree at ${s.toFixed(1)} (${back.toFixed(2)})`); break; } }
    if (Math.abs(p.physTime * p.k - r.time) > 1e-6) fail(`${tag}: plan time ${p.physTime * p.k} ≠ route ${r.time}`);
  }
  ks.sort((x, y) => x - y);
  const q = (f: number) => ks[Math.floor(f * (ks.length - 1))]?.toFixed(2);
  console.log(`${name}: ${trips} trips, ${(len / 1000 / Math.max(1, trips)).toFixed(1)} km avg, ${mans} maneuvers (max ${maxOff.toFixed(2)} m off), named ${(100 * named / len).toFixed(0)}%, limit known ${(100 * limited / len).toFixed(0)}%, ${brunnels} bridge/tunnel roads; time scale k p10 ${q(0.1)} median ${q(0.5)} p90 ${q(0.9)}`);
  if (!trips) fail(`${name}: no driving trips`);
}
if (!files.length) { console.error('no exports found'); process.exit(1); }
if (failures) { console.error(`${failures} problems`); process.exit(1); }
console.log('nav checks passed');
