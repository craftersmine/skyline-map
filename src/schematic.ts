// Schematic transit map layout (Seoul / London style), from the real network.
//
// 1. Topology: stations (stops grouped by station building, as on the map), the
//    track sections between consecutive stops with the lines that run on them,
//    and chains: runs of sections between "key" stations (termini, branches,
//    interchanges where the set of lines changes).
// 2. Octilinear routing: each chain is routed on a square grid whose moves are
//    the 8 compass directions, by A* with costs for length, bends, crossings and
//    distance from the real position. A line running through an interchange is
//    pulled straight. Chains go from the busiest outwards; each chain must be
//    long enough to give every intermediate station its own grid node, which is
//    what spaces stations evenly.
// 3. Compaction: empty grid rows/columns crossed only straight are removed.
// 4. Parallel lines on a shared section are ordered by where they come from and
//    go to (fewer crossings), then drawn as offset polylines.
// Pure: runs in the worker and in node (tools/schematic-check.ts).

export interface SchemInput {
  stations: { x: number; z: number; name: string }[];
  lines: { id: number; name: string; color: string; mode: string; stations: number[]; stopIds: number[] }[];
}
export type Pt = [number, number];
export type Marker =
  | { kind: 'dot'; x: number; y: number; color: string }
  | { kind: 'pill'; x1: number; y1: number; x2: number; y2: number }
  | { kind: 'ring'; x: number; y: number; r: number };
export interface SStation {
  id: number; name: string;
  /** grid position of the station (centre of its lines) */
  x: number; y: number;
  /** real position in game metres (x, z) */
  gx: number; gz: number;
  lines: number[]; transfer: boolean; key: boolean;
  marker: Marker;
  /** directions of the track at the station, in compass steps (0 = east, 2 = north), for label placement */
  dirs: number[];
}
export interface SHop { a: number; b: number; pts: Pt[] }
export interface SLine { id: number; name: string; color: string; mode: string; loop: boolean; route: number[]; hops: SHop[] }
export interface SchemLayout {
  w: number; h: number;
  /** walking transfers between distinct stations that are close on the ground */
  links: { a: number; b: number; m: number; pts?: Pt[] }[];
  /** total bends and drawn length (grid units), for scoring */
  bends: number; length: number;
  stations: SStation[]; lines: SLine[];
  /** stop node id → station id, to map journey-planner legs onto the diagram */
  stopStation: Record<number, number>;
  /** chains that could not be routed on the grid and were drawn straight */
  fallbacks: number;
  ms: number;
}
export const LINE_GAP = 0.13;

const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, -1, -1, -1, 0, 1, 1, 1];
const opp = (d: number) => (d + 4) & 7;
const turn = (a: number, b: number) => { const k = Math.abs(a - b) & 7; return k > 4 ? 8 - k : k; };
const BEND = [0, 1.4, 3.2, 9, Infinity];
const CROSS = 4, CROWD = 2.5;
/** layout knobs; schematic-render tries a few combinations and keeps the most readable result */
export interface LayoutParams {
  /** cost of a diagonal step (orthogonal = 1) */ diag: number;
  /** pull of a station towards its real position, per grid unit */ geo: number;
  /** cost of passing right next to another station (its name needs that room) */ near: number;
  /** pull of a station towards a nearby station it is close to on the ground, per grid unit */ pair: number;
}
export const DEFAULT_PARAMS: LayoutParams = { diag: 1.25, geo: 0.55, near: 1.1, pair: 2.5 };
/** distinct stations count as one place (kept side by side, linked as a walking transfer) when closer
 * than CLOSE_M, or than CLOSE_NAMED_M if their names share a base ("노리사역" / "노리사선착장") */
export const CLOSE_M = 120, CLOSE_NAMED_M = 260;
const SUFFIX = /\s*(역|정류장|정류소|선착장|터미널|station|stn\.?|terminal|pier|stop|halt)$/i;
const base = (n: string) => n.trim().replace(SUFFIX, '').replace(/^(도시철도|지하철|metro|subway|rail)\s+/i, '').toLowerCase();
/** do two station names name the same place? (one base contains the other, at least 2 letters) */
export function sameBase(a: string, b: string) {
  const x = base(a), y = base(b);
  return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x));
}
// a line bending inside an interchange (straight through costs nothing); capped so it never pays for a long detour
const THROUGH = [0, 1.5, 3, 4.5, 6];
const MODE_RANK: Record<string, number> = { train: 0, metro: 1, monorail: 2, tram: 3, ferry: 4, cablecar: 5, bus: 6 };

class Heap {
  k: number[] = []; v: number[] = [];
  get size() { return this.k.length; }
  push(key: number, val: number) {
    const { k, v } = this; let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop(): number {
    const { k, v } = this; const top = v[0]; const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk; v[0] = lv; let i = 0;
      for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < k.length && k[l] < k[m]) m = l; if (r < k.length && k[r] < k[m]) m = r; if (m === i) break; [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m; }
    }
    return top;
  }
  topKey() { return this.k[0]; }
}

interface Vtx { x: number; y: number; st: number }
interface Chain { stations: number[]; lines: number[]; vs: Vtx[]; order: number[]; /** a walking link between nearby stations, not a line */ walk?: boolean }

