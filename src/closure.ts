// Network criticality: close a road stretch, bridge, tunnel, railway or station and compare trips before and
// after, with the same router as Directions. Only topology and routing: nothing here estimates traffic,
// passengers or cost, because the export has none of that. Runs in the worker.
import type { CityData, CSeg } from './parse';
import type { Router } from './router';
import { modeOf } from './build';
import { toLngLat, type XY } from './geo';

export interface SegInfo { group: 'road' | 'rail'; cls: string; brunnel: string; name: string }
export type ClosureKind = 'road' | 'rail' | 'station';
export interface ClosurePick { kind: ClosureKind; seg?: number; name?: string; at?: XY; scope?: 'stretch' | 'road' }
export type Verdict = 'cut' | 'long' | 'detour' | 'minor' | 'none';
type LL = [number, number];
export interface Trip { mode: 'drive' | 'walk' | 'transit'; dir: string; from?: string; to?: string; line?: { name: string; color: string }; before: number | null; after: number | null; beforeLen?: number; afterLen?: number; how?: 'transit' | 'walk'; via?: string; beforePath: LL[]; afterPath: LL[] }
export interface ClosureResult {
  kind: ClosureKind;
  title: string; titleKey?: boolean;
  /** what was closed: kind of structure and its length */
  what: string; len: number; parts: number;
  closed: LL[][]; stops: LL[];
  trips: Trip[];
  skipped: { name: string; color: string; mode: string }[];
  cutLines: { name: string; color: string; mode: string }[];
  nearest?: { before: { label: string; time: number } | null; after: { label: string; time: number } | null; at: LL | null };
  stranded: { drive: number; walk: number; geom: LL[][] };
  verdict: Verdict;
  pin: LL; mode: 'drive' | 'walk' | 'transit';
  bbox: [number, number, number, number];
  /** scope options the UI can offer */
  canWholeRoad: boolean; scope: 'stretch' | 'road';
}

const ll = (p: XY): LL => toLngLat(p[0], p[1]);
const len = (p: XY[]) => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return l; };
const RAIL_MODES = ['train', 'metro', 'monorail', 'tram'];
// i18n-keys
void ['Heading north', 'Heading northeast', 'Heading east', 'Heading southeast', 'Heading south', 'Heading southwest', 'Heading west', 'Heading northwest', 'On foot',
  'Bridge', 'Tunnel', 'Road', 'Railway', 'Rail bridge', 'Rail tunnel', 'Station', 'Bus stop', 'Unnamed road', 'Unnamed railway', 'Unnamed station'];
// end i18n-keys
const COMPASS = ['Heading east', 'Heading northeast', 'Heading north', 'Heading northwest', 'Heading west', 'Heading southwest', 'Heading south', 'Heading southeast'];
const compass = (a: XY, b: XY) => COMPASS[(Math.round(Math.atan2(b[1] - a[1], b[0] - a[0]) / (Math.PI / 4)) + 8) % 8];

/** Road and rail segments the closure tool can close, from the built map (same classes the map draws). */
export function segInfoFrom(built: { sources: Record<string, { features: { properties: Record<string, any> }[] }> }): Map<number, SegInfo> {
  const m = new Map<number, SegInfo>();
  for (const f of built.sources.roads.features) { const p = f.properties; if (p.lanes > 0 || ['footway', 'pedestrian', 'trail', 'track'].includes(p.cls)) m.set(p.id, { group: 'road', cls: p.cls, brunnel: p.brunnel ?? '', name: p.name ?? '' }); }
  for (const f of built.sources.rails.features) { const p = f.properties; if (p.type !== undefined && ['rail', 'subway', 'monorail', 'tram', 'cablecar'].includes(p.cls)) m.set(p.id, { group: 'rail', cls: p.cls, brunnel: p.brunnel ?? '', name: p.name ?? '' }); }
  return m;
}

