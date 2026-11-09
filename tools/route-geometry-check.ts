// Route geometry: every drawn piece of a walking or driving route lies on an exported road/path segment, except the
// link from the chosen point (or a transit stop) to the nearest usable path, which must be no longer than
// the distance to that path (+ a little slack for choosing a side). No straight shortcuts to junctions.
//   npm run check:route-geometry [files...] [--n=40]
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCity } from '../src/parse';
import { buildCity } from '../src/build';
import { Router } from '../src/router';
import { inferOneWay } from '../src/oneway';
import { detectTolls } from '../src/tolls';
import { fromLngLat, nearestOnLine, type XY } from '../src/geo';
import { laneAccess } from '../src/access';

const dir = process.env.CSLMAP_DIR ?? path.join(os.homedir(), 'Library/Application Support/Steam/steamapps/common/Cities_Skylines/CSLMapView');
let files = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const N = +(process.argv.find((a) => a.startsWith('--n='))?.slice(4) ?? 40);
if (!files.length && existsSync(dir)) {
  const seen = new Set<string>();
  files = readdirSync(dir).filter((f) => /\.cslmap$/i.test(f)).sort((a, b) => statSync(path.join(dir, b)).mtimeMs - statSync(path.join(dir, a)).mtimeMs)
    .filter((f) => { const c = f.normalize('NFC').replace(/-\d{8}-\d{6}\.cslmap$|\.cslmap$/i, ''); return !seen.has(c) && seen.add(c); }).map((f) => path.join(dir, f));
}
let failures = 0;
const fail = (m: string) => { failures++; console.error('  ✗ ' + m); };
let seed = 7;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