export function layoutSchematic(input: SchemInput, modes: string[], params: Partial<LayoutParams> = {}): SchemLayout {
  const t0 = Date.now();
  const P = { ...DEFAULT_PARAMS, ...params };
  const STEP = [1, P.diag], GEO = P.geo, NEAR = P.near;
  const want = new Set(modes);

  // ---------------------------------------------------------------- lines → routes
  const lines: SLine[] = [];
  for (const l of input.lines) {
    if (!want.has(l.mode)) continue;
    let seq = l.stations.filter((s, i, a) => i === 0 || s !== a[i - 1]);
    if (seq.length > 1 && seq[0] === seq[seq.length - 1]) seq = seq.slice(0, -1);
    if (new Set(seq).size < 2) continue;
    // game lines are cycles; a back-and-forth line reads as a palindrome around two turnarounds
    const n = seq.length;
    let route = [...seq, seq[0]], loop = true;
    if (n === 2) { route = seq; loop = false; }
    else if (n % 2 === 0) {
      for (let t = 0; t < n; t++) {
        let ok = true;
        for (let i = 1; i < n / 2 && ok; i++) ok = seq[(t - i + n) % n] === seq[(t + i) % n];
        if (ok) { const st = (t + n / 2) % n; route = Array.from({ length: n / 2 + 1 }, (_, i) => seq[(st + i) % n]); loop = false; break; }
      }
    }
    lines.push({ id: l.id, name: l.name, color: l.color, mode: l.mode, loop, route, hops: [] });
  }
  lines.sort((a, b) => (MODE_RANK[a.mode] ?? 9) - (MODE_RANK[b.mode] ?? 9) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  const rank = new Map(lines.map((l, i) => [l.id, i]));

  // ---------------------------------------------------------------- sections and chains
  const ek = (a: number, b: number) => (a < b ? a + ',' + b : b + ',' + a);
  const sect = new Map<string, Set<number>>();
  const adj = new Map<number, Set<number>>();
  const stLines = new Map<number, Set<number>>();
  for (const l of lines) for (let i = 0; i < l.route.length; i++) {
    const a = l.route[i];
    if (!stLines.has(a)) stLines.set(a, new Set());
    stLines.get(a)!.add(l.id);
    if (i === 0) continue;
    const p = l.route[i - 1];
    if (p === a) continue;
    const k = ek(p, a);
    if (!sect.has(k)) sect.set(k, new Set());
    sect.get(k)!.add(l.id);
    for (const [x, y] of [[p, a], [a, p]]) { if (!adj.has(x)) adj.set(x, new Set()); adj.get(x)!.add(y); }
  }
  const termini = new Set(lines.filter((l) => !l.loop).flatMap((l) => [l.route[0], l.route[l.route.length - 1]]));
  const sameSet = (a: Set<number>, b: Set<number>) => a.size === b.size && [...a].every((x) => b.has(x));
  const key = new Set<number>();
  for (const [s, nb] of adj) {
    const ns = [...nb];
    if (ns.length !== 2 || termini.has(s) || !sameSet(sect.get(ek(s, ns[0]))!, sect.get(ek(s, ns[1]))!)) key.add(s);
  }
  // stations close on the ground but not connected by a line: keep them together on the diagram
  const S0 = input.stations;
  const usedSt = [...adj.keys()];
  const pairs: { a: number; b: number; m: number }[] = [];
  for (let i = 0; i < usedSt.length; i++) for (let j = i + 1; j < usedSt.length; j++) {
    const a = usedSt[i], b = usedSt[j];
    const m = Math.hypot(S0[a].x - S0[b].x, S0[a].z - S0[b].z);
    const shareLine = [...(stLines.get(a) ?? [])].some((l) => stLines.get(b)?.has(l));
    const close = m < CLOSE_M || (m < CLOSE_NAMED_M && sameBase(S0[a].name, S0[b].name));
    if (close && !adj.get(a)!.has(b) && !shareLine) pairs.push({ a, b, m: Math.round(m) });
  }
  const partners = new Map<number, number[]>();
  for (const p of pairs) { key.add(p.a); key.add(p.b); partners.set(p.a, [...(partners.get(p.a) ?? []), p.b]); partners.set(p.b, [...(partners.get(p.b) ?? []), p.a]); }
  const extract = (): Chain[] => {
    const seen = new Set<string>(), out: Chain[] = [];
    for (const k of key) for (const n0 of adj.get(k) ?? []) {
      if (seen.has(ek(k, n0))) continue;
      const path = [k, n0]; seen.add(ek(k, n0));
      let prev = k, cur = n0;
      while (!key.has(cur)) {
        const next = [...adj.get(cur)!].find((x) => x !== prev)!;
        seen.add(ek(cur, next)); path.push(next); prev = cur; cur = next;
      }
      out.push({ stations: path, lines: [...sect.get(ek(path[0], path[1]))!], vs: [], order: [] });
    }
    // pure cycles (a circle line with no interchange): cut them at two stations
    const left = [...sect.keys()].filter((k) => !seen.has(k));
    if (left.length) { const [a] = left[0].split(',').map(Number); key.add(a); return extract(); }
    // a chain returning to its own start can't be routed as one path: split it
    const self = out.find((c) => c.stations[0] === c.stations[c.stations.length - 1]);
    if (self) { key.add(self.stations[Math.floor(self.stations.length / 2)]); return extract(); }
    return out;
  };
  let chains = extract();
  // parallel chains between the same two stations: split the longer so they route apart
  for (let guard = 0; guard < 50; guard++) {
    const seenPair = new Map<string, Chain>();
    const dup = chains.find((c) => { const k = ek(c.stations[0], c.stations[c.stations.length - 1]); if (seenPair.has(k)) return true; seenPair.set(k, c); return false; });
    if (!dup || dup.stations.length < 3) break;
    key.add(dup.stations[Math.floor(dup.stations.length / 2)]);
    chains = extract();
  }

  // each close pair becomes a one-step chain, routed first so the two land side by side
  for (const p of pairs) chains.push({ stations: [p.a, p.b], lines: [], vs: [], order: [], walk: true });

  // ---------------------------------------------------------------- grid
  const used = [...adj.keys()];
  if (!used.length) return { w: 4, h: 4, links: [], bends: 0, length: 0, stations: [], lines: [], stopStation: {}, fallbacks: 0, ms: Date.now() - t0 };
  const S = input.stations;
  const gx0 = Math.min(...used.map((s) => S[s].x)), gx1 = Math.max(...used.map((s) => S[s].x));
  const gy0 = Math.min(...used.map((s) => -S[s].z)), gy1 = Math.max(...used.map((s) => -S[s].z));
  const hops: number[] = [];
  for (const c of chains) for (let i = 1; i < c.stations.length; i++) { const a = S[c.stations[i - 1]], b = S[c.stations[i]]; hops.push(Math.hypot(a.x - b.x, a.z - b.z)); }
  hops.sort((a, b) => a - b);
  const median = hops[hops.length >> 1] || 500;
  const extent = Math.max(gx1 - gx0, gy1 - gy0, 1);
  // finer grid for bigger networks, so dense bus webs still find octilinear routes
  const cell = Math.max(median / 1.35, extent / Math.min(240, Math.max(110, used.length * 0.9)));
  const PAD = 8;
  const W = Math.ceil((gx1 - gx0) / cell) + 2 * PAD + 1, H = Math.ceil((gy1 - gy0) / cell) + 2 * PAD + 1;
  const N = W * H;
  const geo = (s: number): Pt => [(S[s].x - gx0) / cell + PAD, (-S[s].z - gy0) / cell + PAD];
  const nodeSt = new Int32Array(N).fill(-1);
  const near = new Uint8Array(N); // stations among the 8 neighbours
  const setStation = (nd: number, st: number) => { nodeSt[nd] = st; const [x, y] = xy(nd); for (let d = 0; d < 8; d++) { const xx = x + DX[d], yy = y + DY[d]; if (xx >= 0 && yy >= 0 && xx < W && yy < H) near[at(xx, yy)]++; } };
  const axes = new Uint8Array(N);
  const usedEdge = new Uint8Array(N * 8);
  const ports = new Map<number, Map<number, number[]>>(); // node → direction → lines leaving that way
  const placed = new Map<number, number>(); // station → node
  const at = (x: number, y: number) => y * W + x;
  const xy = (n: number): Pt => [n % W, (n / W) | 0];
  const xyV = (n: number) => ({ x: n % W, y: (n / W) | 0 });
  const cheb = (a: number, b: number) => { const [ax, ay] = xy(a), [bx, by] = xy(b); return Math.max(Math.abs(ax - bx), Math.abs(ay - by)); };
  const free = (n: number) => nodeSt[n] < 0 && axes[n] === 0 && ![0, 1, 2, 3, 4, 5, 6, 7].some((d) => usedEdge[n * 8 + d]);
  const crowd = (n: number) => { const [x, y] = xy(n); let k = 0; for (let d = 0; d < 8; d++) { const xx = x + DX[d], yy = y + DY[d]; if (xx >= 0 && yy >= 0 && xx < W && yy < H && nodeSt[at(xx, yy)] >= 0) k++; } return k; };
  function nearestFree([gx, gy]: Pt): number {
    for (let r = 0; r < Math.max(W, H); r++) {
      let best = -1, bd = Infinity;
      for (let y = Math.max(0, Math.round(gy) - r); y <= Math.min(H - 1, Math.round(gy) + r); y++) for (let x = Math.max(0, Math.round(gx) - r); x <= Math.min(W - 1, Math.round(gx) + r); x++) {
        const n = at(x, y), d = Math.hypot(x - gx, y - gy);
        if (free(n) && d < bd) { bd = d; best = n; }
      }
      if (best >= 0) return best;
    }
    return 0;
  }

  // ---------------------------------------------------------------- A* routing of one chain
  const dist = new Float64Array(N * 8).fill(Infinity);
  const prev = new Int32Array(N * 8).fill(-1);
  const touched: number[] = [];
  const linePen = (node: number, lns: number[], d: number, arriving: boolean) => {
    // a line that already leaves `node` one way should continue straight through it
    const pm = ports.get(node);
    if (!pm) return 0;
    let p = 0, k = 0;
    for (const [pd, ls] of pm) for (const l of lns) if (ls.includes(l) && k++ < 2) p += THROUGH[turn(arriving ? d : opp(d), pd)];
    // and different lines spread out rather than leaving side by side
    if (!arriving) for (const pd of pm.keys()) if (turn(d, pd) === 1) p += 0.8;
    return p;
  };
  let target = -1; // station being placed (for its partners' pull)
  const pairPull = (nd: number) => {
    let c = 0;
    for (const q of partners.get(target) ?? []) { const pn = placed.get(q); if (pn !== undefined) c += Math.max(0, cheb(nd, pn) - 1) * P.pair; }
    return c;
  };
  function route(from: number, n: number, lns: number[], fixed: number, g: Pt, R: number, minLen: number): number[] | null {
    for (const s of touched) { dist[s] = Infinity; prev[s] = -1; }
    touched.length = 0;
    const cand = new Map<number, number>();
    if (fixed < 0) {
      for (let y = Math.max(0, Math.floor(g[1] - R)); y <= Math.min(H - 1, Math.ceil(g[1] + R)); y++) for (let x = Math.max(0, Math.floor(g[0] - R)); x <= Math.min(W - 1, Math.ceil(g[0] + R)); x++) {
        const nd = at(x, y), d = Math.hypot(x - g[0], y - g[1]);
        if (d <= R + 0.01 && free(nd) && cheb(from, nd) >= minLen) cand.set(nd, d * GEO + crowd(nd) * CROWD + pairPull(nd));
      }
      if (!cand.size) return null;
    }
    const [fx, fy] = fixed >= 0 ? xy(fixed) : [0, 0];
    const h = (nd: number) => { const [x, y] = xy(nd); return fixed >= 0 ? Math.max(Math.abs(x - fx), Math.abs(y - fy)) : Math.max(0, Math.max(Math.abs(x - g[0]), Math.abs(y - g[1])) - R); };
    const heap = new Heap();
    let best = Infinity, bestS = -1, pops = 0;
    const relax = (fromS: number, nd: number, d: number, cost: number) => {
      const s = nd * 8 + d;
      if (fixed >= 0 && nd === fixed) {
        // the fixed end station: finish here, never drive through it
        const total = cost + linePen(nd, lns, d, true);
        if (total < best) { if (dist[s] === Infinity) touched.push(s); dist[s] = cost; prev[s] = fromS; best = total; bestS = s; }
        return;
      }
      if (nodeSt[nd] >= 0) return;
      if (cost >= dist[s]) return;
      if (dist[s] === Infinity) touched.push(s);
      dist[s] = cost; prev[s] = fromS; heap.push(cost + h(nd), s);
      // a free end may stop on any candidate node (and routes may also pass through them)
      if (fixed < 0 && cand.has(nd)) { const total = cost + cand.get(nd)!; if (total < best) { best = total; bestS = s; } }
    };
    const [sx, sy] = xy(from);
    for (let d = 0; d < 8; d++) {
      const x = sx + DX[d], y = sy + DY[d];
      if (x < 0 || y < 0 || x >= W || y >= H || usedEdge[from * 8 + d]) continue;
      const nd = at(x, y);
      if (axes[nd] && (axes[nd] & (1 << (d & 3)))) continue;
      relax(-1 - from, nd, d, STEP[d & 1] + linePen(from, lns, d, false) + (axes[nd] ? CROSS : 0) + Math.max(0, near[nd] - 1) * NEAR + crossDiag(sx, sy, d));
    }
    while (heap.size) {
      if (heap.topKey() >= best || ++pops > 600000) break;
      const s = heap.pop(), nd = (s / 8) | 0, din = s & 7, c = dist[s];
      if (fixed < 0 && cand.has(nd) && nodeSt[nd] < 0) { /* candidates may also be passed */ }
      const [x0, y0] = xy(nd);
      const through = axes[nd] !== 0; // crossing another chain: go straight
      for (let d = 0; d < 8; d++) {
        if (through && d !== din) continue;
        const tk = turn(din, d);
        if (tk > 3) continue;
        const x = x0 + DX[d], y = y0 + DY[d];
        if (x < 0 || y < 0 || x >= W || y >= H || usedEdge[nd * 8 + d]) continue;
        const n2 = at(x, y);
        if (axes[n2] && (axes[n2] & (1 << (d & 3)))) continue;
        if (axes[n2] && (fixed === n2 || cand.has(n2))) continue;
        relax(s, n2, d, c + STEP[d & 1] + BEND[tk] + (axes[n2] ? CROSS : 0) + near[n2] * NEAR + crossDiag(x0, y0, d));
      }
    }
    if (bestS < 0) return null;
    const out: number[] = [];
    for (let s = bestS; ; ) { out.push((s / 8) | 0); const p = prev[s]; if (p < 0) { out.push(-1 - p); break; } s = p; }
    return out.reverse();
  }
  // diagonals crossing mid-cell (an X) count as a crossing
  function crossDiag(x: number, y: number, d: number) {
    if (!(d & 1)) return 0;
    const ax = x + DX[d], ay = y;
    if (ax < 0 || ax >= W) return 0;
    const dd = DX[d] > 0 ? (DY[d] < 0 ? 3 : 5) : (DY[d] < 0 ? 1 : 7); // the other diagonal of the same cell, from (x+dx, y)
    return usedEdge[at(ax, ay) * 8 + dd] ? CROSS * 1.5 : 0;
  }

  function commit(c: Chain, path: number[] | null, fromSt: number, toSt: number) {
    const n = c.stations.length - 2;
    if (!path) {
      // fallback (no free route on the grid): an octilinear dogleg, a 45° leg then a straight one
      const a = placed.get(fromSt)!, b = placed.has(toSt) ? placed.get(toSt)! : nearestFree(c.walk ? xy(a) : geo(toSt));
      placed.set(toSt, b); setStation(b, toSt);
      const [ax, ay] = xy(a), [bx, by] = xy(b);
      const dx = bx - ax, dy = by - ay, dg = Math.min(Math.abs(dx), Math.abs(dy));
      const corner: Pt = [ax + Math.sign(dx) * dg, ay + Math.sign(dy) * dg];
      const poly: Pt[] = ([[ax, ay], corner, [bx, by]] as Pt[]).filter((p, i, arr) => i === 0 || p[0] !== arr[i - 1][0] || p[1] !== arr[i - 1][1]);
      const segL = poly.slice(1).map((p, i) => Math.hypot(p[0] - poly[i][0], p[1] - poly[i][1])), total = segL.reduce((x, y) => x + y, 0) || 1;
      const at = (t: number): Pt => { let d = t * total; for (let i = 0; i < segL.length; i++) { if (d <= segL[i] || i === segL.length - 1) { const f = segL[i] ? d / segL[i] : 0; return [poly[i][0] + (poly[i + 1][0] - poly[i][0]) * f, poly[i][1] + (poly[i + 1][1] - poly[i][1]) * f]; } d -= segL[i]; } return poly[poly.length - 1]; };
      const vs: Vtx[] = c.stations.map((st, i) => { const p = at(i / (n + 1)); return { x: p[0], y: p[1], st }; });
      // keep the corner as a vertex so the run stays octilinear
      if (poly.length === 3) { const tc = segL[0] / total; const k = vs.findIndex((_, i) => i / (n + 1) > tc); vs.splice(k < 0 ? vs.length - 1 : k, 0, { x: corner[0], y: corner[1], st: -1 }); }
      c.vs = vs;
      if (!c.walk) fallbacks++;
      return;
    }
    const m = path.length - 1;
    const pts = path.map(xy);
    const dirOf = (i: number) => { const dx = Math.sign(pts[i + 1][0] - pts[i][0]), dy = Math.sign(pts[i + 1][1] - pts[i][1]); return DX.findIndex((v, k) => v === dx && DY[k] === dy); };
    for (let i = 0; i < m; i++) { const d = dirOf(i); usedEdge[path[i] * 8 + d] = 1; usedEdge[path[i + 1] * 8 + opp(d)] = 1; }
    for (let i = 1; i < m; i++) { const a = dirOf(i - 1), b = dirOf(i); axes[path[i]] |= a === b ? 1 << (a & 3) : 15; }
    const addPort = (nd: number, d: number) => { if (!ports.has(nd)) ports.set(nd, new Map()); const pm = ports.get(nd)!; pm.set(d, [...(pm.get(d) ?? []), ...c.lines]); };
    addPort(path[0], dirOf(0)); addPort(path[m], opp(dirOf(m - 1)));
    placed.set(toSt, path[m]); setStation(path[m], toSt);
    // intermediate stations: evenly by length, each on its own node
    const cum = [0];
    for (let i = 0; i < m; i++) cum.push(cum[i] + Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]));
    const vs: Vtx[] = pts.map(([x, y]) => ({ x, y, st: -1 }));
    vs[0].st = fromSt; vs[m].st = toSt;
    if (m >= n + 1) {
      let last = 0;
      for (let j = 1; j <= n; j++) {
        const target = (cum[m] * j) / (n + 1);
        let bi = -1, bd = Infinity;
        for (let i = last + 1; i <= m - (n - j + 1); i++) { const dd = Math.abs(cum[i] - target) + (i > 0 && i < m && dirOf(i - 1) !== dirOf(i) ? 0.35 : 0); if (dd < bd) { bd = dd; bi = i; } }
        vs[bi].st = c.stations[j]; setStation(path[bi], c.stations[j]); placed.set(c.stations[j], path[bi]); last = bi;
      }
    } else {
      // not enough nodes: stations share the path at fractional positions
      fallbacks++;
      const extra: Vtx[] = [];
      for (let j = 1; j <= n; j++) {
        const target = (cum[m] * j) / (n + 1);
        let i = 0; while (i < m - 1 && cum[i + 1] < target) i++;
        const f = (target - cum[i]) / (cum[i + 1] - cum[i] || 1);
        extra.push({ x: pts[i][0] + (pts[i + 1][0] - pts[i][0]) * f, y: pts[i][1] + (pts[i + 1][1] - pts[i][1]) * f, st: c.stations[j], ...{ i } } as Vtx & { i: number });
      }
      const merged: Vtx[] = [];
      for (let i = 0; i <= m; i++) { merged.push(vs[i]); for (const e of extra as (Vtx & { i: number })[]) if (e.i === i) merged.push({ x: e.x, y: e.y, st: e.st }); }
      c.vs = merged;
      return;
    }
    c.vs = vs;
  }

  // ---------------------------------------------------------------- route all chains, busiest first, growing from placed stations
  let fallbacks = 0;
  const why: Record<string, number> = {};
  const note = (k: string) => { why[k] = (why[k] ?? 0) + 1; };
  const pending = new Set(chains);
  const weight = (c: Chain) => (c.walk ? 1 : c.lines.length * 100 + c.stations.length); // walking links last: lines decide the shape
  const stationWeight = (s: number) => (stLines.get(s)?.size ?? 0) * 10 + (adj.get(s)?.size ?? 0);
  while (pending.size) {
    let pick: Chain | null = null;
    for (const c of pending) if ((placed.has(c.stations[0]) || placed.has(c.stations[c.stations.length - 1])) && (!pick || weight(c) > weight(pick))) pick = c;
    if (!pick) {
      // start (or a new disconnected part): the busiest key station at its real position
      const ks = [...pending].flatMap((c) => [c.stations[0], c.stations[c.stations.length - 1]]);
      const s0 = ks.reduce((a, b) => (stationWeight(b) > stationWeight(a) ? b : a));
      const pp = (partners.get(s0) ?? []).map((q) => placed.get(q)).find((x) => x !== undefined);
      const nd = nearestFree(pp !== undefined ? xy(pp) : geo(s0)); placed.set(s0, nd); setStation(nd, s0);
      continue;
    }
    pending.delete(pick);
    if (!placed.has(pick.stations[0])) pick.stations.reverse();
    const a = pick.stations[0], b = pick.stations[pick.stations.length - 1], n = pick.stations.length - 2;
    const from = placed.get(a)!, fixed = placed.has(b) ? placed.get(b)! : -1;
    let path: number[] | null = null;
    target = b;
    if (pick.walk) {
      if (fixed >= 0) { pick.vs = [{ ...xyV(from), st: a }, { ...xyV(fixed), st: b }]; continue; } // both placed already: just link them
      // the partner goes on a neighbouring node, on the side it really is
      const [fx, fy] = xy(from), ga = geo(a), gb = geo(b), dx = gb[0] - ga[0], dy = gb[1] - ga[1], dl = Math.hypot(dx, dy) || 1;
      const p2 = route(from, 0, [], -1, [fx + (dx / dl) * 1.1, fy + (dy / dl) * 1.1], 1.6, 1) ?? route(from, 0, [], -1, [fx + (dx / dl) * 2, fy + (dy / dl) * 2], 3, 1);
      commit(pick, p2, a, b);
      continue;
    }
    // a station whose close partner is already drawn looks for its spot next to it
    const pn = (partners.get(b) ?? []).map((q) => placed.get(q)).find((x) => x !== undefined);
    const aim: Pt = pn !== undefined && fixed < 0 ? (() => { const g0 = geo(b), [px, py] = xy(pn); return [px * 0.75 + g0[0] * 0.25, py * 0.75 + g0[1] * 0.25] as Pt; })() : geo(b);
    for (const R of [3.5, 6, 10, 16]) { path = route(from, n, pick.lines, fixed, aim, R, n + 1); if (path || fixed >= 0) break; }
    if (!path && fixed < 0) path = route(from, n, pick.lines, -1, aim, 24, 1);
    if (!path) note(fixed >= 0 ? 'fixed-unreachable' : 'free-unreachable');
    if (path && fixed >= 0 && path.length - 1 > 4 * cheb(from, fixed) + 12) { path = null; note('detour'); }
    if (path && path.length - 1 < n + 1) note('too-short');
    commit(pick, path, a, b);
  }

  // ---------------------------------------------------------------- compaction: drop rows/columns crossed only straight
  const isInt = (v: number) => Math.abs(v - Math.round(v)) < 1e-6;
  for (const axis of [1, 0] as const) {
    const other = axis ? 0 : 1;
    const coords = new Set<number>();
    for (const c of chains) for (const v of c.vs) coords.add(Math.round(axis ? v.y : v.x));
    const lo = Math.min(...coords), hi = Math.max(...coords);
    for (let r = hi - 1; r > lo; r--) {
      let ok = true;
      for (const c of chains) {
        for (let i = 0; i < c.vs.length && ok; i++) {
          const v = c.vs[i], val = axis ? v.y : v.x;
          if (!isInt(val) && Math.abs(val - r) < 1) { ok = false; break; }
          if (Math.round(val) !== r || !isInt(val)) continue;
          // a vertex on this row must be a straight pass across it, not a station
          const p = c.vs[i - 1], q = c.vs[i + 1];
          if (v.st >= 0 || !p || !q) { ok = false; break; }
          const po = axis ? p.x : p.y, qo = axis ? q.x : q.y, vo = axis ? v.x : v.y;
          if (Math.abs(po - vo) > 1e-6 || Math.abs(qo - vo) > 1e-6) ok = false;
        }
        if (!ok) break;
        // a segment spanning the row diagonally (after earlier merges) blocks it too
        for (let i = 1; i < c.vs.length && ok; i++) {
          const p = c.vs[i - 1], q = c.vs[i], pa = axis ? p.y : p.x, qa = axis ? q.y : q.x;
          if (Math.min(pa, qa) < r && Math.max(pa, qa) > r && Math.abs((axis ? p.x : p.y) - (axis ? q.x : q.y)) > 1e-6) ok = false;
        }
      }
      if (!ok) continue;
      for (const c of chains) {
        c.vs = c.vs.filter((v) => !(isInt(axis ? v.y : v.x) && Math.round(axis ? v.y : v.x) === r));
        for (const v of c.vs) { if (axis) { if (v.y > r) v.y -= 1; } else if (v.x > r) v.x -= 1; }
      }
      void other;
    }
  }
  // normalise to start at (1.5, 1.5)
  const all = chains.flatMap((c) => c.vs);
  const mx = Math.min(...all.map((v) => v.x)), my = Math.min(...all.map((v) => v.y));
  for (const v of all) { v.x -= mx - 2; v.y -= my - 2; }
  const w = Math.max(...all.map((v) => v.x)) + 2, h = Math.max(...all.map((v) => v.y)) + 2;

  // ---------------------------------------------------------------- line order on shared chains
  const dirOfVec = (dx: number, dy: number) => { const a = Math.atan2(-dy, dx); return ((Math.round(a / (Math.PI / 4)) % 8) + 8) % 8; };
  const endDir = (c: Chain, atStart: boolean) => {
    const v = c.vs;
    if (atStart) { const i = v.findIndex((q, k) => k > 0 && (q.x !== v[0].x || q.y !== v[0].y)); return dirOfVec(v[i].x - v[0].x, v[i].y - v[0].y); }
    const L = v.length - 1; let i = L - 1; while (i > 0 && v[i].x === v[L].x && v[i].y === v[L].y) i--;
    return dirOfVec(v[L].x - v[i].x, v[L].y - v[i].y); // travel direction arriving at the end
  };
  const atStation = new Map<number, { c: Chain; start: boolean }[]>();
  for (const c of chains) for (const [s, start] of [[c.stations[0], true], [c.stations[c.stations.length - 1], false]] as const) {
    if (!atStation.has(s)) atStation.set(s, []);
    atStation.get(s)!.push({ c, start });
  }
  const side = (k: number) => (k >= 1 && k <= 3 ? k : k >= 5 && k <= 7 ? -(8 - k) : 0);
  for (const c of chains) {
    if (c.lines.length < 2) { c.order = c.lines; continue; }
    const dS = endDir(c, true), dE = endDir(c, false);
    const score = new Map<number, number>();
    for (const l of c.lines) {
      let sc = 0;
      for (const o of atStation.get(c.stations[0]) ?? []) {
        if (o.c === c || !o.c.lines.includes(l)) continue;
        const q = o.start ? endDir(o.c, true) : opp(endDir(o.c, false)); // direction the other branch leaves the station
        sc += side((q - dS + 8) % 8);
      }
      for (const o of atStation.get(c.stations[c.stations.length - 1]) ?? []) {
        if (o.c === c || !o.c.lines.includes(l)) continue;
        const q = o.start ? endDir(o.c, true) : opp(endDir(o.c, false));
        sc += side((q - dE + 8) % 8);
      }
      score.set(l, sc);
    }
    c.order = [...c.lines].sort((a, b) => score.get(b)! - score.get(a)! || rank.get(a)! - rank.get(b)!);
  }

  // ---------------------------------------------------------------- offset geometry per line
  function offsetPts(vs: Vtx[], o: number): Pt[] {
    if (!o) return vs.map((v) => [v.x, v.y]);
    const out: Pt[] = [];
    const nrm = (a: Vtx, b: Vtx): Pt | null => { const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy); return L < 1e-9 ? null : [dy / L, -dx / L]; };
    for (let i = 0; i < vs.length; i++) {
      let n1: Pt | null = null, n2: Pt | null = null;
      for (let k = i - 1; k >= 0 && !n1; k--) n1 = nrm(vs[k], vs[i]);
      for (let k = i + 1; k < vs.length && !n2; k++) n2 = nrm(vs[i], vs[k]);
      const a = n1 ?? n2!, b = n2 ?? n1!;
      let mx2 = a[0] + b[0], my2 = a[1] + b[1];
      const ml = Math.hypot(mx2, my2);
      if (ml < 1e-6) { mx2 = a[0]; my2 = a[1]; } else { mx2 /= ml; my2 /= ml; }
      const k = o / Math.max(0.35, mx2 * a[0] + my2 * a[1]);
      out.push([vs[i].x + mx2 * k, vs[i].y + my2 * k]);
    }
    return out;
  }
  const chainOf = new Map<string, { c: Chain; i: number; j: number }>();
  for (const c of chains) {
    const idx = c.stations.map((s) => c.vs.findIndex((v) => v.st === s));
    for (let k = 1; k < c.stations.length; k++) {
      chainOf.set(c.stations[k - 1] + '>' + c.stations[k], { c, i: idx[k - 1], j: idx[k] });
      chainOf.set(c.stations[k] + '>' + c.stations[k - 1], { c, i: idx[k], j: idx[k - 1] });
    }
  }
  const offCache = new Map<Chain, Map<number, Pt[]>>();
  const offsetFor = (c: Chain, l: number) => {
    if (!offCache.has(c)) offCache.set(c, new Map());
    const m = offCache.get(c)!;
    if (!m.has(l)) { const k = c.order.indexOf(l); m.set(l, offsetPts(c.vs, (((c.order.length - 1) / 2) - k) * LINE_GAP)); }
    return m.get(l)!;
  };
  const stationPts = new Map<number, { l: number; p: Pt }[]>();
  const stationDirs = new Map<number, Set<number>>();
  for (const l of lines) {
    for (let k = 1; k < l.route.length; k++) {
      const a = l.route[k - 1], b = l.route[k];
      const hop = chainOf.get(a + '>' + b);
      if (!hop) continue;
      const off = offsetFor(hop.c, l.id);
      const pts = hop.i <= hop.j ? off.slice(hop.i, hop.j + 1) : off.slice(hop.j, hop.i + 1).reverse();
      l.hops.push({ a, b, pts: pts.map(([x, y]) => [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000] as Pt) });
      for (const [s, p] of [[a, pts[0]], [b, pts[pts.length - 1]]] as const) {
        if (!stationPts.has(s)) stationPts.set(s, []);
        if (!stationPts.get(s)!.some((q) => q.l === l.id)) stationPts.get(s)!.push({ l: l.id, p });
      }
      const vs = hop.c.vs, ii = hop.i, jj = hop.j;
      const step = ii < jj ? 1 : -1;
      const d1 = dirOfVec(vs[ii + step].x - vs[ii].x, vs[ii + step].y - vs[ii].y), d2 = dirOfVec(vs[jj].x - vs[jj - step].x, vs[jj].y - vs[jj - step].y);
      if (!stationDirs.has(a)) stationDirs.set(a, new Set());
      if (!stationDirs.has(b)) stationDirs.set(b, new Set());
      stationDirs.get(a)!.add(d1 & 3); stationDirs.get(b)!.add(d2 & 3);
    }
  }

  // ---------------------------------------------------------------- stations and markers
  const lineById = new Map(lines.map((l) => [l.id, l]));
  const stations: SStation[] = [];
  for (const c of chains) for (const v of c.vs) {
    if (v.st < 0 || stations.some((s) => s.id === v.st)) continue;
    const pts = stationPts.get(v.st) ?? [];
    const ls = [...(stLines.get(v.st) ?? [])].sort((a, b) => rank.get(a)! - rank.get(b)!);
    const uniq: Pt[] = [];
    for (const q of pts) if (!uniq.some((u) => Math.hypot(u[0] - q.p[0], u[1] - q.p[1]) < 0.02)) uniq.push(q.p);
    let marker: Marker;
    if (ls.length <= 1 && uniq.length <= 1) marker = { kind: 'dot', x: uniq[0]?.[0] ?? v.x, y: uniq[0]?.[1] ?? v.y, color: lineById.get(ls[0])?.color ?? '#555' };
    else {
      // all on one straight cross-line → a pill across the bundle, else a ring around them
      let colinear = uniq.length >= 2;
      if (colinear) {
        const [a, b] = [uniq[0], uniq[uniq.length - 1]];
        let far: [Pt, Pt] = [a, b], fd = 0;
        for (const p of uniq) for (const q of uniq) { const d = Math.hypot(p[0] - q[0], p[1] - q[1]); if (d > fd) { fd = d; far = [p, q]; } }
        const [p, q] = far, dx = q[0] - p[0], dy = q[1] - p[1], L = Math.hypot(dx, dy) || 1;
        colinear = uniq.every((u) => Math.abs(((u[0] - p[0]) * dy - (u[1] - p[1]) * dx) / L) < 0.04) && (stationDirs.get(v.st)?.size ?? 1) === 1;
        if (colinear) marker = { kind: 'pill', x1: p[0], y1: p[1], x2: q[0], y2: q[1] };
      }
      if (!colinear) {
        const cx = uniq.length ? uniq.reduce((s, p) => s + p[0], 0) / uniq.length : v.x, cy = uniq.length ? uniq.reduce((s, p) => s + p[1], 0) / uniq.length : v.y;
        const r = Math.max(0, ...uniq.map((p) => Math.hypot(p[0] - cx, p[1] - cy)));
        marker = { kind: 'ring', x: cx, y: cy, r };
      }
    }
    const mk = marker!;
    const cx = mk.kind === 'pill' ? (mk.x1 + mk.x2) / 2 : mk.x, cy = mk.kind === 'pill' ? (mk.y1 + mk.y2) / 2 : mk.y;
    stations.push({ id: v.st, name: S[v.st].name, x: cx, y: cy, gx: S[v.st].x, gz: S[v.st].z, lines: ls, transfer: ls.length > 1, key: key.has(v.st), marker: mk, dirs: [...(stationDirs.get(v.st) ?? [])] });
  }
  const stopStation: Record<number, number> = {};
  for (const l of input.lines) if (want.has(l.mode)) l.stopIds.forEach((sid, i) => { if (l.stations[i] !== undefined) stopStation[sid] = l.stations[i]; });

  let bends = 0, length = 0;
  for (const c of chains) if (!c.walk) for (let i = 1; i < c.vs.length; i++) length += Math.hypot(c.vs[i].x - c.vs[i - 1].x, c.vs[i].y - c.vs[i - 1].y);
  for (const c of chains) for (let i = 1; i < c.vs.length - 1 && !c.walk; i++) {
    const a = c.vs[i - 1], b = c.vs[i], q = c.vs[i + 1];
    if (Math.abs((b.x - a.x) * (q.y - b.y) - (b.y - a.y) * (q.x - b.x)) > 1e-6) bends++;
  }
  const have = new Set(stations.map((s) => s.id));
  if (typeof process !== 'undefined' && process.env?.SCHEM_DEBUG) console.log('  fallback reasons', why);
  return { w, h, length, links: pairs.filter((p) => have.has(p.a) && have.has(p.b)).map((p) => ({ ...p, pts: chains.find((c) => c.walk && c.stations.includes(p.a) && c.stations.includes(p.b))?.vs.map((v) => [v.x, v.y] as Pt) })), bends, stations, lines: lines.filter((l) => l.hops.length), stopStation, fallbacks, ms: Date.now() - t0 };
}
