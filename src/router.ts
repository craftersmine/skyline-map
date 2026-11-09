// Directions engine: builds walk / bike / drive graphs from road segments and
// a transit graph from the game's lines, then runs Dijkstra. Runs in the worker.
import type { CityData, CSeg } from './parse';
import { classify, laneInfo, modeOf, buildingGroups } from './build';
import { toLngLat, pointInRing, distToRing, nearestOnLine, type XY } from './geo';
import type { OneWayResult } from './oneway';
import type { TollData } from './tolls';
import { laneAccess, hasVehicle, type Access } from './access';
import { hopTime, legRideTime, modeParams, type Piece } from './transit-time';
import { t } from './i18n';

export type Mode = 'drive' | 'transit' | 'walk' | 'bike';

/** Road classes with no access part-way along (the game's highway-flagged networks). */
const HIGHWAY = new Set(['motorway', 'motorway_link', 'trunk']);

/**
 * Joining the network: a graph node to start/end the search at, the seconds it takes to get there, and the
 * piece of edge walked to reach it (from the point where the place meets the path to the node), so the drawn
 * route follows the path instead of a straight line to the node.
 */
/** A point on a drivable road where a trip can join it: edge, position along it (metres and fraction), seconds of extra access. */
interface DriveHit { e: number; pt: XY; d: number; along: number; i: number; frac: number; extra: number }

interface Join { node: number; extra: number; part?: Edge; snap?: { e: number; pt: XY; along: number; i: number; d: number } }

interface Edge {
  id: number; a: number; b: number; len: number; pts: XY[]; cls: string; name: string; speed: number; bike: boolean; brunnel: string;
  /** one-way: +1 traffic a→b, -1 b→a, 0 two-way; `sure` = backed by transit or keep-right evidence */
  /** one-way direction (+1 start→end, -1 end→start, 0 two-way) and how it is known:
   *  `sure` — inferred with evidence (transit vehicles or keep-right layout), obeyed as a rule;
   *  `confirmed` — backed by transit vehicles (seen driving it, or locked to such a segment by junction
   *  rules): never driven against, even as a last resort. Raw lane values (neither) are only penalised. */
  ow: number; sure: boolean; confirmed: boolean;
  /** booth id when this segment is a toll GATE (driving through it means paying), else 0 */
  gate: number;
  /** who may use it, from the segment type's lanes (see access.ts) */
  acc: Access;
  /** heading leaving node a into the edge, and leaving node b into the edge */
  hA: number; hB: number;
}

export interface Step { text: string; dist: number; time: number; at: XY; maneuver: string; road?: string; /** toll steps: the booth passed */ booth?: number }
export interface Leg {
  kind: 'walk' | 'ride' | 'drive' | 'bike';
  dist: number; time: number; coords: XY[]; steps: Step[];
  line?: { id: number; name: string; color: string; mode: string }; from?: string; to?: string; stops?: number; stopNames?: string[];
  /** ride legs: seconds in the vehicle, and the estimated wait before boarding (no timetable in the export) */
  ride?: number; wait?: number;
  /** ride legs: the stop nodes from boarding to alighting (maps the leg onto the schematic map) */
  stopIds?: number[];
}
interface TransitOpts { linePenalty?: Map<number, number>; transferPenalty?: number; walkFactor?: number }
export interface TollPass { booth: number; name: string; road: string }
export interface Route {
  mode: Mode; dist: number; time: number; via: string; legs: Leg[];
  /** toll gates driven through, in order */
  tolls?: TollPass[];
  /**
   * driving: no route obeys every inferred one-way, so this one drives against a direction inferred from
   * the road layout (keep-right) that no vehicle has confirmed: where, and on which road. Directions
   * confirmed by transit vehicles are never broken; with no route that respects them there is no route.
   */
  againstLikelyOneWay?: { at: XY; road: string }[];
  /** tolls were to be avoided but no toll-free route exists */
  tollsUnavoidable?: boolean;
}

const WALK = 1.35, BIKE = 4.6; // m/s
const DRIVE_DEFAULT: Record<string, number> = { motorway: 100, motorway_link: 60, trunk: 80, primary: 60, secondary: 50, tertiary: 50, minor: 40, service: 20, track: 25 };
const LABEL: Record<string, string> = { motorway: 'highway', motorway_link: 'ramp', trunk: 'expressway', primary: 'main road', secondary: 'road', tertiary: 'road', minor: 'street', service: 'service road', track: 'gravel road', footway: 'path', trail: 'trail', pedestrian: 'pedestrian street' };

const len = (p: XY[]) => { let l = 0; for (let i = 1; i < p.length; i++) l += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]); return l; };

class Heap {
  k: number[] = []; v: number[] = [];
  push(key: number, val: number) {
    const { k, v } = this; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop(): [number, number] | null {
    const { k, v } = this; if (!k.length) return null;
    const top: [number, number] = [k[0], v[0]]; const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; }
    }
    return top;
  }
}

export class Router {
  private nodeIdx = new Map<number, number>();
  private pos: XY[] = [];
  private edges: Edge[] = [];
  private adj: number[][] = []; // node index → edge indices
  private lines: { id: number; name: string; color: string; mode: string; stops: number[]; hops: { pts: XY[]; len: number; time: number }[] }[] = [];
  private stopWalk = new Map<number, Join[]>(); // stop node → where it joins the walking network (+ seconds to reach)
  private stopPos = new Map<number, XY>();

  private booths = new Map<number, { name: string; unconfirmed: boolean; road: string }>();
  private avoidTolls = false;
  /** multi-part assets (stations, stadiums, malls…): their footprints, so a trip to one ends at its edge */
  private assets: { rings: XY[][]; box: [number, number, number, number] }[] = [];
  /** the asset footprints a route endpoint stands in, for the current search (walk/bike/transit only) */
  private ends = new Map<string, XY[][]>();