for (const f of files) {
  const name = path.basename(f).normalize('NFC');
  const city = parseCity(readFileSync(f, 'utf8'));
  const ow = inferOneWay(city), tl = detectTolls(city);
  const built = buildCity(city, () => {}, ow, tl);
  const router = new Router(city, built.stopNames ?? new Map(), ow, tl);
  // straight pieces of every segment, by 20 m cell
  const C = 20, grid = new Map<string, [XY, XY, number][]>();
  const walkPieces: [XY, XY][] = [];
  for (const s of city.segs) {
    const walk = laneAccess(s, city.segTypes.get(s.name)).walk;
    for (let i = 1; i < s.pts.length; i++) {
      const a: XY = [s.pts[i - 1].x, s.pts[i - 1].z], b: XY = [s.pts[i].x, s.pts[i].z], sid = s.id;
      if (walk) walkPieces.push([a, b]);
      for (let x = Math.floor(Math.min(a[0], b[0]) / C); x <= Math.floor(Math.max(a[0], b[0]) / C); x++) for (let z = Math.floor(Math.min(a[1], b[1]) / C); z <= Math.floor(Math.max(a[1], b[1]) / C); z++) {
        const k = x + ',' + z; const l = grid.get(k); if (l) l.push([a, b, sid]); else grid.set(k, [[a, b, sid]]);
      }
    }
  }
  /** The segment piece a drawn piece lies on, with whether it runs along the segment's point order. */
  const pieceOf = (p: XY, q: XY): { seg: number; along: boolean }[] => {
    const m: XY = [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], out: { seg: number; along: boolean }[] = [];
    for (const [a, b, seg] of grid.get(Math.floor(m[0] / C) + ',' + Math.floor(m[1] / C)) ?? []) {
      const hp = nearestOnLine(p, [a, b]), hq = nearestOnLine(q, [a, b]);
      if (hp.d < 0.35 && hq.d < 0.35) out.push({ seg, along: hq.along >= hp.along });
    }
    return out;
  };
  const onNet = (p: XY, q: XY) => pieceOf(p, q).length > 0;
  // nearest walkable path on the connected network (tiny disconnected scraps can't take you anywhere)
  const R = router as any;
  const usableFor = (m: 'walk' | 'drive') => { const comp = R.comp(m), big = Math.min(40, Math.max(...comp.size, 0)); return (R.edges as any[]).filter((e) => R.allowed(e, m) && comp.id[e.a] >= 0 && comp.size[comp.id[e.a]] >= big); };
  const usable = { walk: usableFor('walk'), drive: usableFor('drive') };
  // driving can't join part-way along a motorway/ramp/highway, so measure to the nearest other road in reach
  const local = usable.drive.filter((e) => !['motorway', 'motorway_link', 'trunk'].includes(e.cls));
  const toPath = (p: XY, m: 'walk' | 'drive' = 'walk') => {
    const near = (list: any[]) => { let d = Infinity; for (const e of list) d = Math.min(d, nearestOnLine(p, e.pts).d); return d; };
    if (m === 'walk') return near(usable.walk);
    // only motorways in reach: no access part-way along, so the trip starts at a junction; not checked
    const dl = near(local);
    return dl < 450 ? dl : Infinity;
  };
  void walkPieces;
  const stops = new Map<string, XY>();
  for (const tr of city.transports) for (const sid of tr.stops) { const n = city.nodes.get(sid); if (n) stops.set(`${n.x.toFixed(1)},${n.z.toFixed(1)}`, [n.x, n.z]); }
  const isStop = (p: XY) => stops.has(`${p[0].toFixed(1)},${p[1].toFixed(1)}`) || [...stops.values()].some((s) => Math.hypot(s[0] - p[0], s[1] - p[1]) < 0.3);
  // one-way policy, edge by edge: even the last-resort search never permits driving against a direction
  // confirmed by vehicles, and does permit (only then) going against a likely keep-right one
  {
    let leak = 0, likely = 0;
    R.relaxed = true;
    for (const e of R.edges as any[]) {
      if (!e.ow || !e.acc.drive) continue;
      const wrong = R.driveOk(e, e.ow !== 1);
      if (e.confirmed && wrong) leak++;
      if (e.sure && !e.confirmed && wrong) likely++;
    }
    R.relaxed = false;
    const strictLeak = (R.edges as any[]).filter((e) => e.ow && e.sure && e.acc.drive && R.driveOk(e, e.ow !== 1)).length;
    if (leak || strictLeak) fail(`one-way policy leak: ${leak} confirmed (last resort), ${strictLeak} inferred (normal search) directions drivable the wrong way`);
    // a flagged route says where: a marker and a warning step at the first likely one-way it breaks
    const kr = (R.edges as any[]).findIndex((e) => e.ow && e.sure && !e.confirmed && e.acc.drive && e.pts.length >= 2);
    if (kr >= 0) {
      const e = R.edges[kr], path = [{ e: kr, fwd: e.ow !== 1 }];
      const route: any = R.partsRoute([{ ed: e, pts: e.ow !== 1 ? e.pts : [...e.pts].reverse() }], 'drive', e.pts[0], e.pts[e.pts.length - 1]);
      R.flagAgainst(route, path);
      if (!route.againstLikelyOneWay?.length || !route.legs[0].steps.some((st: any) => st.maneuver === 'warn')) fail('a route against a likely one-way is not flagged with a warning step');
    }
    console.log(`  one-way policy: ${likely} likely (keep-right) directions may be bent as a flagged last resort; confirmed ones never`);
  }
  // random trips between road nodes
  const nodes = [...city.nodes.values()].filter((n) => n.srv === 'Road');
  let routes = 0, interior = 0, interiorLen = 0, worstInterior = 0, longAccess = 0, against = 0, againstConfirmed = 0, bent = 0;
  const notes: string[] = [];
  for (let t = 0; t < N; t++) {
    const a = nodes[Math.floor(rnd() * nodes.length)], dx = (rnd() - 0.5) * 2400, dz = (rnd() - 0.5) * 2400;
    const from: XY = [a.x + (rnd() - 0.5) * 120, a.z + (rnd() - 0.5) * 120], to: XY = [a.x + dx, a.z + dz];
    for (const mode of ['walk', 'transit', 'drive'] as const) {
      const r = router.route(from, to, mode)[0];
      if (!r) continue;
      routes++;
      const walks = r.legs.filter((l) => l.kind === 'walk' || l.kind === 'drive');
      // one-way rules: a direction confirmed by vehicles is never driven against; an ordinary route never
      // breaks a likely (keep-right) one either; a last-resort route that does must say so
      const flagged = !!r.againstLikelyOneWay?.length;
      if (mode === 'drive' && flagged) bent++;
      if (mode === 'drive') for (const l of r.legs) {
        const pts = l.coords.map(([lng, lat]) => fromLngLat(lng, lat));
        for (let i = 1; i < pts.length; i++) {
          if (Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]) < 1) continue;
          const on = pieceOf(pts[i - 1], pts[i]);
          if (!on.length) continue;
          // shared geometry (a road with parallel pieces) is fine if any carrier allows this direction
          const allows = (strict: boolean) => on.some(({ seg, along }) => { const dir = ow.dir.get(seg) ?? 0, src = ow.source.get(seg); const rule = strict ? src === 'transit' || src === 'keepright' : src === 'transit'; return !dir || !rule || (dir === 1) === along; });
          if (!allows(false)) { againstConfirmed++; if (notes.length < 8) notes.push(`drive against a CONFIRMED one-way seg ${on[0].seg} at (${pts[i - 1].map((v) => v.toFixed(0))})`); }
          else if (!flagged && !allows(true)) { against++; if (notes.length < 8) notes.push(`unflagged drive against a likely one-way seg ${on[0].seg} at (${pts[i - 1].map((v) => v.toFixed(0))})`); }
        }
      }
      walks.forEach((l, wi) => {
        const pts = l.coords.map(([lng, lat]) => fromLngLat(lng, lat));
        for (let i = 1; i < pts.length; i++) {
          const p = pts[i - 1], q = pts[i], d = Math.hypot(q[0] - p[0], q[1] - p[1]);
          if (d < 0.5 || onNet(p, q)) continue;
          const atStart = i === 1 && wi === 0 && l === r.legs[0], atEnd = i === pts.length - 1 && l === r.legs[r.legs.length - 1];
          const atStop = isStop(p) || isStop(q);
          if (atStart || atEnd || atStop) {
            if (flagged) continue; // last-resort routes may start at any junction
            // an access link: no longer than the way to the nearest path, plus slack for picking a side
            const end = atStart ? p : atEnd ? q : isStop(p) ? p : q;
            const near = toPath(end, mode === 'drive' ? 'drive' : 'walk');
            // routes into an asset may step off any path within 60 m of its footprint (its forecourt)
            const slack = (atStart && R.assetAt(from)) || (atEnd && R.assetAt(to)) ? 65 : 35;
            if (d > near + slack) { longAccess++; if (notes.length < 6) notes.push(`${mode} access ${d.toFixed(0)} m where the nearest path is ${near.toFixed(0)} m (${end.map((v) => v.toFixed(0))}) piece ${i}/${pts.length - 1} trip ${from.map((v) => v.toFixed(0))} → ${to.map((v) => v.toFixed(0))}`); }
            continue;
          }
          interior++; interiorLen += d; worstInterior = Math.max(worstInterior, d);
          if (notes.length < 6) notes.push(`${mode} off-network piece ${d.toFixed(1)} m at (${p.map((v) => v.toFixed(0))}) → (${q.map((v) => v.toFixed(0))})`);
        }
      });
    }
  }
  console.log(`\n${name}: ${routes} routes; mid-route pieces off the network: ${interior} (${interiorLen.toFixed(0)} m, worst ${worstInterior.toFixed(1)} m); access links longer than needed: ${longAccess}; against a confirmed one-way: ${againstConfirmed}; unflagged against a likely one: ${against}; flagged last-resort routes: ${bent}`);
  for (const n of notes) console.log('    ' + n);
  if (interior) fail(`${interior} walking pieces cut across instead of following a segment`);
  if (longAccess) fail(`${longAccess} access links reach past a nearer path`);
  if (againstConfirmed) fail(`${againstConfirmed} driving pieces run against a one-way confirmed by vehicles`);
  if (against) fail(`${against} driving pieces run against a likely one-way without saying so`);
}
if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log('\nall route geometry checks passed');