export function createClosures(city: CityData, router: Router, info: Map<number, SegInfo>, stopNames: Map<number, string>) {
  const segById = new Map(city.segs.map((s) => [s.id, s]));
  const byNode = new Map<number, CSeg[]>();
  for (const s of city.segs) if (info.has(s.id) && s.pts.length >= 2) for (const n of [s.sn, s.en]) { const l = byNode.get(n) ?? []; l.push(s); byNode.set(n, l); }
  const xy = (s: CSeg): XY[] => s.pts.map((p) => [p.x, p.z]);
  const dirAt = (s: CSeg, node: number): XY => { // leaving direction at a node
    const p = node === s.sn ? s.pts : [...s.pts].reverse(), a = p[0];
    let b = p[p.length - 1]; for (const q of p) if (Math.hypot(q.x - a.x, q.z - a.z) >= 20) { b = q; break; }
    const d = Math.hypot(b.x - a.x, b.z - a.z) || 1; return [(b.x - a.x) / d, (b.z - a.z) / d];
  };

  /**
   * Grow a closure from one segment. A bridge or tunnel grows over its whole structure (straightest
   * continuation where it branches); an ordinary road or track grows to the junctions at either end.
   */
  function grow(s0: CSeg): CSeg[] {
    const i0 = info.get(s0.id)!, structure = i0.brunnel !== '';
    const same = (s: CSeg) => { const i = info.get(s.id); return !!i && i.group === i0.group && (!structure || i.brunnel === i0.brunnel); };
    const out = [s0], seen = new Set([s0.id]);
    for (const startNode of [s0.sn, s0.en]) {
      let cur = s0, node = startNode;
      for (let k = 0; k < 400; k++) {
        const all = (byNode.get(node) ?? []).filter((s) => s.id !== cur.id && info.get(s.id)?.group === i0.group);
        let next: CSeg | undefined;
        if (!structure) next = all.length === 1 && same(all[0]) ? all[0] : undefined; // stop at any junction
        else {
          const cand = all.filter(same), din = dirAt(cur, node);
          // straight on = leaving directions roughly opposite
          next = cand.map((s) => ({ s, c: (() => { const d = dirAt(s, node); return d[0] * din[0] + d[1] * din[1]; })() })).filter((x) => x.c < -0.8).sort((a, b) => a.c - b.c)[0]?.s;
        }
        if (!next || seen.has(next.id)) break;
        seen.add(next.id); out.push(next);
        node = next.sn === node ? next.en : next.sn; cur = next;
      }
    }
    return out;
  }
  /** The other carriageway or track of a divided road/line: parallel, close, same name (or both unnamed). */
  function parallels(chain: CSeg[]): CSeg[] {
    const i0 = info.get(chain[0].id)!, ids = new Set(chain.map((s) => s.id));
    const pts = chain.flatMap(xy), L = len(pts);
    if (L < 40) return [];
    const head = (s: CSeg) => { const p = xy(s), a = p[0], b = p[p.length - 1], d = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; return [(b[0] - a[0]) / d, (b[1] - a[1]) / d]; };
    const distTo = (q: XY) => { let d = Infinity; for (let i = 1; i < pts.length; i++) { const [ax, az] = pts[i - 1], [bx, bz] = pts[i], dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1; const t = Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - az) * dz) / l2)); d = Math.min(d, Math.hypot(q[0] - ax - t * dx, q[1] - az - t * dz)); } return d; };
    const mid = chain[chain.length >> 1], hm = head(mid);
    const found: CSeg[] = [];
    for (const s of city.segs) {
      const i = info.get(s.id);
      if (!i || ids.has(s.id) || i.group !== i0.group || i.brunnel !== i0.brunnel || i.name !== i0.name || s.pts.length < 2) continue;
      const p = xy(s), m = p[p.length >> 1];
      if (Math.abs(m[0] - pts[0][0]) > L + 100 && Math.abs(m[1] - pts[0][1]) > L + 100) continue;
      const h = head(s);
      if (Math.abs(h[0] * hm[0] + h[1] * hm[1]) < 0.85 || distTo(m) > 45) continue;
      // touching the chain at a node means it's a branch, not a parallel carriageway
      if (chain.some((c) => c.sn === s.sn || c.sn === s.en || c.en === s.sn || c.en === s.en)) continue;
      found.push(s);
    }
    if (!found.length) return [];
    const other = grow(found[0]);
    return len(other.flatMap(xy)) >= L * 0.4 ? other : [];
  }
  /** Ordered chains (runs of segments joined end to end) inside a closed set, with their end nodes. */
  function chainsOf(segs: CSeg[]) {
    const ids = new Set(segs.map((s) => s.id)), used = new Set<number>(), out: { segs: { s: CSeg; fwd: boolean }[]; a: number; b: number }[] = [];
    const at = (n: number) => (byNode.get(n) ?? []).filter((s) => ids.has(s.id));
    for (const s0 of segs) {
      if (used.has(s0.id)) continue;
      // walk back to an end of this run, then forward
      let s = s0, n = s0.sn;
      for (let k = 0; k < 500; k++) { const o = at(n).filter((x) => x.id !== s.id); if (o.length !== 1 || o[0].id === s0.id) break; s = o[0]; n = s.sn === n ? s.en : s.sn; }
      const run: { s: CSeg; fwd: boolean }[] = [], a = n;
      for (let k = 0; k < 500 && !used.has(s.id); k++) {
        used.add(s.id); const fwd = s.sn === n; run.push({ s, fwd }); n = fwd ? s.en : s.sn;
        const o = at(n).filter((x) => x.id !== s.id && !used.has(x.id)); if (o.length !== 1) break; s = o[0];
      }
      out.push({ segs: run, a, b: n });
    }
    return out;
  }
  /** Walk out from a chain end along the network to the first junction, so a detour can start there. */
  function toJunction(node: number, fromSeg: number, mode: 'drive' | 'walk'): number {
    let i = router.nodeIndex(node), seg = fromSeg;
    for (let k = 0; k < 200 && i >= 0; k++) { const nx = router.nextAlong(i, seg, mode); if (!nx) break; i = nx.node; seg = nx.seg; }
    return i;
  }

  function resolve(p: ClosurePick): { segs: CSeg[]; stops: number[]; title: string; titleKey: boolean; what: string; at: XY; canWholeRoad: boolean; scope: 'stretch' | 'road' } | null {
    if (p.kind === 'station') {
      const at = p.at!;
      let stops: number[] = [];
      if (p.name) stops = [...stopNames].filter(([, n]) => n === p.name).map(([id]) => id);
      if (!stops.length) {
        // unnamed: the stops of rail-type lines (or, for a bus stop, bus lines) right here
        for (const tr of city.transports) {
          const m = modeOf(tr.type), wantBus = p.scope === 'road'; // scope 'road' marks a bus stop pick
          if (wantBus ? m !== 'bus' : !RAIL_MODES.includes(m) && m !== 'ferry' && m !== 'cablecar') continue;
          for (const id of tr.stops) { const n = city.nodes.get(id); if (n && Math.hypot(n.x - at[0], n.z - at[1]) < (wantBus ? 45 : 130) && !stops.includes(id)) stops.push(id); }
        }
      }
      if (!stops.length) return null;
      const isBus = p.scope === 'road';
      return { segs: [], stops, title: p.name || (isBus ? 'Bus stop' : 'Unnamed station'), titleKey: !p.name, what: isBus ? 'Bus stop' : 'Station', at, canWholeRoad: false, scope: 'stretch' };
    }
    const s0 = p.seg !== undefined ? segById.get(p.seg) : undefined, i0 = s0 && info.get(s0.id);
    if (!s0 || !i0) return null;
    const named = !!i0.name;
    let segs: CSeg[];
    const scope = p.scope === 'road' && named ? 'road' : 'stretch';
    if (scope === 'road') segs = city.segs.filter((s) => { const i = info.get(s.id); return i && i.group === i0.group && i.name === i0.name && s.pts.length >= 2; });
    else { const c = grow(s0); segs = [...c, ...parallels(c)]; }
    const rail = i0.group === 'rail';
    const what = i0.brunnel === 'bridge' ? (rail ? 'Rail bridge' : 'Bridge') : i0.brunnel === 'tunnel' ? (rail ? 'Rail tunnel' : 'Tunnel') : rail ? 'Railway' : 'Road';
    const mid = xy(s0)[s0.pts.length >> 1];
    return { segs, stops: [], title: i0.name || (rail ? 'Unnamed railway' : 'Unnamed road'), titleKey: !named, what, at: mid, canWholeRoad: named, scope };
  }

  function analyze(p: ClosurePick): ClosureResult | null {
    const r = resolve(p);
    if (!r) return null;
    const closed = new Set(r.segs.map((s) => s.id)), stops = new Set(r.stops);
    const trips: Trip[] = [];
    const lenOf = (segs: CSeg[]) => segs.reduce((t, s) => t + len(xy(s)), 0);
    const toLL = (c: XY[]) => c.map(ll);
    try {
      // ---- road trips across the closure, each direction a car may legally drive it
      const roadChains = chainsOf(r.segs.filter((s) => router.edgeAccess(s.id)));
      for (const mode of ['drive', 'walk'] as const) {
        for (const c of roadChains) {
          if (!c.segs.every(({ s }) => router.edgeAccess(s.id)?.[mode])) continue;
          const A = toJunction(c.a, c.segs[0].s.id, mode), B = toJunction(c.b, c.segs[c.segs.length - 1].s.id, mode);
          if (A < 0 || B < 0 || A === B) continue;
          const pa = city.nodes.get(c.a)!, pb = city.nodes.get(c.b)!;
          const dirs: [number, number, XY, XY][] = [];
          if (mode === 'walk') dirs.push([A, B, [pa.x, pa.z], [pb.x, pb.z]]);
          else {
            if (c.segs.every(({ s, fwd }) => router.drivable(s.id, fwd))) dirs.push([A, B, [pa.x, pa.z], [pb.x, pb.z]]);
            if (c.segs.every(({ s, fwd }) => router.drivable(s.id, !fwd))) dirs.push([B, A, [pb.x, pb.z], [pa.x, pa.z]]);
          }
          for (const [a, b, qa, qb] of dirs) {
            router.setClosure(null, null);
            const before = router.nodeRoute(a, b, mode);
            if (!before || !before.segs.some((id) => closed.has(id))) continue; // this trip never used it
            router.setClosure(closed, stops);
            const after = router.nodeRoute(a, b, mode);
            trips.push({ mode, dir: mode === 'walk' ? 'On foot' : compass(qa, qb), before: before.time, after: after?.time ?? null, beforeLen: before.dist, afterLen: after?.dist, beforePath: toLL(before.coords), afterPath: after ? toLL(after.coords) : [] });
          }
        }
      }
      // one row per mode and heading: the worst one (a divided road has two carriageways each way at most)
      const keep = new Map<string, Trip>();
      for (const t of trips) { const k = t.mode + t.dir, o = keep.get(k); const add = (x: Trip) => (x.after === null ? Infinity : x.after - (x.before ?? 0)); if (!o || add(t) > add(o)) keep.set(k, t); }
      trips.splice(0, trips.length, ...[...keep.values()].sort((a, b) => (a.mode === b.mode ? 0 : a.mode === 'drive' ? -1 : 1)));

      // ---- transit: hops cut by the closure (stations either side), trips between them before and after
      router.setClosure(closed, stops);
      const { cut, skipped } = router.closureLines();
      const pairs = new Map<string, (typeof cut)[number]>();
      for (const h of cut) { if (!h.pa || !h.pb || h.a === h.b) continue; const k = [h.from, h.to].sort().join('|') + '|' + h.name; if (!pairs.has(k)) pairs.set(k, h); }
      for (const h of [...pairs.values()].slice(0, 6)) {
        router.setClosure(null, null);
        const before = router.bestTrip(h.pa!, h.pb!);
        router.setClosure(closed, stops);
        const after = router.bestTrip(h.pa!, h.pb!);
        // only trips the closure changes (a cut hop next to a parallel line may cost nothing)
        if (before && after && after.time - before.time < 20) continue;
        trips.push({ mode: 'transit', dir: '', from: h.from, to: h.to, line: { name: h.name, color: h.color }, before: before?.time ?? null, after: after?.time ?? null, how: after?.how, via: after?.via, beforePath: before ? toLL(before.coords) : [], afterPath: after ? toLL(after.coords) : [] });
      }
      const cutLines = [...new Map(cut.map((h) => [h.name, { name: h.name, color: h.color, mode: h.mode }])).values()];

      // ---- a closed station: where its passengers can go instead
      let nearest: ClosureResult['nearest'];
      if (r.stops.length) {
        const modes = [...new Set(city.transports.filter((tr) => tr.stops.some((s) => stops.has(s))).map((tr) => modeOf(tr.type)))];
        router.setClosure(null, null);
        const b0 = router.nearestOpenStop(r.at, modes);
        router.setClosure(closed, stops);
        const a0 = router.nearestOpenStop(r.at, modes);
        nearest = { before: b0 && { label: b0.label, time: b0.time }, after: a0 && { label: a0.label, time: a0.time }, at: a0 ? ll(a0.at) : null };
      }

      // ---- roads no longer reachable at all
      let strandedGeom: LL[][] = [], sd = 0, sw = 0;
      if (closed.size && r.segs.some((s) => router.edgeAccess(s.id))) {
        router.setClosure(closed, stops);
        const d = router.cutOff('drive', closed), w = router.cutOff('walk', closed);
        const geomIds = new Set([...d, ...w]);
        strandedGeom = [...geomIds].map((id) => segById.get(id)).filter((s): s is CSeg => !!s).map((s) => toLL(xy(s)));
        sd = d.reduce((t, id) => t + len(xy(segById.get(id)!)), 0); sw = w.reduce((t, id) => t + len(xy(segById.get(id)!)), 0);
      }

      // ---- verdict, from the numbers above only
      const added = trips.map((t) => (t.before === null ? 0 : t.after === null ? Infinity : t.after - t.before));
      const worst = Math.max(0, ...added);
      const ratio = Math.max(0, ...trips.map((t) => (t.before && t.after ? t.after / t.before : 0)));
      let verdict: Verdict;
      if (sd > 20 || sw > 20 || worst === Infinity) verdict = 'cut';
      else if (r.stops.length && !trips.length) {
        const extra = nearest?.after && nearest.before ? nearest.after.time - nearest.before.time : Infinity;
        verdict = !nearest?.after ? 'cut' : extra >= 600 ? 'long' : extra >= 180 ? 'detour' : 'minor';
      } else verdict = worst >= 600 || (ratio >= 3 && worst >= 180) ? 'long' : worst >= 120 ? 'detour' : worst > 15 ? 'minor' : 'none';

      const closedLL = r.segs.map((s) => toLL(xy(s)));
      const stopLL = r.stops.map((id) => city.nodes.get(id)).filter(Boolean).map((n) => ll([n!.x, n!.z]));
      const all = [...closedLL.flat(), ...stopLL, ...trips.flatMap((t) => t.afterPath)];
      const bbox: [number, number, number, number] = [Math.min(...all.map((q) => q[0])), Math.min(...all.map((q) => q[1])), Math.max(...all.map((q) => q[0])), Math.max(...all.map((q) => q[1]))];
      // where the "what can I reach" comparison starts: one side of the closure, or the station
      const t0 = trips.find((t) => t.mode !== 'transit' && t.beforePath.length) ?? trips[0];
      const pin = r.stops.length ? ll(r.at) : t0?.beforePath[0] ?? ll(r.at);
      return {
        kind: p.kind === 'station' ? 'station' : (info.get(r.segs[0]?.id)?.group ?? p.kind), title: r.title, titleKey: r.titleKey, what: r.what, len: lenOf(r.segs), parts: chainsOf(r.segs).length,
        closed: closedLL, stops: stopLL, trips, skipped, cutLines, nearest, stranded: { drive: sd, walk: sw, geom: strandedGeom }, verdict,
        pin, mode: r.stops.length || info.get(r.segs[0]?.id)?.group === 'rail' ? 'transit' : 'drive', bbox, canWholeRoad: r.canWholeRoad, scope: r.scope,
      };
    } finally {
      router.setClosure(null, null);
    }
  }

  /** Reach from a point before and after the closure (node times), for the comparison map. */
  function reach(p: ClosurePick, from: XY, mode: 'drive' | 'walk' | 'bike' | 'transit', max: number) {
    const r = resolve(p);
    if (!r) return null;
    try {
      router.setClosure(null, null);
      const before = router.reachTimes(from, mode, max);
      router.setClosure(new Set(r.segs.map((s) => s.id)), new Set(r.stops));
      const after = router.reachTimes(from, mode, max);
      return { before, after };
    } finally { router.setClosure(null, null); }
  }

  return { analyze, reach };
}