  constructor(private city: CityData, private stopNames: Map<number, string>, oneway?: OneWayResult, tolls?: TollData) {
    for (const b of tolls?.booths ?? []) this.booths.set(b.id, { name: b.name, unconfirmed: !!b.unconfirmed, road: b.roads[0] ?? '' });
    const node = (id: number): number => {
      let i = this.nodeIdx.get(id);
      if (i === undefined) { const n = city.nodes.get(id); i = this.pos.length; this.nodeIdx.set(id, i); this.pos.push(n ? [n.x, n.z] : [0, 0]); this.adj.push([]); }
      return i;
    };
    const segById = new Map<number, CSeg>();
    for (const seg of city.segs) {
      segById.set(seg.id, seg);
      if (seg.pts.length < 2 || !city.nodes.has(seg.sn) || !city.nodes.has(seg.en)) continue;
      const st = city.segTypes.get(seg.name);
      const lanes = laneInfo(st);
      const acc = laneAccess(seg, st);
      if (!acc.walk && !acc.drive && !acc.bike && !acc.bikeWalk) continue;
      const c0 = classify(seg, st, lanes);
      // class only names the edge in instructions and sets default speeds; access comes from lanes
      const c = c0.group === 'road' || c0.group === 'path' ? c0 : { ...c0, cls: acc.drive ? 'minor' : 'footway' };
      const pts: XY[] = seg.pts.map((p) => [p.x, p.z]);
      const both = seg.name + ' ' + seg.icls;
      const e: Edge = {
        id: seg.id, a: node(seg.sn), b: node(seg.en), len: Math.max(1, len(pts)), pts, cls: c.cls, name: seg.customName,
        speed: (lanes.speed > 0 && lanes.speed < 200 ? lanes.speed : DRIVE_DEFAULT[c.cls] ?? 30) / 3.6,
        bike: lanes.bike || /Bicycle|Bike/i.test(seg.name), brunnel: /Tunnel/i.test(both) ? 'tunnel' : /Elevated|Bridge/i.test(both) ? 'bridge' : '',
        acc, gate: tolls?.gateOf.get(seg.id) ?? 0, ow: oneway?.dir.get(seg.id) ?? 0, sure: !!oneway && oneway.source.get(seg.id) !== 'prior' && oneway.source.has(seg.id), confirmed: oneway?.source.get(seg.id) === 'transit',
        hA: headRad(pts), hB: headRad([...pts].reverse()),
      };
      const ei = this.edges.push(e) - 1;
      this.adj[e.a].push(ei); this.adj[e.b].push(ei);
    }

    // transit lines: hop geometry between consecutive stops from the route segments
    const routeSegs = new Map<string, number[]>();
    for (const s of city.segs) if (s.path) routeSegs.set(s.sn + ',' + s.en, s.path);
    for (const tr of city.transports) {
      const mode = modeOf(tr.type);
      if (tr.stops.length < 2 || mode === 'air' || mode === 'tour') continue; // guided walking tours are sightseeing, not transport
      const hops = tr.stops.map((a, i) => {
        const b = tr.stops[(i + 1) % tr.stops.length];
        const segs = (routeSegs.get(a + ',' + b) ?? []).filter((id, k, arr) => k === 0 || id !== arr[k - 1]).map((id) => segById.get(id)).filter((s): s is CSeg => !!s);
        const na = city.nodes.get(a), nb = city.nodes.get(b);
        // stops sit part-way along a segment, but the path lists whole segments at both ends: trim to the stops
        const pts = trimTo(chain(segs, na, nb), na, nb);
        const L = Math.max(30, len(pts));
        const pcs = this.pieces(segs, mode, na);
        if (pcs.length) { const raw = pcs.reduce((t, q) => t + q.len, 0), cut = raw - L; trimPieces(pcs, cut, len(chain(segs, na, nb)), pts, na); }
        return { pts, len: L, time: hopTime(pcs, mode) || L / 8 };
      });
      this.lines.push({ id: tr.id, name: tr.name, color: '#' + tr.color.map((v) => v.toString(16).padStart(2, '0')).join(''), mode, stops: tr.stops, hops });
      for (const sid of tr.stops) {
        const n = city.nodes.get(sid);
        if (!n || this.stopWalk.has(sid)) continue;
        this.stopPos.set(sid, [n.x, n.z]);
        const w = this.joins([n.x, n.z], 'walk', 3, 160, false);
        if (w.length) this.stopWalk.set(sid, w);
      }
    }
    const groups = new Map<number, XY[][]>();
    const head = buildingGroups(city.buildings);
    for (const b of city.buildings) {
      if (b.pts.length < 3) continue;
      const g = head.get(b.id) ?? b.id, ring = b.pts.map((p): XY => [p.x, p.z]);
      groups.set(g, [...(groups.get(g) ?? []), ring]);
    }
    for (const rings of groups.values()) {
      if (rings.length < 2) continue;
      const xs = rings.flat().map((p) => p[0]), zs = rings.flat().map((p) => p[1]);
      this.assets.push({ rings, box: [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)] });
    }
  }

  /** Footprints of the multi-part asset standing at p (all its parts), or null. */
  private assetAt(p: XY): XY[][] | null {
    for (const a of this.assets) {
      if (p[0] < a.box[0] || p[0] > a.box[2] || p[1] < a.box[1] || p[1] > a.box[3]) continue;
      if (a.rings.some((r) => pointInRing(p, r))) return a.rings;
    }
    return null;
  }
  /** How far node position q is from endpoint p: to the edge of the asset p stands in, else straight. */
  private reach(p: XY, q: XY): number {
    const rings = this.ends.get(p[0] + ',' + p[1]);
    return rings ? Math.min(...rings.map((r) => distToRing(q, r))) : Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  /** Edges by 64 m cell, for finding the nearest path to a point. */
  private grid: Map<number, number[]> | null = null;
  private edgesNear(p: XY, r: number): number[] {
    const C = 64, key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
    if (!this.grid) {
      this.grid = new Map();
      this.edges.forEach((e, ei) => {
        const xs = e.pts.map((q) => q[0]), zs = e.pts.map((q) => q[1]);
        for (let i = Math.floor(Math.min(...xs) / C); i <= Math.floor(Math.max(...xs) / C); i++) for (let j = Math.floor(Math.min(...zs) / C); j <= Math.floor(Math.max(...zs) / C); j++) {
          const k = key(i, j); const l = this.grid!.get(k); if (l) l.push(ei); else this.grid!.set(k, [ei]);
        }
      });
    }
    const out = new Set<number>();
    for (let i = Math.floor((p[0] - r) / C); i <= Math.floor((p[0] + r) / C); i++) for (let j = Math.floor((p[1] - r) / C); j <= Math.floor((p[1] + r) / C); j++) for (const ei of this.grid.get(key(i, j)) ?? []) out.add(ei);
    return [...out];
  }
  /**
   * Where a polyline comes closest to an asset's footprints (0 where it runs inside one). A path can run
   * alongside an asset for a while, so return the first and last points of that closest stretch: leaving
   * toward the start node steps off at `lo`, toward the end node at `hi`.
   */
  private nearestToAsset(pts: XY[], rings: XY[][]): { lo: ReturnType<typeof nearestOnLine>; hi: ReturnType<typeof nearestOnLine> } {
    const cand: ReturnType<typeof nearestOnLine>[] = [];
    let run = 0;
    pts.forEach((v, i) => {
      if (i) run += Math.hypot(v[0] - pts[i - 1][0], v[1] - pts[i - 1][1]);
      cand.push({ pt: v, d: Math.min(...rings.map((r) => distToRing(v, r))), along: run, i: Math.min(i, pts.length - 2) });
    });
    for (const r of rings) for (const q of r) { const h = nearestOnLine(q, pts); h.d = Math.min(h.d, ...rings.map((rr) => distToRing(h.pt, rr))); cand.push(h); }
    const dmin = Math.min(...cand.map((c) => c.d)), near = cand.filter((c) => c.d <= dmin + 2);
    const lo = near.reduce((a, b) => (b.along < a.along ? b : a)), hi = near.reduce((a, b) => (b.along > a.along ? b : a));
    return { lo: { ...lo, d: dmin }, hi: { ...hi, d: dmin } };
  }
  /** The stretch of an edge between two points on it, oriented from `h1` to `h2`. */
  private subLine(e: Edge, h1: { pt: XY; along: number; i: number }, h2: { pt: XY; along: number; i: number }): Edge {
    const fwd = h1.along <= h2.along, [x, y] = fwd ? [h1, h2] : [h2, h1];
    const raw: XY[] = [x.pt, ...e.pts.slice(x.i + 1, y.i + 1), y.pt];
    const pts = (fwd ? raw : [...raw].reverse()).filter((q, k, arr) => k === 0 || Math.hypot(q[0] - arr[k - 1][0], q[1] - arr[k - 1][1]) > 0.01);
    if (pts.length < 2) pts.push(pts[0]);
    return { ...e, pts, len: Math.abs(h2.along - h1.along), hA: headRad(pts), hB: headRad([...pts].reverse()) };
  }
  /** The edge from its nearest point to one end node, oriented point → node. */
  private partOf(e: Edge, hit: { pt: XY; along: number; i: number }, toB: boolean): Edge {
    const pts: XY[] = toB ? [hit.pt, ...e.pts.slice(hit.i + 1)] : [hit.pt, ...e.pts.slice(0, hit.i + 1).reverse()];
    const clean = pts.filter((q, k) => k === 0 || Math.hypot(q[0] - pts[k - 1][0], q[1] - pts[k - 1][1]) > 0.01);
    if (clean.length < 2) clean.push(clean[0]);
    return { ...e, pts: clean, len: toB ? Math.max(0, e.len - hit.along) : hit.along, hA: headRad(clean), hB: headRad([...clean].reverse()) };
  }
  /**
   * Where a point joins the network for walking, cycling and transit: the nearest point on each of the few
   * nearest usable edges, continuing along the edge to both of its nodes. Like Google, the route then meets
   * the path beside you rather than cutting straight to the nearest junction. For a point inside a
   * multi-part asset each edge is joined where it comes closest to the asset's footprint. Driving keeps
   * joining at nodes.
   */
  private joins(p: XY, mode: Mode, k = 4, max = 450, fallback = true): Join[] {
    if (mode === 'drive') return this.nearby(p, mode, k * 2, max, fallback);
    const { id, size } = this.comp(mode);
    const big = Math.min(40, Math.max(...size, 0));
    const rings = this.ends.get(p[0] + ',' + p[1]);
    let reachR = max;
    if (rings) { k = Math.max(k, 40); for (const r of rings) for (const q of r) reachR = Math.max(reachR, max + Math.hypot(q[0] - p[0], q[1] - p[1])); }
    const hits: { e: number; hit: ReturnType<typeof nearestOnLine>; hi?: ReturnType<typeof nearestOnLine>; tie: number }[] = [];
    for (const ei of this.edgesNear(p, reachR)) {
      const e = this.edges[ei];
      if (!this.allowed(e, mode) || id[e.a] < 0 || size[id[e.a]] < big) continue;
      const two = rings ? this.nearestToAsset(e.pts, rings) : null, hit = two ? two.lo : nearestOnLine(p, e.pts);
      if (hit.d < max) hits.push({ e: ei, hit, hi: two?.hi, tie: rings ? Math.hypot(hit.pt[0] - p[0], hit.pt[1] - p[1]) : 0 });
    }
    hits.sort((a, b) => a.hit.d - b.hit.d || a.tie - b.tie);
    // nothing in reach (open country): the nearest path farther out, joined the same way
    if (!hits.length) return fallback && max < 3000 ? this.joins(p, mode, k, 3000, fallback) : this.nearby(p, mode, k * 2, max, fallback);
    // Only paths about as near as the nearest one: reaching a farther one means crossing whatever lies
    // between in a straight line, so that extra distance costs double; it must never be cheaper than
    // walking round by the network (the old 64 m shortcut across a block to the next junction).
    const d0 = hits[0].hit.d, speed = WALK, best = new Map<number, Join>();
    // (around an asset the ground between its footprint and a path is usually its own forecourt, and its
    // sides face different streets, so paths up to 60 m out count, at walking cost)
    const slack = rings ? 60 : 30, over = rings ? 1 : 2;
    // A path on another, unconnected network farther out is never used instead: the export's separate
    // walking networks (areas reached only by highway) aren't joined by anything walkable, and in the game
    // nobody can walk between them either, so that walk is reported as impossible, not drawn straight across.
    const pick = hits.filter((h) => h.hit.d <= d0 + slack).slice(0, k);
    for (const { e: ei, hit: lo, hi } of pick) {
      const e = this.edges[ei], full = this.cost(e, mode);
      for (const toB of [false, true]) {
        const hit = toB && hi ? hi : lo, frac = e.len > 0 ? Math.min(1, hit.along / e.len) : 0;
        const node = toB ? e.b : e.a, extra = (over * (hit.d - d0)) / speed + full * (toB ? 1 - frac : frac);
        if ((best.get(node)?.extra ?? Infinity) > extra) best.set(node, { node, extra, part: this.partOf(e, hit, toB), snap: { e: ei, ...hit } });
      }
    }
    return [...best.values()];
  }
  /** Where the drawn route ends: the place itself, or for an asset the point of its footprint nearest the path. */
  private endPoint(p: XY, from: XY): XY {
    const rings = this.ends.get(p[0] + ',' + p[1]);
    if (!rings) return p;
    let best = { pt: p, d: Infinity };
    for (const r of rings) { const h = nearestOnLine(from, [...r, r[0]]); if (h.d < best.d) best = h; }
    return best.pt;
  }
  /** Walking-type searches start/end at an asset's nearest edge; driving keeps the clicked point. */
  private withEnds<T>(mode: Mode, pts: XY[], run: () => T): T {
    if (mode !== 'drive') for (const p of pts) { const r = this.assetAt(p); if (r) this.ends.set(p[0] + ',' + p[1], r); }
    try { return run(); } finally { this.ends.clear(); }
  }

  /** Road/track pieces of one hop with their speed limits, and the junction + turn between pieces. */
  private pieces(segs: CSeg[], mode: string, start?: { x: number; z: number }): Piece[] {
    const vType = modeParams(mode).vType;
    const out: Piece[] = [];
    let cur: XY | null = start ? [start.x, start.z] : null;
    let prevPts: XY[] | null = null;
    segs.forEach((s, k) => {
      let pts: XY[] = s.pts.map((p) => [p.x, p.z]);
      if (cur && Math.hypot(pts[pts.length - 1][0] - cur[0], pts[pts.length - 1][1] - cur[1]) < Math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1])) pts = pts.reverse();
      const st = this.city.segTypes.get(s.name);
      const lanes = (st?.lanes ?? []).filter((l) => hasVehicle(l.vType, vType) || (vType === 'Car' && hasVehicle(l.vType, 'Tram')));
      const limit = Math.max(0, ...lanes.map((l) => l.speed)) * 50;
      if (prevPts && out.length) {
        // junction between the previous piece and this one
        const shared = [s.sn, s.en].find((n) => n === segs[k - 1].sn || n === segs[k - 1].en);
        const idx = shared !== undefined ? this.nodeIdx.get(shared) : undefined;
        let turn = ((headRad(pts) - (headRad([...prevPts].reverse()) + Math.PI)) * 180) / Math.PI;
        turn = ((turn % 360) + 540) % 360 - 180;
        out[out.length - 1].junction = { degree: idx === undefined ? 2 : this.driveDegree(idx), turn };
      }
      out.push({ len: len(pts), limit, highway: !!st?.highway });
      prevPts = pts; cur = pts[pts.length - 1];
    });
    return out;
  }

  private allowed(e: Edge, mode: Mode): boolean {
    if (mode === 'drive') return e.acc.drive;
    if (mode === 'walk' || mode === 'transit') return e.acc.walk;
    return e.acc.bike || e.acc.bikeWalk;
  }
  private cost(e: Edge, mode: Mode): number {
    // cars rarely hold the posted limit in town (traffic, signals): 85% on ordinary streets, full speed on highways
    if (mode === 'drive') return e.len / (e.speed * (/^(motorway|motorway_link|trunk)$/.test(e.cls) ? 1 : 0.85)) + (e.cls === 'minor' || e.cls === 'service' ? 2 : 0);
    if (mode === 'bike') return e.acc.bike ? (e.len / BIKE) * (e.bike ? 0.8 : 1) : e.len / WALK; // push the bike on footpaths
    return e.len / WALK;
  }

  private comps = new Map<Mode, { id: Int32Array; size: number[] }>();
  /** Connected components per mode, so points never snap onto an isolated scrap of path. */
  private comp(mode: Mode) {
    const m = mode === 'transit' ? 'walk' : mode;
    let c = this.comps.get(m);
    if (c) return c;
    const id = new Int32Array(this.pos.length).fill(-1), size: number[] = [];
    for (let s = 0; s < this.pos.length; s++) {
      if (id[s] >= 0 || !this.adj[s].some((ei) => this.allowed(this.edges[ei], m))) continue;
      const k = size.length; let n = 0; const stack = [s]; id[s] = k;
      while (stack.length) {
        const u = stack.pop()!; n++;
        for (const ei of this.adj[u]) { const e = this.edges[ei]; if (!this.allowed(e, m)) continue; const v = e.a === u ? e.b : e.a; if (id[v] < 0) { id[v] = k; stack.push(v); } }
      }
      size.push(n);
    }
    c = { id, size };
    this.comps.set(m, c);
    return c;
  }

  /** Nearest graph node usable by a mode, on a network of real size. */
  nearest(p: XY, mode: Mode, max = 600): number {
    const { id, size } = this.comp(mode);
    const big = Math.min(40, Math.max(...size, 0));
    let best = -1, bd = max;
    for (let i = 0; i < this.pos.length; i++) {
      if (id[i] < 0 || size[id[i]] < big) continue;
      const d = Math.hypot(this.pos[i][0] - p[0], this.pos[i][1] - p[1]);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  route(from: XY, to: XY, mode: Mode, opts: { avoidTolls?: boolean } = {}): Route[] {
    return this.withEnds(mode, [from, to], () => {
      if (mode === 'transit') return this.transit(from, to);
      this.avoidTolls = mode === 'drive' && !!opts.avoidTolls;
      try { return this.roadRoutes(from, to, mode); } finally { this.avoidTolls = false; }
    });
  }

  private roadRoutes(from: XY, to: XY, mode: Mode): Route[] {
    const S = this.joins(from, mode), T = this.joins(to, mode);
    if (!S.length || !T.length) return [];
    const out: Route[] = [];
    const penalty = new Map<number, number>();
    // penalty method: re-search with already-used edges made more expensive, keeping only
    // candidates that are genuinely different (≤70% shared with every kept route) and not much slower
    for (let attempt = 0; attempt < 20 && out.length < 3; attempt++) {
      const found = mode === 'drive' ? this.driveRoute(from, to, penalty) : (() => { const p = this.dijkstra(S, T, mode, penalty); return p && { path: p, time: -1 }; })();
      if (!found) break;
      const path = found.path;
      const hits = 'sHit' in found && found.sHit && found.tHit ? { s: found.sHit, t: found.tHit } : null;
      let r: Route, access: { dist: number; time: number };
      if (hits) {
        // driving joined part-way along roads: its own trimmed pieces, time and access to the joined points
        const parts = this.driveParts(path, hits.s, hits.t);
        r = this.partsRoute(parts, mode, from, to);
        const dist = this.reach(from, parts[0].pts[0]) + this.reach(to, parts[parts.length - 1].pts.at(-1)!);
        access = { dist, time: dist / 3 };
        r.time = found.time + 30;
      } else {
        r = this.roadRoute(path, mode, from, to, S, T);
        access = this.accessCost(path, from, to, mode, S, T);
        if (found.time >= 0) r.time = this.driveTime(path) + 30;
      }
      r.time += access.time; r.dist += access.dist; // getting from the clicked point to the road and back off it
      if ('bent' in found && found.bent) this.flagAgainst(r, path);
      const used = new Set(path.map((p) => p.e));
      const overlap = out.some((o) => { const prev = (o as any)._edges as Set<number>; let sh = 0; for (const e of used) if (prev.has(e)) sh += this.edges[e].len; return sh / r.dist > 0.7; });
      if (!overlap && (!out.length || r.time <= out[0].time * 1.5)) { (r as any)._edges = used; out.push(r); }
      // a near-copy means the penalty is too weak to leave a fast road (e.g. an expressway): escalate faster
      for (const e of used) penalty.set(e, (penalty.get(e) ?? 1) * (overlap ? 1.8 : 1.3));
    }
    for (const r of out) delete (r as any)._edges;
    // both ends on one edge: walking straight along it beats going out to a junction and back
    if (mode !== 'drive') {
      let direct: Route | null = null;
      for (const a of S) for (const b of T) {
        if (!a.snap || !b.snap || a.snap.e !== b.snap.e || direct) continue;
        const piece = this.subLine(this.edges[a.snap.e], a.snap, b.snap);
        const r = this.partsRoute([{ ed: piece, pts: piece.pts }], mode, from, to);
        const acc = this.reach(from, piece.pts[0]) + this.reach(to, piece.pts[piece.pts.length - 1]);
        r.time += acc / WALK; r.dist += acc;
        direct = r;
      }
      if (direct && (!out.length || direct.time < out[0].time)) return [direct, ...out.filter((o) => o.time <= direct!.time * 1.5)].slice(0, 3);
    }
    return out;
  }

  /** Node Dijkstra from several start candidates to several target candidates (each with an access cost). */
  private dijkstra(starts: { node: number; extra: number }[] | number, targets: { node: number; extra: number }[] | number, mode: Mode, penalty: Map<number, number>) {
    const S = typeof starts === 'number' ? [{ node: starts, extra: 0 }] : starts;
    const T = new Map((typeof targets === 'number' ? [{ node: targets, extra: 0 }] : targets).map((x) => [x.node, x.extra]));
    const N = this.pos.length;
    const dist = new Float64Array(N).fill(Infinity), via = new Int32Array(N).fill(-1);
    const h = new Heap();
    for (const { node, extra } of S) if (extra < dist[node]) { dist[node] = extra; h.push(extra, node); }
    let t = -1, best = Infinity;
    for (let top = h.pop(); top; top = h.pop()) {
      const [d, u] = top;
      if (d > dist[u]) continue;
      if (d >= best) break;
      const te = T.get(u);
      if (te !== undefined && d + te < best) { best = d + te; t = u; }
      for (const ei of this.adj[u]) {
        const e = this.edges[ei];
        if (!this.allowed(e, mode)) continue;
        const v = e.a === u ? e.b : e.a;
        const nd = d + this.cost(e, mode) * (penalty.get(ei) ?? 1);
        if (nd < dist[v]) { dist[v] = nd; via[v] = ei; h.push(nd, v); }
      }
    }
    if (t < 0) return null;
    const path: { e: number; fwd: boolean }[] = [];
    for (let v = t; via[v] !== -1;) { const ei = via[v]; const e = this.edges[ei]; const fwd = e.b === v; path.push({ e: ei, fwd }); v = fwd ? e.a : e.b; }
    return Object.assign(path.reverse(), { end: t }); // `end`: the meeting node when start and end share one (empty path)
  }

  /** Distance/time between the chosen points and where the route joins and leaves the network. */
  private accessCost(path: { e: number; fwd: boolean }[], from: XY, to: XY, mode: Mode, S: Join[] = [], T: Join[] = []) {
    const [n0, n1] = this.pathEnds(path);
    if (n0 < 0) return { dist: 0, time: 0 };
    // to where the route meets the network: the point on the joined edge, else the node itself
    const a = S.find((x) => x.node === n0)?.part?.pts[0] ?? this.pos[n0], b = T.find((x) => x.node === n1)?.part?.pts[0] ?? this.pos[n1];
    const dist = this.reach(from, a) + this.reach(to, b);
    return { dist, time: dist / (mode === 'drive' ? 3 : WALK) };
  }
  /** First and last graph node of a path (the meeting node when it is empty), or -1. */
  private pathEnds(path: { e: number; fwd: boolean }[]): [number, number] {
    const end = (path as { end?: number }).end;
    if (!path.length) return end === undefined ? [-1, -1] : [end, end];
    const first = this.edges[path[0].e], last = this.edges[path[path.length - 1].e];
    return [path[0].fwd ? first.a : first.b, path[path.length - 1].fwd ? last.b : last.a];
  }
  /** The joined edge pieces at both ends of a path, oriented along the trip. */
  private joinParts(path: { e: number; fwd: boolean }[], S: Join[], T: Join[]) {
    const [n0, n1] = this.pathEnds(path);
    const s = S.find((x) => x.node === n0)?.part, t = T.find((x) => x.node === n1)?.part;
    const rev = (e: Edge): Edge => ({ ...e, pts: [...e.pts].reverse(), hA: e.hB, hB: e.hA });
    return { head: s && s.len > 0.5 ? [{ ed: s, pts: s.pts }] : [], tail: t && t.len > 0.5 ? [{ ed: rev(t), pts: [...t.pts].reverse() }] : [] };
  }

  // ------------------------------------------------------------ driving
  /** May a car drive this edge in this direction? Confident one-way rules are hard. */
  private relaxed = false; // last resort: confident one-ways become heavy penalties instead of bans
  /** Mark a last-resort route: where it drives against a likely one-way, with a warning step there. */
  private flagAgainst(r: Route, path: { e: number; fwd: boolean }[]) {
    const spots: { at: XY; road: string }[] = [];
    for (const { e: ei, fwd } of path) {
      const e = this.edges[ei];
      if (e.ow !== 0 && e.sure && (fwd ? 1 : -1) !== e.ow && !spots.some((x) => x.road === e.name && e.name)) spots.push({ at: toLngLat(...(fwd ? e.pts[0] : e.pts[e.pts.length - 1])), road: e.name });
    }
    if (!spots.length) return;
    r.againstLikelyOneWay = spots;
    const steps = r.legs[0].steps;
    for (const sp of [...spots].reverse()) {
      // after the step nearest to where it begins
      let k = 0, bd = Infinity;
      steps.forEach((st, i) => { const d = Math.hypot(st.at[0] - sp.at[0], st.at[1] - sp.at[1]); if (d < bd && st.maneuver !== 'arrive') { bd = d; k = i; } });
      steps.splice(k + 1, 0, { text: sp.road ? t('Drives against the likely one-way direction of {road} (not confirmed)', { road: sp.road }) : t('Drives against the likely one-way direction of this road (not confirmed)'), dist: 0, time: 0, at: sp.at, maneuver: 'warn' });
    }
  }
  /** Inferred one-ways are rules; the last-resort search may break a likely (keep-right) one, never a confirmed one. */
  private driveOk(e: Edge, fwd: boolean) { return this.allowed(e, 'drive') && !(e.ow !== 0 && e.sure && (fwd ? 1 : -1) !== e.ow && (!this.relaxed || e.confirmed)); }
  /** Time on the edge; against a likely-but-unproven one-way it is heavily penalised, never banned. */
  /** The fixed parts of driveCost (wrong-way penalty, 'Avoid tolls' gate hour): paid in full on any stretch of the edge. */
  private wrongWayFixed(e: Edge, fwd: boolean) { return (e.ow !== 0 && (fwd ? 1 : -1) !== e.ow ? (e.sure ? 600 : 90) : 0) + (this.avoidTolls && e.gate ? 3600 : 0); }
  private driveCost(e: Edge, fwd: boolean) {
    const base = this.cost(e, 'drive') + (this.avoidTolls && e.gate ? 3600 : 0); // 'Avoid tolls': an hour per gate, so only unavoidable tolls remain
    if (e.ow !== 0 && (fwd ? 1 : -1) !== e.ow) return e.sure ? base * 30 + 600 : base * 6 + 90; // `sure` only reachable when relaxed
    return base;
  }
  private degree = new Map<number, number>();
  private driveDegree(v: number) {
    let d = this.degree.get(v);
    if (d === undefined) { d = this.adj[v].filter((ei) => this.allowed(this.edges[ei], 'drive')).length; this.degree.set(v, d); }
    return d;
  }
  /** Seconds lost at a junction: waiting at crossroads, and turning (right < left < U-turn). */
  private turnCost(inE: Edge, inFwd: boolean, outE: Edge, outFwd: boolean, v: number) {
    const deg = this.driveDegree(v);
    const uturn = inE === outE;
    if (deg <= 2) return uturn ? (deg === 1 ? 25 : 600) : 0;
    const arrive = (inFwd ? inE.hB : inE.hA) + Math.PI, depart = outFwd ? outE.hA : outE.hB;
    let d = ((depart - arrive) * 180) / Math.PI;
    d = ((d % 360) + 540) % 360 - 180; // + = left (counter-clockwise)
    const ad = Math.abs(d);
    return 3 + (uturn || ad >= 150 ? 45 : ad < 30 ? 0 : d < 0 ? 4 : 10);
  }
  /** Dijkstra over directed edges, so turns and one-way rules can be charged at each junction. */
  /** Like Google: try the few nearest usable roads at each end, paying for the distance to reach them. */
  private driveRoute(from: XY, to: XY, penalty: Map<number, number>): { path: { e: number; fwd: boolean }[]; time: number; sHit?: DriveHit; tHit?: DriveHit; bent?: boolean } | null {
    // Join the nearest roads where they pass and follow them, one-ways and all, like Google: driving round
    // the block is the real way. Only if that finds no legal route (a point between motorway carriageways)
    // do the nearby junctions become options too, charged double for the straight distance beyond the road.
    const ends = (p: XY, roadsOnly: boolean): DriveHit[] => {
      const hits = this.driveHits(p), d0 = hits[0]?.d ?? Infinity;
      if (roadsOnly && hits.length) return hits; // (an end with no road in reach always uses junctions)
      // a junction as a point at the end of each road meeting there, so every way in and out is open
      const nodes = this.nearby(p, 'drive').flatMap(({ node }) => this.adj[node].filter((x) => this.allowed(this.edges[x], 'drive')).map((ei) => {
        const e = this.edges[ei], atA = e.a === node, d = this.reach(p, this.pos[node]);
        return { e: ei, pt: this.pos[node], d, along: atA ? 0 : e.len, i: atA ? 0 : Math.max(0, e.pts.length - 2), frac: atA ? 0 : 1, extra: 0 };
      }));
      const base = Math.min(d0, ...nodes.map((n) => n.d));
      return [...hits, ...nodes.map((n) => ({ ...n, extra: (2 * Math.max(0, n.d - base)) / 3 }))];
    };
    const SR = ends(from, true), TR = ends(to, true);
    const onRoads = SR.length && TR.length ? this.driveSearchOn(SR, TR, penalty) : null;
    const gated = (x: { path: { e: number }[] }) => x.path.some((q) => this.edges[q.e].gate);
    const SH = ends(from, false), TH = ends(to, false);
    if (onRoads) {
      // avoiding tolls: if the road joins only lead through a gate, a nearby junction may not
      if (this.avoidTolls && gated(onRoads)) { const alt = SH.length && TH.length ? this.driveSearchOn(SH, TH, penalty) : null; if (alt && !gated(alt)) return alt; }
      return onRoads;
    }
    if (!SH.length || !TH.length) return null;
    const r = this.driveSearchOn(SH, TH, penalty);
    if (r) return r;
    // no route obeys every inferred one-way: as a last resort a likely (keep-right) direction may be driven
    // against, heavily penalised and flagged; a direction confirmed by vehicles never is (then: no route)
    this.relaxed = true;
    try { const b = this.driveSearchOn(SH, TH, penalty); return b ? { ...b, bent: true } : null; } finally { this.relaxed = false; }
  }
  /**
   * The drivable roads a point can join: the nearest point on each of the few nearest roads a car may use
   * (lane access; big connected network only), as for walking: only roads nearly as close as the nearest,
   * the extra distance at double cost. Inside a multi-part asset, measured from its footprint. A trip can't
   * begin or end part-way along a motorway, ramp or highway (no access there), so those only count when no
   * other road is in reach.
   */
  private driveHits(p: XY, k = 4, max = 450): DriveHit[] {
    // nothing drivable in reach (a point in open country): the nearest road farther out, still a road
    // rather than a single junction that may sit on a motorway carriageway
    // order of preference: an ordinary road in reach; one farther out; only then a motorway/highway
    const near = this.driveHitsWithin(p, k, max, false);
    if (near.length) return near;
    const far = this.driveHitsWithin(p, k, 3000, false);
    return far.length ? far : this.driveHitsWithin(p, k, max, true);
  }
  private driveHitsWithin(p: XY, k: number, max: number, highways: boolean): DriveHit[] {
    const { id, size } = this.comp('drive');
    const big = Math.min(40, Math.max(...size, 0));
    const rings = this.ends.get(p[0] + ',' + p[1]);
    let reachR = max;
    if (rings) for (const r of rings) for (const q of r) reachR = Math.max(reachR, max + Math.hypot(q[0] - p[0], q[1] - p[1]));
    const hits: DriveHit[] = [];
    for (const ei of this.edgesNear(p, reachR)) {
      const e = this.edges[ei];
      if (!this.allowed(e, 'drive') || id[e.a] < 0 || size[id[e.a]] < big) continue;
      const hit = rings ? this.nearestToAsset(e.pts, rings).lo : nearestOnLine(p, e.pts);
      if (hit.d < max) hits.push({ e: ei, ...hit, frac: e.len > 0 ? Math.min(1, hit.along / e.len) : 0, extra: 0 });
    }
    hits.sort((a, b) => a.d - b.d);
    if (!highways) hits.splice(0, hits.length, ...hits.filter((h) => !HIGHWAY.has(this.edges[h.e].cls)));
    if (!hits.length) return [];
    const d0 = hits[0].d, slack = rings ? 60 : 30, over = rings ? 1 : 2;
    return hits.filter((h) => h.d <= d0 + slack).slice(0, rings ? 12 : k).map((h) => ({ ...h, extra: (over * (h.d - d0)) / 3 }));
  }
  /**
   * Directed-edge Dijkstra (turn costs, one-way rules) that starts and ends part-way along a road: from the
   * joined point a car may only head the ways the road allows (a confident one-way only forward), and it
   * arrives once it reaches the target point in an allowed direction.
   */
  private driveSearchOn(SH: DriveHit[], TH: DriveHit[], penalty: Map<number, number>) {
    const E = this.edges.length;
    const dist = new Float64Array(2 * E).fill(Infinity), prev = new Int32Array(2 * E).fill(-1), seedOf = new Int32Array(2 * E).fill(-1);
    const h = new Heap();
    const endNode = (st: number) => { const e = this.edges[st >> 1]; return st & 1 ? e.a : e.b; };
    const cost = (ei: number, fwd: boolean) => this.driveCost(this.edges[ei], fwd) * (penalty.get(ei) ?? 1);
    // part of an edge: its time scales with the distance, but a wrong-way penalty is paid in full however
    // short the stretch (else bending a one-way at the very start or end would look nearly free)
    const part = (ei: number, fwd: boolean, frac: number) => { const fixed = this.wrongWayFixed(this.edges[ei], fwd); return (cost(ei, fwd) - fixed) * frac + fixed; };
    const targets = new Map<number, DriveHit[]>();
    for (const t of TH) targets.set(t.e, [...(targets.get(t.e) ?? []), t]);
    let best = Infinity, goal: { st: number; from: number; t: DriveHit; s?: DriveHit } | null = null;
    // the part of an edge state's cost from its start to the target point
    const arrive = (st: number, t: DriveHit) => (st & 1 ? 1 - t.frac : t.frac);
    SH.forEach((s, si) => {
      const e = this.edges[s.e];
      for (const fwd of [true, false]) {
        if (!this.driveOk(e, fwd)) continue;
        const st = 2 * s.e + (fwd ? 0 : 1), c = s.extra + part(s.e, fwd, fwd ? 1 - s.frac : s.frac);
        if (c < dist[st]) { dist[st] = c; prev[st] = -1; seedOf[st] = si; h.push(c, st); }
        // the target further along the same road, in this direction
        for (const t of targets.get(s.e) ?? []) {
          if (fwd ? t.frac < s.frac : t.frac > s.frac) continue;
          const g = s.extra + t.extra + part(s.e, fwd, Math.abs(t.frac - s.frac));
          if (g < best) { best = g; goal = { st, from: -2, t, s }; }
        }
      }
    });
    for (let top = h.pop(); top; top = h.pop()) {
      const [d, st] = top;
      if (d > dist[st]) continue;
      if (d >= best) break;
      const v = endNode(st), inE = this.edges[st >> 1], inFwd = !(st & 1);
      for (const ei of this.adj[v]) {
        const e = this.edges[ei];
        for (const fwd of [true, false]) {
          if ((fwd ? e.a : e.b) !== v || !this.driveOk(e, fwd)) continue;
          const ns = 2 * ei + (fwd ? 0 : 1), turn = this.turnCost(inE, inFwd, e, fwd, v);
          for (const t of targets.get(ei) ?? []) {
            const g = d + turn + part(ei, fwd, arrive(ns, t)) + t.extra;
            if (g < best) { best = g; goal = { st: ns, from: st, t }; }
          }
          const nd = d + turn + cost(ei, fwd);
          if (nd < dist[ns]) { dist[ns] = nd; prev[ns] = st; seedOf[ns] = seedOf[st]; h.push(nd, ns); }
        }
      }
    }
    if (!goal) return null;
    const path: { e: number; fwd: boolean }[] = [];
    if (goal.from !== -2) for (let st = goal.from; st !== -1; st = prev[st]) path.push({ e: st >> 1, fwd: !(st & 1) });
    path.reverse();
    path.push({ e: goal.st >> 1, fwd: !(goal.st & 1) });
    const sHit = goal.s ?? SH[seedOf[goal.from]];
    return { path, time: this.driveTimeOn(path, sHit, goal.t), sHit, tHit: goal.t };
  }
  /** Travel time of a path that starts and ends part-way along its first and last roads. */
  private driveTimeOn(path: { e: number; fwd: boolean }[], s: DriveHit, t: DriveHit) {
    const avoid = this.avoidTolls; this.avoidTolls = false;
    try {
      const c = (p: { e: number; fwd: boolean }) => this.driveCost(this.edges[p.e], p.fwd);
      const first = path[0], last = path[path.length - 1];
      if (path.length === 1) return c(first) * Math.abs(t.frac - s.frac);
      const skipped = (1 - (first.fwd ? 1 - s.frac : s.frac)) * c(first) + (1 - (last.fwd ? t.frac : 1 - t.frac)) * c(last);
      return this.driveTimeRaw(path) - skipped;
    } finally { this.avoidTolls = avoid; }
  }
  /** Drawn pieces of a drive path joined part-way along its first and last roads. */
  private driveParts(path: { e: number; fwd: boolean }[], s: DriveHit, t: DriveHit): { ed: Edge; pts: XY[] }[] {
    const rev = (e: Edge): Edge => ({ ...e, pts: [...e.pts].reverse(), hA: e.hB, hB: e.hA });
    if (path.length === 1) { const p = this.subLine(this.edges[path[0].e], s, t); return [{ ed: p, pts: p.pts }]; }
    const out = path.map(({ e, fwd }) => { const ed = this.edges[e]; return { ed, pts: fwd ? ed.pts : [...ed.pts].reverse() }; });
    const a = this.partOf(this.edges[path[0].e], s, path[0].fwd);
    const last = path[path.length - 1], b = rev(this.partOf(this.edges[last.e], t, !last.fwd));
    out[0] = { ed: a, pts: a.pts }; out[out.length - 1] = { ed: b, pts: b.pts };
    const kept = out.filter((p, i) => p.ed.len > 0.5 || (i > 0 && i < out.length - 1));
    return kept.length ? kept : out;
  }
  /** The few nearest usable nodes for a mode, with the time it takes to reach the farther ones. */
  private nearby(p: XY, mode: Mode, k = 10, max = 450, fallback = true): { node: number; extra: number }[] {
    const { id, size } = this.comp(mode);
    const big = Math.min(40, Math.max(...size, 0));
    const c: { node: number; d: number }[] = [];
    for (let i = 0; i < this.pos.length; i++) {
      if (id[i] < 0 || size[id[i]] < big) continue;
      const d = this.reach(p, this.pos[i]);
      if (d < max) c.push({ node: i, d });
    }
    // inside an asset many nodes sit right at its edge: keep plenty, so every side is an option
    if (this.ends.has(p[0] + ',' + p[1])) { k = Math.max(k, 40); for (const x of c) x.d += Math.hypot(this.pos[x.node][0] - p[0], this.pos[x.node][1] - p[1]) * 1e-6; }
    c.sort((a, b) => a.d - b.d);
    if (!c.length) {
      if (!fallback) return [];
      // nothing within reach: the few nearest junctions within 3 km, not just one (a lone junction may be
      // on a motorway carriageway that can't be reached legally from here)
      for (let i = 0; i < this.pos.length; i++) {
        if (id[i] < 0 || size[id[i]] < big) continue;
        const d = this.reach(p, this.pos[i]);
        if (d < 3000) c.push({ node: i, d });
      }
      c.sort((a, b) => a.d - b.d);
      if (!c.length) return [];
    }
    const d0 = c[0].d, speed = mode === 'drive' ? 3 : WALK; // reaching a farther road: drive-up ~3 m/s, else on foot
    return c.slice(0, k).map((x) => ({ node: x.node, extra: (x.d - d0) / speed }));
  }
  private driveSearch(starts: { node: number; extra: number }[] | number, targets: { node: number; extra: number }[] | number, penalty: Map<number, number>) {
    const S = typeof starts === 'number' ? [{ node: starts, extra: 0 }] : starts;
    const T = new Map((typeof targets === 'number' ? [{ node: targets, extra: 0 }] : targets).map((x) => [x.node, x.extra]));
    const E = this.edges.length;
    const dist = new Float64Array(2 * E).fill(Infinity), prev = new Int32Array(2 * E).fill(-1);
    const h = new Heap();
    const endNode = (st: number) => { const e = this.edges[st >> 1]; return st & 1 ? e.a : e.b; };
    for (const { node: s, extra } of S) for (const ei of this.adj[s]) {
      const e = this.edges[ei];
      for (const fwd of [true, false]) {
        if ((fwd ? e.a : e.b) !== s || !this.driveOk(e, fwd)) continue;
        const st = 2 * ei + (fwd ? 0 : 1), c = extra + this.driveCost(e, fwd) * (penalty.get(ei) ?? 1);
        if (c < dist[st]) { dist[st] = c; h.push(c, st); }
      }
    }
    let goal = -1, best = Infinity;
    for (let top = h.pop(); top; top = h.pop()) {
      const [d, st] = top;
      if (d > dist[st]) continue;
      if (d >= best) break;
      const v = endNode(st);
      const te = T.get(v);
      if (te !== undefined && d + te < best) { best = d + te; goal = st; }
      const inE = this.edges[st >> 1], inFwd = !(st & 1);
      for (const ei of this.adj[v]) {
        const e = this.edges[ei];
        for (const fwd of [true, false]) {
          if ((fwd ? e.a : e.b) !== v || !this.driveOk(e, fwd)) continue;
          const ns = 2 * ei + (fwd ? 0 : 1);
          const nd = d + this.turnCost(inE, inFwd, e, fwd, v) + this.driveCost(e, fwd) * (penalty.get(ei) ?? 1);
          if (nd < dist[ns]) { dist[ns] = nd; prev[ns] = st; h.push(nd, ns); }
        }
      }
    }
    if (goal < 0) return null;
    const path: { e: number; fwd: boolean }[] = [];
    for (let st = goal; st !== -1; st = prev[st]) path.push({ e: st >> 1, fwd: !(st & 1) });
    path.reverse();
    return { path, time: this.driveTime(path) };
  }
  /** Travel time of a driving path including junction delays (without alternative-route penalties). */
  private driveTime(path: { e: number; fwd: boolean }[]) {
    const avoid = this.avoidTolls; this.avoidTolls = false; // report real travel time, not the avoidance penalty
    try { return this.driveTimeRaw(path); } finally { this.avoidTolls = avoid; }
  }
  private driveTimeRaw(path: { e: number; fwd: boolean }[]) {
    let t = 0;
    path.forEach((p, i) => {
      const e = this.edges[p.e];
      t += this.driveCost(e, p.fwd);
      if (i > 0) { const q = path[i - 1]; t += this.turnCost(this.edges[q.e], q.fwd, e, p.fwd, q.fwd ? this.edges[q.e].b : this.edges[q.e].a); }
    });
    return t;
  }

  private roadRoute(path: { e: number; fwd: boolean }[], mode: Mode, from: XY, to: XY, S: Join[] = [], T: Join[] = []): Route {
    const join = this.joinParts(path, S, T);
    const [n0] = this.pathEnds(path);
    return this.partsRoute([...join.head, ...path.map(({ e, fwd }) => { const ed = this.edges[e]; return { ed, pts: fwd ? ed.pts : [...ed.pts].reverse() }; }), ...join.tail], mode, from, to, n0 >= 0 ? this.pos[n0] : undefined);
  }
  /** A route from oriented edge pieces; `meet` is the junction both ends meet at when there are none. */
  private partsRoute(parts: { ed: Edge; pts: XY[] }[], mode: Mode, from: XY, to: XY, meet?: XY): Route {
    const first = parts[0]?.pts[0] ?? meet ?? from;
    const coords: XY[] = [this.endPoint(from, first)];
    if (!parts.length && meet) coords.push(meet);
    let dist = 0, time = 0;
    for (const p of parts) { dist += p.ed.len; time += this.cost(p.ed, mode); }
    for (const p of parts) coords.push(...p.pts);
    coords.push(this.endPoint(to, coords[coords.length - 1]));
    const kind = mode === 'drive' ? 'drive' : mode === 'bike' ? 'bike' : 'walk';
    const steps = turnSteps(parts, mode, (ed) => this.cost(ed, mode));
    // toll gates passed, in order, with a step at the point they are reached
    const tolls: TollPass[] = [];
    if (mode === 'drive') {
      let along = 0;
      const marks: { at: number; pass: TollPass; where: XY }[] = [];
      for (const p of parts) {
        if (p.ed.gate && tolls[tolls.length - 1]?.booth !== p.ed.gate) {
          const b = this.booths.get(p.ed.gate) ?? { name: '', unconfirmed: false, road: '' };
          // the player's name, else a generic label in the UI language (resolved now: the language can change)
          const pass = { booth: p.ed.gate, name: b.name || t(b.unconfirmed ? 'Toll lanes' : 'Toll booth'), road: b.road || p.ed.name };
          tolls.push(pass); marks.push({ at: along, pass, where: p.pts[0] });
        }
        along += p.ed.len;
      }
      for (const m of marks.reverse()) {
        let acc = 0, idx = steps.length - 1;
        for (let i = 0; i < steps.length; i++) { if (acc + steps[i].dist >= m.at) { idx = i + 1; break; } acc += steps[i].dist; }
        steps.splice(Math.min(idx, steps.length - 1), 0, { text: m.pass.road && m.pass.name !== m.pass.road ? t('Pass through the toll at {name} on {road}', { name: m.pass.name, road: m.pass.road }) : t('Pass through the toll at {name}', { name: m.pass.name }), dist: 0, time: 0, at: toLngLat(...m.where), maneuver: 'toll', booth: m.pass.booth });
      }
    }
    const named = new Map<string, number>();
    for (const p of parts) if (p.ed.name) named.set(p.ed.name, (named.get(p.ed.name) ?? 0) + p.ed.len);
    const via = [...named].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    return { mode, dist, time, via, legs: [{ kind, dist, time, coords: coords.map((p) => toLngLat(p[0], p[1])), steps }], ...(tolls.length ? { tolls } : {}), ...(tolls.length && this.avoidTolls ? { tollsUnavoidable: true } : {}) };
  }

  // ------------------------------------------------------------ transit
  /** Transit options like Google's: fastest, fewer transfers, less walking, and ones avoiding lines already offered. */
  private transit(from: XY, to: XY): Route[] {
    const found: Route[] = [];
    const sig = (r: Route) => r.legs.filter((l) => l.line).map((l) => l.line!.id).join('>');
    const add = (r: Route | null) => { if (r && !found.some((f) => sig(f) === sig(r))) found.push(r); };
    add(this.transitSearch(from, to));
    if (!found.length) return [];
    add(this.transitSearch(from, to, { transferPenalty: 600 }));   // fewer transfers
    add(this.transitSearch(from, to, { walkFactor: 2.5 }));        // less walking
    // avoid the lines of what is already offered, a few rounds
    const lineIdx = new Map(this.lines.map((l, i) => [l.id, i]));
    const avoid = new Map<number, number>();
    for (let round = 0; round < 4 && found.length < 6; round++) {
      for (const r of found) for (const l of r.legs) if (l.line) avoid.set(lineIdx.get(l.line.id)!, (avoid.get(lineIdx.get(l.line.id)!) ?? 0) + 900);
      const before = found.length;
      add(this.transitSearch(from, to, { linePenalty: avoid }));
      if (found.length === before) break;
    }
    const best = Math.min(...found.map((r) => r.time));
    return found.filter((r) => r.time <= Math.max(best * 1.7, best + 600) && r.time <= best + 1500).sort((a, b) => a.time - b.time).slice(0, 4);
  }

  /** One transit search; options bias it toward alternatives (avoid lines, fewer transfers, less walking). */
  private transitSearch(from: XY, to: XY, o: TransitOpts = {}): Route | null {
    const S = this.joins(from, 'walk'), TJ = this.joins(to, 'walk'), T = new Map(TJ.map((x) => [x.node, x.extra]));
    if (!S.length || !T.size) return null;
    const N = this.pos.length;
    // state ids: walk nodes [0,N); ride states N + offset(line) + stopIndex
    const offs: number[] = []; let total = N;
    for (const l of this.lines) { offs.push(total); total += l.stops.length; }
    const boardAt = new Map<number, { st: number; extra: number }[]>(); // walk node → ride states
    const alight: { node: number; extra: number }[][] = new Array(total - N);
    this.lines.forEach((l, li) => l.stops.forEach((sid, k) => {
      const ws = this.stopWalk.get(sid);
      if (!ws) return;
      const st = offs[li] + k;
      alight[st - N] = ws;
      for (const w of ws) { const arr = boardAt.get(w.node) ?? []; arr.push({ st, extra: w.extra }); boardAt.set(w.node, arr); }
    }));
    const lineOf = (st: number) => { let lo = 0, hi = offs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (offs[m] <= st) lo = m; else hi = m - 1; } return lo; };
    const dist = new Float64Array(total).fill(Infinity), prev = new Int32Array(total).fill(-1), prevEdge = new Int32Array(total).fill(-1);
    const h = new Heap();
    for (const { node, extra } of S) if (extra < dist[node]) { dist[node] = extra; h.push(extra, node); }
    const relax = (u: number, v: number, c: number, ei = -1) => { const nd = dist[u] + c; if (nd < dist[v]) { dist[v] = nd; prev[v] = u; prevEdge[v] = ei; h.push(nd, v); } };
    let t = -1, best = Infinity;
    for (let top = h.pop(); top; top = h.pop()) {
      const [d, u] = top;
      if (d > dist[u]) continue;
      if (d >= best) break;
      const te = u < N ? T.get(u) : undefined;
      if (te !== undefined && d + te < best) { best = d + te; t = u; }
      if (u < N) {
        for (const ei of this.adj[u]) { const e = this.edges[ei]; if (!this.allowed(e, 'walk')) continue; relax(u, e.a === u ? e.b : e.a, (e.len / WALK) * (o.walkFactor ?? 1), ei); }
        // waiting, plus a transfer penalty after the first ride so it doesn't hop lines for tiny gains
        const rode = (function f(v: number): boolean { for (let q = prev[v]; q !== -1; q = prev[q]) if (q >= N) return true; return false; })(u);
        for (const { st, extra } of boardAt.get(u) ?? []) { const li = lineOf(st); relax(u, st, extra + modeParams(this.lines[li].mode).wait + (rode ? o.transferPenalty ?? 150 : 0) + (o.linePenalty?.get(li) ?? 0)); }
      } else {
        const li = lineOf(u), l = this.lines[li], k = u - offs[li];
        const nk = (k + 1) % l.stops.length;
        relax(u, offs[li] + nk, l.hops[k].time + modeParams(l.mode).dwell);
        for (const w of alight[u - N] ?? []) relax(u, w.node, w.extra);
      }
    }
    if (t < 0) return null;
    const states: number[] = [];
    for (let v = t; v !== -1; v = prev[v]) states.unshift(v);
    if (!states.some((st) => st >= N)) return null; // walking is faster: walk mode covers that

    const legs: Leg[] = [];
    let i = 0;
    let walkStart: XY = from;
    const stopAt = (st: number) => { const li = lineOf(st); return this.lines[li].stops[st - offs[li]]; };
    const rev = (e: Edge): Edge => ({ ...e, pts: [...e.pts].reverse(), hA: e.hB, hB: e.hA });
    while (i < states.length) {
      if (states[i] < N) {
        // a walk: from the start or the stop just left, along the joined edge piece, the network, and the
        // joined piece into the next stop or the destination (never a straight line to a junction)
        const i0 = i;
        const startJoin = (i0 === 0 ? S : this.stopWalk.get(stopAt(states[i0 - 1])) ?? []).find((x) => x.node === states[i0])?.part;
        const parts: { ed: Edge; pts: XY[] }[] = startJoin && startJoin.len > 0.5 ? [{ ed: startJoin, pts: startJoin.pts }] : [];
        while (i + 1 < states.length && states[i + 1] < N) {
          const ei = prevEdge[states[i + 1]], ed = this.edges[ei];
          parts.push({ ed, pts: ed.a === states[i] ? ed.pts : [...ed.pts].reverse() });
          i++;
        }
        const last = i === states.length - 1;
        const endJoin = (last ? TJ : this.stopWalk.get(stopAt(states[i + 1])) ?? []).find((x) => x.node === states[i])?.part;
        if (endJoin && endJoin.len > 0.5) { const r = rev(endJoin); parts.push({ ed: r, pts: r.pts }); }
        const tip = parts.length ? parts[parts.length - 1].pts.at(-1)! : this.pos[states[i]];
        const end: XY = last ? this.endPoint(to, tip) : this.stopPos.get(stopAt(states[i + 1])) ?? tip;
        const coords = [i0 === 0 ? this.endPoint(from, parts[0]?.pts[0] ?? walkStart) : walkStart, ...parts.flatMap((p) => p.pts), end];
        const d = parts.reduce((a, p) => a + p.ed.len, 0);
        if (d > 5) legs.push({ kind: 'walk', dist: d, time: d / WALK, coords: coords.map((p) => toLngLat(p[0], p[1])), steps: turnSteps(parts, 'walk', (ed) => ed.len / WALK) });
        i++;
      } else {
        const li = lineOf(states[i]), l = this.lines[li];
        const k0 = states[i] - offs[li];
        const ridePts: XY[] = []; let rlen = 0, hops = 0; const hopTimes: number[] = [];
        let j = i;
        while (j + 1 < states.length && states[j + 1] >= N && lineOf(states[j + 1]) === li) {
          const k = states[j] - offs[li];
          ridePts.push(...l.hops[k].pts); rlen += l.hops[k].len; hopTimes.push(l.hops[k].time); hops++; j++;
        }
        const k1 = states[j] - offs[li];
        // boarding and alighting at the same stop is only a walk past the stop, not a ride
        if (!hops) { walkStart = this.stopPos.get(l.stops[k1]) ?? walkStart; i = j + 1; continue; }
        const nameOf = (k: number) => this.stopLabel(l.stops[k]);
        const names: string[] = [];
        const stopIds: number[] = [];
        for (let q = 0; q <= hops; q++) { names.push(nameOf((k0 + q) % l.stops.length)); stopIds.push(l.stops[(k0 + q) % l.stops.length]); }
        const wait = modeParams(l.mode).wait, ride = legRideTime(hopTimes, l.mode);
        legs.push({ kind: 'ride', dist: rlen, time: ride + wait, ride, wait, coords: ridePts.map((p) => toLngLat(p[0], p[1])), steps: [],
          line: { id: l.id, name: l.name, color: l.color, mode: l.mode }, from: nameOf(k0), to: nameOf(k1), stops: hops, stopNames: names, stopIds });
        walkStart = this.stopPos.get(l.stops[k1]) ?? walkStart;
        i = j + 1;
      }
    }
    if (!legs.some((l) => l.kind === 'ride')) return null;
    // a dropped non-ride leaves two walks back to back: join them
    for (let q = legs.length - 1; q > 0; q--) {
      const x = legs[q - 1], y = legs[q];
      if (x.kind === 'walk' && y.kind === 'walk') legs.splice(q - 1, 2, { kind: 'walk', dist: x.dist + y.dist, time: x.time + y.time, coords: [...x.coords, ...y.coords], steps: [...x.steps.filter((st) => st.maneuver !== 'arrive'), ...y.steps.filter((st) => st.maneuver !== 'depart')] });
    }
    // walking from the chosen points onto the street network
    const p0 = S.find((x) => x.node === states[0])?.part?.pts[0] ?? this.pos[states[0]];
    const p1 = TJ.find((x) => x.node === states[states.length - 1])?.part?.pts[0] ?? this.pos[states[states.length - 1]];
    const acc0 = this.reach(from, p0), acc1 = this.reach(to, p1);
    if (legs[0]?.kind === 'walk') { legs[0].dist += acc0; legs[0].time += acc0 / WALK; } else if (acc0 > 5) legs.unshift({ kind: 'walk', dist: acc0, time: acc0 / WALK, coords: [toLngLat(...this.endPoint(from, p0)), toLngLat(...p0)], steps: [] });
    const lastLeg = legs[legs.length - 1];
    if (lastLeg?.kind === 'walk') { lastLeg.dist += acc1; lastLeg.time += acc1 / WALK; } else if (acc1 > 5) legs.push({ kind: 'walk', dist: acc1, time: acc1 / WALK, coords: [toLngLat(...p1), toLngLat(...this.endPoint(to, p1))], steps: [] });
    const distSum = legs.reduce((a, l) => a + l.dist, 0);
    const timeSum = legs.reduce((a, l) => a + l.time, 0);
    return { mode: 'transit', dist: distSum, time: timeSum, via: legs.filter((l) => l.line).map((l) => l.line!.name).join(' → '), legs };
  }

  /** Node positions (game metres), indexed like the times from `reachTimes`. */
  nodePositions(): XY[] { return this.pos; }

  /**
   * Seconds from `from` to every network node by `mode`, up to `max` (Infinity beyond). Same costs as
   * Directions: driving obeys one-ways and pays for turns; transit includes the estimated wait at each
   * boarding but no transfer preference penalty, since this is about real time.
   */
  reachTimes(from: XY, mode: Mode, max: number): Float64Array {
    const N = this.pos.length;
    const out = new Float64Array(N).fill(Infinity);
    return this.withEnds(mode, [from], () => {
      const h = new Heap();
      if (mode === 'drive') {
        // edge-direction states, like driveSearch, so one-ways and turn costs apply
        const E = this.edges.length, dist = new Float64Array(2 * E).fill(Infinity);
        // a car can only stop (or set off) where an ordinary road meets the node, not on a motorway or ramp
        const stopOk = (v: number) => this.adj[v].some((ei) => this.allowed(this.edges[ei], 'drive') && !HIGHWAY.has(this.edges[ei].cls));
        const near = this.nearby(from, 'drive', 16), ordinary = near.filter((x) => stopOk(x.node));
        for (const { node: s } of (ordinary.length ? ordinary : near).slice(0, 8)) {
          const extra = Math.hypot(this.pos[s][0] - from[0], this.pos[s][1] - from[1]) / 3; // drive-up from the point
          if (extra < out[s]) out[s] = extra;
          for (const ei of this.adj[s]) {
            const e = this.edges[ei];
            for (const fwd of [true, false]) {
              if ((fwd ? e.a : e.b) !== s || !this.driveOk(e, fwd)) continue;
              const st = 2 * ei + (fwd ? 0 : 1), c = extra + this.driveCost(e, fwd);
              if (c < dist[st]) { dist[st] = c; h.push(c, st); }
            }
          }
        }
        for (let top = h.pop(); top; top = h.pop()) {
          const [d, st] = top;
          if (d > dist[st] || d > max) continue;
          const inE = this.edges[st >> 1], inFwd = !(st & 1), v = inFwd ? inE.b : inE.a;
          if (d < out[v]) out[v] = d;
          for (const ei of this.adj[v]) {
            const e = this.edges[ei];
            for (const fwd of [true, false]) {
              if ((fwd ? e.a : e.b) !== v || !this.driveOk(e, fwd)) continue;
              const ns = 2 * ei + (fwd ? 0 : 1), nd = d + this.turnCost(inE, inFwd, e, fwd, v) + this.driveCost(e, fwd);
              if (nd < dist[ns] && nd <= max) { dist[ns] = nd; h.push(nd, ns); }
            }
          }
        }
        for (let v = 0; v < N; v++) if (out[v] < Infinity && !stopOk(v)) out[v] = Infinity;
        return out;
      }
      // walking-type searches start where the point joins the path network, plus the walk to it
      const S = this.joins(from, mode === 'bike' ? 'bike' : 'walk');
      const d0 = Math.min(...S.map((j) => j.snap?.d ?? 0), Infinity);
      const access = Number.isFinite(d0) ? d0 / WALK : 0;
      if (mode !== 'transit') {
        for (const { node, extra } of S) if (extra + access < out[node]) { out[node] = extra + access; h.push(out[node], node); }
        for (let top = h.pop(); top; top = h.pop()) {
          const [d, u] = top;
          if (d > out[u]) continue;
          for (const ei of this.adj[u]) {
            const e = this.edges[ei];
            if (!this.allowed(e, mode)) continue;
            const v = e.a === u ? e.b : e.a, nd = d + this.cost(e, mode);
            if (nd < out[v] && nd <= max) { out[v] = nd; h.push(nd, v); }
          }
        }
        return out;
      }
      // transit: walk nodes [0, N) and ride states, as in transitSearch
      const offs: number[] = []; let total = N;
      for (const l of this.lines) { offs.push(total); total += l.stops.length; }
      const boardAt = new Map<number, { st: number; extra: number; li: number }[]>();
      const alight: Join[][] = new Array(total - N);
      this.lines.forEach((l, li) => l.stops.forEach((sid, k) => {
        const ws = this.stopWalk.get(sid);
        if (!ws) return;
        const st = offs[li] + k;
        alight[st - N] = ws;
        for (const w of ws) { const arr = boardAt.get(w.node) ?? []; arr.push({ st, extra: w.extra, li }); boardAt.set(w.node, arr); }
      }));
      const lineOf = (st: number) => { let lo = 0, hi = offs.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (offs[m] <= st) lo = m; else hi = m - 1; } return lo; };
      const dist = new Float64Array(total).fill(Infinity);
      const relax = (v: number, nd: number) => { if (nd < dist[v] && nd <= max) { dist[v] = nd; h.push(nd, v); } };
      for (const { node, extra } of S) relax(node, extra + access);
      for (let top = h.pop(); top; top = h.pop()) {
        const [d, u] = top;
        if (d > dist[u]) continue;
        if (u < N) {
          for (const ei of this.adj[u]) { const e = this.edges[ei]; if (this.allowed(e, 'walk')) relax(e.a === u ? e.b : e.a, d + e.len / WALK); }
          for (const { st, extra, li } of boardAt.get(u) ?? []) relax(st, d + extra + modeParams(this.lines[li].mode).wait);
        } else {
          const li = lineOf(u), l = this.lines[li], k = u - offs[li];
          relax(offs[li] + ((k + 1) % l.stops.length), d + l.hops[k].time + modeParams(l.mode).dwell);
          for (const w of alight[u - N] ?? []) relax(w.node, d + w.extra);
        }
      }
      out.set(dist.subarray(0, N));
      return out;
    });
  }

  /** The player's station name, or a description of where the stop is (never an invented name). */
  private stopLabel(sid: number): string {
    const n = this.stopNames.get(sid);
    if (n) return n;
    const p = this.stopPos.get(sid);
    if (!p) return 'Stop';
    let best = '', bd = 120;
    for (const e of this.edges) {
      if (!e.name) continue;
      const q = e.pts[e.pts.length >> 1];
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
      if (d < bd) { bd = d; best = e.name; }
    }
    return best ? t('Stop on {road}', { road: best }) : t('Unnamed stop');
  }
}

/** Cut a polyline so it starts at the point nearest `a` and ends at the point nearest `b` (after that start). */
function trimTo(pts: XY[], a?: { x: number; z: number }, b?: { x: number; z: number }): XY[] {
  if (pts.length < 2 || !a || !b) return pts;
  const proj = (p: { x: number; z: number }, from: number) => {
    let best = { d: Infinity, i: from, t: 0, q: pts[from] as XY };
    for (let i = from; i < pts.length - 1; i++) {
      const [x1, z1] = pts[i], [x2, z2] = pts[i + 1], dx = x2 - x1, dz = z2 - z1, l2 = dx * dx + dz * dz || 1e-9;
      const t = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.z - z1) * dz) / l2));
      const q: XY = [x1 + t * dx, z1 + t * dz], d = Math.hypot(q[0] - p.x, q[1] - p.z);
      if (d < best.d) best = { d, i, t, q };
    }
    return best;
  };
  // only trim within the first / last ~segment so a stop near a mid-route point can't cut the route short
  const s = proj(a, 0), e = proj(b, s.i);
  if (s.d > 80 || e.d > 80) return pts;
  const out: XY[] = [s.q, ...pts.slice(s.i + 1, e.i + 1), e.q];
  return out.length >= 2 ? out : pts;
}
/** Remove `cut` metres from the hop's pieces, from both ends. */
function trimPieces(pcs: Piece[], cut: number, rawLen: number, trimmed: XY[], a?: { x: number; z: number }) {
  if (cut <= 0 || !a) return;
  // stops sit near segment middles, so split the cut evenly between the two ends
  const startCut = Math.min(cut, Math.max(0, (rawLen - len(trimmed)) / 2));
  let head = startCut, tail = cut - startCut;
  for (const p of pcs) { const d = Math.min(head, p.len - 1); p.len -= d; head -= d; if (head <= 0) break; }
  for (let i = pcs.length - 1; i >= 0 && tail > 0; i--) { const d = Math.min(tail, pcs[i].len - 1); pcs[i].len -= d; tail -= d; }
}

/** Orient and join route segments into one polyline from node a to node b. */
function chain(segs: CSeg[], a?: { x: number; z: number }, b?: { x: number; z: number }): XY[] {
  const out: XY[] = [];
  let cur: XY | null = a ? [a.x, a.z] : null;
  for (const s of segs) {
    let pts: XY[] = s.pts.map((p) => [p.x, p.z]);
    if (cur) {
      const d0 = Math.hypot(pts[0][0] - cur[0], pts[0][1] - cur[1]), d1 = Math.hypot(pts[pts.length - 1][0] - cur[0], pts[pts.length - 1][1] - cur[1]);
      if (d1 < d0) pts = pts.reverse();
    }
    out.push(...(out.length ? pts.slice(1) : pts));
    cur = pts[pts.length - 1];
  }
  if (!out.length && a && b) return [[a.x, a.z], [b.x, b.z]];
  return out;
}

const headRad = (pts: XY[]) => { let i = 1; while (i < pts.length - 1 && Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) < 10) i++; return Math.atan2(pts[i][1] - pts[0][1], pts[i][0] - pts[0][0]); };

const COMPASS = ['east', 'northeast', 'north', 'northwest', 'west', 'southwest', 'south', 'southeast'];
// i18n-keys: sentences built from templates above (direction and side filled in)
const STEP_KEYS = [
  'Head east', 'Head northeast', 'Head north', 'Head northwest', 'Head west', 'Head southwest', 'Head south', 'Head southeast',
  'Head east on {road}', 'Head northeast on {road}', 'Head north on {road}', 'Head northwest on {road}', 'Head west on {road}', 'Head southwest on {road}', 'Head south on {road}', 'Head southeast on {road}',
  'Take the exit on the left', 'Take the exit on the right', 'Take the exit on the left toward {road}', 'Take the exit on the right toward {road}',
  'Take the ramp on the left', 'Take the ramp on the right', 'Take the ramp on the left to {road}', 'Take the ramp on the right to {road}',
  'Slight left', 'Slight right', 'Slight left onto {road}', 'Slight right onto {road}',
  'Turn left', 'Turn right', 'Turn left onto {road}', 'Turn right onto {road}', 'Turn left onto the path', 'Turn right onto the path',
  'Turn sharp left', 'Turn sharp right', 'Turn sharp left onto {road}', 'Turn sharp right onto {road}',
  'Merge onto the highway', 'Merge onto {road}', 'Continue straight', 'Continue', 'Continue onto {road}', 'Make a U-turn', 'Make a U-turn onto {road}',
];
// end i18n-keys
void STEP_KEYS;
const heading = (a: XY, b: XY) => Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI;
const tailHeading = (pts: XY[]) => { const n = pts.length; let i = n - 2; while (i > 0 && Math.hypot(pts[n - 1][0] - pts[i][0], pts[n - 1][1] - pts[i][1]) < 8) i--; return heading(pts[Math.max(0, i)], pts[n - 1]); };
const headHeading = (pts: XY[]) => { let i = 1; while (i < pts.length - 1 && Math.hypot(pts[i][0] - pts[0][0], pts[i][1] - pts[0][1]) < 8) i++; return heading(pts[0], pts[i]); };

/** Turn a list of oriented road parts into Google-style instructions. */
function turnSteps(parts: { ed: Edge; pts: XY[] }[], mode: Mode, cost: (e: Edge) => number): Step[] {
  if (!parts.length) return [{ text: t('Arrive at your destination'), dist: 0, time: 0, at: [0, 0], maneuver: 'arrive' }];
  const label = (e: Edge) => e.name || '';
  const kindOf = (e: Edge) => LABEL[e.cls] ?? 'road';
  const steps: Step[] = [];
  const h0 = headHeading(parts[0].pts);
  const dir = COMPASS[Math.round(((h0 + 360) % 360) / 45) % 8];
  let cur: Step = { text: label(parts[0].ed) ? t(`Head ${dir} on {road}`, { road: label(parts[0].ed) }) : t(`Head ${dir}`), dist: 0, time: 0, at: toLngLat(...parts[0].pts[0]), maneuver: 'depart', road: label(parts[0].ed) };
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (i > 0) {
      const prev = parts[i - 1];
      let d = headHeading(p.pts) - tailHeading(prev.pts);
      d = ((d + 540) % 360) - 180; // + = left (counter-clockwise)
      const nm = label(p.ed), pn = label(prev.ed);
      const sameRoad = nm === pn && (nm !== '' || kindOf(p.ed) === kindOf(prev.ed));
      const ad = Math.abs(d);
      const enteringRamp = p.ed.cls === 'motorway_link' && prev.ed.cls !== 'motorway_link';
      const merging = p.ed.cls === 'motorway' && prev.ed.cls === 'motorway_link';
      const exiting = p.ed.cls === 'motorway_link' && prev.ed.cls === 'motorway';
      const newStep = (sameRoad && ad < 35 && !enteringRamp && !merging && !exiting) ? null
        : ad < 20 && !nm && !enteringRamp && !merging && !exiting && cur.dist < 30 ? null
        : ad < 20 && !enteringRamp && !merging && !exiting && (nm === pn || !nm) ? null : true;
      if (newStep) {
        steps.push(cur);
        const side = d > 0 ? 'left' : 'right';
        // whole sentences per case, so each language can order the words its own way
        const say = (base: string, withRoad: string) => (nm ? t(withRoad, { road: nm }) : t(base));
        let text: string, man: string;
        if (exiting) { text = say(`Take the exit on the ${side}`, `Take the exit on the ${side} toward {road}`); man = 'exit-' + side; }
        else if (enteringRamp) { text = say(`Take the ramp on the ${side}`, `Take the ramp on the ${side} to {road}`); man = 'ramp-' + side; }
        else if (merging) { text = say('Merge onto the highway', 'Merge onto {road}'); man = 'merge'; }
        else if (ad < 20) { text = say(mode === 'drive' ? 'Continue straight' : 'Continue', 'Continue onto {road}'); man = 'straight'; }
        else if (ad < 50) { text = say(`Slight ${side}`, `Slight ${side} onto {road}`); man = 'slight-' + side; }
        else if (ad < 140) { text = !nm && mode !== 'drive' && p.ed.cls === 'footway' ? t(`Turn ${side} onto the path`) : say(`Turn ${side}`, `Turn ${side} onto {road}`); man = 'turn-' + side; }
        else { text = mode === 'drive' ? say('Make a U-turn', 'Make a U-turn onto {road}') : say(`Turn sharp ${side}`, `Turn sharp ${side} onto {road}`); man = 'uturn'; }
        cur = { text, dist: 0, time: 0, at: toLngLat(...p.pts[0]), maneuver: man, road: nm };
      }
    }
    cur.dist += p.ed.len; cur.time += cost(p.ed);
  }
  steps.push(cur);
  const last = parts[parts.length - 1].pts;
  steps.push({ text: t('Arrive at your destination'), dist: 0, time: 0, at: toLngLat(...last[last.length - 1]), maneuver: 'arrive' });
  return steps;
}
